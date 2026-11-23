"""Durable background jobs for engine commands.

* A job row is persisted (``queued``) before any process is spawned.
* One active (queued or running) job per project; a global concurrency limit (default 1);
  extra jobs wait with an explicit ``queued`` status, FIFO.
* Every lifecycle transition and every output line is persisted as a ``job_events`` row
  whose integer id is the SSE event id, so clients can replay with ``Last-Event-ID``.
* Cancellation signals only the tracked process group: SIGINT (the engine handles it and
  exits 130), then SIGTERM, then SIGKILL after grace periods.
* On startup, jobs left ``queued``/``running`` by a previous backend become ``interrupted``.
  Success is never inferred from a dead PID.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import signal
import subprocess
import uuid
from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.db import Database, utcnow
from app.engine import commands
from app.engine.errors import classify, engine_error_line, redact
from app.engine.process import (
    FAST_STEPS,
    group_alive,
    signal_group,
    terminate_group,
    wait_exit,
)
from app.engine.runner import EngineCLI, EngineUnavailable
from app.errors import ApiError
from app.schemas import TERMINAL_STATUSES, JobDetail, JobEventOut, JobOut

log = logging.getLogger("ytagent_ui.jobs")

MAX_LOG_EVENTS = 5000
MAX_LINE = 8000
EVENT_PAGE = 1000
_ACTIVE = ("queued", "running")


SUCCESS_MESSAGES = {
    "draft": "Draft generation finished",
    "research-plan": "Claim inventory prepared",
    "research-collect": "Source collection finished",
    "research-add-url": "Source added",
}


@dataclass
class Event:
    id: int
    job_id: str
    type: str
    data: dict[str, Any]
    created_at: str

    def out(self) -> JobEventOut:
        return JobEventOut(id=self.id, type=self.type, data=self.data, created_at=self.created_at)


class JobManager:
    def __init__(
        self,
        db: Database,
        cli: EngineCLI,
        *,
        logs_dir: Path,
        max_concurrent: int = 1,
        cancel_grace: float = 10.0,
        on_finished=None,
    ) -> None:
        self.db = db
        self.cli = cli
        self.logs_dir = logs_dir
        self.max_concurrent = max_concurrent
        self.cancel_grace = cancel_grace
        self.on_finished = on_finished
        self._procs: dict[str, asyncio.subprocess.Process] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._terminators: dict[str, asyncio.Task] = {}
        self._subs: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self._wake = asyncio.Event()
        self._worker: asyncio.Task | None = None
        self._stopping = False
        # Projects held by a short engine mutation (e.g. draft-approve) outside the job queue.
        self._reserved: set[str] = set()

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self.reconcile()
        self._worker = asyncio.create_task(self._loop(), name="job-worker")
        self._wake.set()

    async def stop(self, timeout: float = 15.0) -> None:
        """Interrupt running engine processes and wait briefly for them to exit."""
        self._stopping = True
        if self._worker:
            self._worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker
        for job_id, proc in list(self._procs.items()):
            self._terminate(job_id, proc, grace=min(self.cancel_grace, 5.0))
        tasks = list(self._tasks.values())
        if tasks:
            await asyncio.wait(tasks, timeout=timeout)

    def reconcile(self) -> int:
        """Mark jobs orphaned by a previous backend run as interrupted."""
        rows = self.db.query(
            "SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at"
        )
        for row in rows:
            if row["status"] == "queued":
                msg = "The backend restarted before this job started. Start it again if needed."
            else:
                msg = "The backend restarted while this job was running; its outcome is unknown."
                if row["pid"] and _process_matches(row["pid"], row["process_started"]):
                    signal_group(row["pid"], signal.SIGINT)
                    msg = (
                        "The backend restarted while this job was running; the engine process "
                        "was interrupted. Run the draft again to let the engine recover."
                    )
            with self.db.tx() as c:
                c.execute(
                    "UPDATE jobs SET status='interrupted', finished_at=?, message=?, "
                    "error_code='interrupted' WHERE id=? AND status IN ('queued','running')",
                    (utcnow(), msg, row["id"]),
                )
            self._emit(
                row["id"],
                "completed",
                {"status": "interrupted", "message": msg, "exit_code": row["exit_code"]},
            )
        return len(rows)

    # ------------------------------------------------------------------ submit / query

    def submit(self, project_id: str, job_type: str, args: list[str], meta: dict) -> JobOut:
        commands.assert_allowlisted(args)
        if project_id in self._reserved:
            raise ApiError(
                409, "project_busy", "This project is being approved. Try again in a moment."
            )
        job_id = str(uuid.uuid4())
        now = utcnow()
        payload = json.dumps({"args": args, **meta})
        with self.db.tx() as c:
            active = c.execute(
                "SELECT id FROM jobs WHERE project_id=? AND status IN ('queued','running')",
                (project_id,),
            ).fetchone()
            if active:
                raise ApiError(
                    409,
                    "job_conflict",
                    "This project already has a queued or running job.",
                    {"job_id": active["id"]},
                )
            c.execute(
                "INSERT INTO jobs(id, project_id, job_type, status, command_args_json, "
                "created_at, message, log_path) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)",
                (
                    job_id,
                    project_id,
                    job_type,
                    payload,
                    now,
                    "Waiting to start",
                    str(self.logs_dir / f"{job_id}.log"),
                ),
            )
        self._emit(job_id, "status", {"status": "queued", "message": "Waiting to start"})
        self._wake.set()
        return self.get(job_id)

    @contextmanager
    def exclusive(self, project_id: str) -> Iterator[None]:
        """Hold a project for a short engine mutation: refused while a job is queued or
        running, and no job can be submitted until it is released. (The engine's own lock
        still guards against CLI runs outside the UI.)"""
        if project_id in self._reserved:
            raise ApiError(409, "project_busy", "Another action on this project is in progress.")
        active = self.active_for(project_id)
        if active:
            raise ApiError(
                409,
                "job_conflict",
                "A job is queued or running for this project. Wait for it to finish.",
                {"job_id": active.id},
            )
        self._reserved.add(project_id)
        try:
            yield
        finally:
            self._reserved.discard(project_id)

    def _row(self, job_id: str):
        try:
            uuid.UUID(job_id)
        except (ValueError, TypeError):
            raise ApiError(404, "job_not_found", "Unknown job.") from None
        row = self.db.query_one("SELECT * FROM jobs WHERE id=?", (job_id,))
        if row is None:
            raise ApiError(404, "job_not_found", "Unknown job.")
        return row

    def get(self, job_id: str) -> JobOut:
        return _job_out(self._row(job_id))

    def detail(self, job_id: str, limit: int = 200) -> JobDetail:
        job = self.get(job_id)
        rows = self.db.query(
            "SELECT * FROM (SELECT * FROM job_events WHERE job_id=? ORDER BY id DESC LIMIT ?) "
            "ORDER BY id",
            (job_id, limit + 1),
        )
        truncated = len(rows) > limit
        events = [_event(r).out() for r in rows[-limit:]]
        return JobDetail(**job.model_dump(), events=events, events_truncated=truncated)

    def list(self, *, project_id: str | None = None, limit: int = 20) -> list[JobOut]:
        if project_id:
            rows = self.db.query(
                "SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT ?",
                (project_id, limit),
            )
        else:
            rows = self.db.query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,))
        return [_job_out(r) for r in rows]

    def active_for(self, project_id: str) -> JobOut | None:
        row = self.db.query_one(
            "SELECT * FROM jobs WHERE project_id=? AND status IN ('queued','running') "
            "ORDER BY created_at DESC LIMIT 1",
            (project_id,),
        )
        return _job_out(row) if row else None

    def last_activity(self, project_id: str) -> str | None:
        row = self.db.query_one(
            "SELECT MAX(COALESCE(finished_at, started_at, created_at)) AS t FROM jobs "
            "WHERE project_id=?",
            (project_id,),
        )
        return row["t"] if row else None

    def events_after(self, job_id: str, after: int, limit: int = EVENT_PAGE) -> list[Event]:
        rows = self.db.query(
            "SELECT * FROM job_events WHERE job_id=? AND id>? ORDER BY id LIMIT ?",
            (job_id, after, limit),
        )
        return [_event(r) for r in rows]

    # ------------------------------------------------------------------ subscriptions

    def subscribe(self, job_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self._subs[job_id].add(q)
        return q

    def unsubscribe(self, job_id: str, q: asyncio.Queue) -> None:
        subs = self._subs.get(job_id)
        if subs is not None:
            subs.discard(q)
            if not subs:
                self._subs.pop(job_id, None)

    def _emit(self, job_id: str, event_type: str, data: dict[str, Any]) -> Event:
        now = utcnow()
        with self.db.tx() as c:
            cur = c.execute(
                "INSERT INTO job_events(job_id, event_type, payload_json, created_at) "
                "VALUES (?, ?, ?, ?)",
                (job_id, event_type, json.dumps(data, ensure_ascii=False), now),
            )
            ev = Event(int(cur.lastrowid), job_id, event_type, data, now)
        for q in list(self._subs.get(job_id, ())):
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                # Slow consumer: drop it; the SSE stream re-reads from the database.
                self.unsubscribe(job_id, q)
        return ev

    # ------------------------------------------------------------------ cancel

    async def cancel(self, job_id: str) -> JobOut:
        row = self._row(job_id)
        if row["status"] in TERMINAL_STATUSES:
            raise ApiError(409, "job_finished", f"The job has already {row['status']}.")
        if row["status"] == "queued":
            with self.db.tx() as c:
                cur = c.execute(
                    "UPDATE jobs SET status='cancelled', finished_at=?, cancel_requested=1, "
                    "message='Cancelled before it started' WHERE id=? AND status='queued'",
                    (utcnow(), job_id),
                )
                changed = cur.rowcount
            if changed:
                self._emit(
                    job_id,
                    "completed",
                    {
                        "status": "cancelled",
                        "exit_code": None,
                        "message": "Cancelled before it started",
                    },
                )
                return self.get(job_id)
            row = self._row(job_id)  # it started meanwhile; fall through
        if not row["cancel_requested"]:
            with self.db.tx() as c:
                c.execute("UPDATE jobs SET cancel_requested=1 WHERE id=?", (job_id,))
            self._emit(job_id, "cancel_requested", {"message": "Stopping the engine process…"})
        proc = self._procs.get(job_id)
        if proc is not None:
            self._terminate(job_id, proc, grace=self.cancel_grace)
        return self.get(job_id)

    def _terminate(self, job_id: str, proc: asyncio.subprocess.Process, *, grace: float) -> None:
        if job_id in self._terminators:
            return
        self._terminators[job_id] = asyncio.create_task(self._escalate(proc, grace))

    async def _escalate(self, proc: asyncio.subprocess.Process, grace: float) -> None:
        # Signal the whole process group (launcher and descendants) until it is empty.
        steps = ((signal.SIGINT, grace), (signal.SIGTERM, 5.0), (signal.SIGKILL, 5.0))
        await terminate_group(proc, steps)

    # ------------------------------------------------------------------ worker

    async def _loop(self) -> None:
        while not self._stopping:
            await self._wake.wait()
            self._wake.clear()
            while len(self._tasks) < self.max_concurrent and not self._stopping:
                row = self._claim_next()
                if row is None:
                    break
                task = asyncio.create_task(self._run(row), name=f"job-{row['id']}")
                self._tasks[row["id"]] = task
                task.add_done_callback(lambda _t, jid=row["id"]: self._done(jid))

    def _done(self, job_id: str) -> None:
        self._tasks.pop(job_id, None)
        self._procs.pop(job_id, None)
        self._terminators.pop(job_id, None)
        self._wake.set()

    def _claim_next(self):
        with self.db.tx() as c:
            row = c.execute(
                "SELECT * FROM jobs WHERE status='queued' AND project_id NOT IN "
                "(SELECT project_id FROM jobs WHERE status='running') "
                "ORDER BY created_at LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            c.execute(
                "UPDATE jobs SET status='running', started_at=?, message=? WHERE id=?",
                (utcnow(), "Starting the engine", row["id"]),
            )
        self._emit(row["id"], "status", {"status": "running", "message": "Starting the engine"})
        return self.db.query_one("SELECT * FROM jobs WHERE id=?", (row["id"],))

    async def _run(self, row) -> None:
        job_id = row["id"]
        args = json.loads(row["command_args_json"])["args"]
        log_path = Path(row["log_path"])
        try:
            proc = await self.cli.spawn(args)
        except (EngineUnavailable, commands.ArgumentError) as exc:
            self._finish(
                job_id,
                "failed",
                None,
                "The engine could not be started.",
                redact(str(exc)),
                "engine_unavailable",
            )
            return
        self._procs[job_id] = proc
        started = await _process_start(proc.pid)
        with self.db.tx() as c:
            c.execute(
                "UPDATE jobs SET pid=?, process_started=?, message=? WHERE id=?",
                (proc.pid, started, "Engine running", job_id),
            )
        self._emit(
            job_id, "status", {"status": "running", "message": "Engine running", "pid": proc.pid}
        )
        if self._row(job_id)["cancel_requested"]:
            self._terminate(job_id, proc, grace=self.cancel_grace)

        counter = {"n": 0, "truncated": False}
        stderr_tail: list[str] = []
        with open(log_path, "a", encoding="utf-8") as logf:
            pumps = asyncio.gather(
                self._pump(job_id, proc.stdout, "stdout", logf, counter, None),
                self._pump(job_id, proc.stderr, "stderr", logf, counter, stderr_tail),
            )
            rc = await wait_exit(proc)
            # The launcher has exited. A descendant that is still alive could hold the output
            # pipes open (and keep writing engine files): make sure the whole group is gone.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(asyncio.shield(pumps), timeout=2.0)
            terminator = self._terminators.get(job_id)
            if terminator is not None:
                await terminator
            if group_alive(proc.pid):
                logf.write(f"{utcnow()} [ui] stopping engine processes left after exit\n")
                await terminate_group(proc, FAST_STEPS)
            await pumps
            logf.write(f"{utcnow()} [exit] {rc}\n")

        cancel_requested = bool(self._row(job_id)["cancel_requested"])
        cls = classify(rc)
        engine_msg = engine_error_line("\n".join(stderr_tail))
        if rc == 0:
            message = SUCCESS_MESSAGES.get(row["job_type"], "Finished")
            status, err, code = "succeeded", None, None
        elif cancel_requested:
            status, message, err, code = "cancelled", "Cancelled by user", None, "cancelled"
        elif cls.expected_gate:
            status, message, err, code = "succeeded", cls.summary, engine_msg, cls.code
        elif rc == 130 or rc < 0:
            status = "interrupted"
            message = "The engine process was interrupted"
            if self._stopping:
                message = "Interrupted because the backend stopped"
            err, code = engine_msg, "interrupted"
        else:
            status, message, err, code = "failed", cls.summary, engine_msg, cls.code
        self._finish(job_id, status, rc, message, err, code)

    async def _pump(self, job_id, stream, name, logf, counter, tail) -> None:
        while True:
            try:
                raw = await stream.readline()
            except ValueError:
                raw = b"[output line too long; truncated]\n"
            if not raw:
                return
            text = redact(raw.decode("utf-8", "replace").rstrip("\r\n"), limit=MAX_LINE)
            ts = utcnow()
            logf.write(f"{ts} [{name}] {text}\n")
            logf.flush()
            if tail is not None:
                tail.append(text)
                del tail[:-50]
            counter["n"] += 1
            if counter["n"] <= MAX_LOG_EVENTS:
                self._emit(
                    job_id,
                    "log",
                    {"sequence": counter["n"], "stream": name, "message": text, "ts": ts},
                )
            elif not counter["truncated"]:
                counter["truncated"] = True
                self._emit(
                    job_id,
                    "log_truncated",
                    {"message": f"More than {MAX_LOG_EVENTS} lines; see the log file."},
                )

    def _finish(self, job_id, status, rc, message, err, code) -> None:
        with self.db.tx() as c:
            c.execute(
                "UPDATE jobs SET status=?, exit_code=?, finished_at=?, message=?, "
                "error_message=?, error_code=? WHERE id=?",
                (status, rc, utcnow(), message, err, code, job_id),
            )
        self._emit(
            job_id,
            "completed",
            {
                "status": status,
                "exit_code": rc,
                "message": message,
                "error_message": err,
                "error_code": code,
            },
        )
        if self.on_finished:
            try:
                self.on_finished(self._row(job_id)["project_id"])
            except Exception:  # pragma: no cover - callbacks must not break the worker
                log.exception("on_finished callback failed")


# ---------------------------------------------------------------------- helpers


def _job_out(row) -> JobOut:
    meta = json.loads(row["command_args_json"] or "{}")
    return JobOut(
        id=row["id"],
        project_id=row["project_id"],
        type=row["job_type"],
        status=row["status"],
        created_at=row["created_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        exit_code=row["exit_code"],
        message=row["message"],
        error_message=row["error_message"],
        error_code=row["error_code"],
        cancel_requested=bool(row["cancel_requested"]),
        provider=meta.get("provider"),
        model=meta.get("model"),
        from_stage=meta.get("from_stage"),
    )


def _event(row) -> Event:
    return Event(
        int(row["id"]),
        row["job_id"],
        row["event_type"],
        json.loads(row["payload_json"]),
        row["created_at"],
    )


_PS = "/bin/ps"


def _ps_identity(pid: int) -> str | None:
    try:
        out = subprocess.run(
            [_PS, "-o", "pgid=,lstart=", "-p", str(int(pid))],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    line = out.stdout.strip()
    if not line:
        return None
    pgid, _, start = line.partition(" ")
    if pgid.strip() != str(pid):  # we only ever track process-group leaders
        return None
    return " ".join(start.split())


async def _process_start(pid: int) -> str | None:
    return await asyncio.to_thread(_ps_identity, pid)


def _process_matches(pid: int, recorded: str | None) -> bool:
    """Guard against PID reuse: same pid, still a group leader, same start time."""
    if not recorded:
        return False
    return _ps_identity(pid) == recorded
