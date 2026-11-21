"""Regression tests: engine timeouts and cancellation stop the *whole* process group.

Review finding P1 (docs/reviews/pr-1-chatgpt-review.md): a timeout used to kill only the
``uv`` launcher, so a descendant could survive and keep writing engine artifacts.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import pytest

from app.engine.process import group_alive, terminate_group
from app.engine.runner import EngineCLI
from tests.conftest import PROJECT, wait_for

TREE = Path(__file__).resolve().parents[1] / "spawn_tree.py"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie still "exists"; treat it as dead if ps reports state Z.
    import subprocess

    out = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return bool(out.stdout.strip()) and not out.stdout.strip().startswith("Z")


def _cli(tmp: Path, mode: str) -> EngineCLI:
    env = {"PATH": "/usr/bin:/bin", "TREE_DIR": str(tmp), "TREE_MODE": mode}
    return EngineCLI([sys.executable, str(TREE)], tmp, env)


def _pid(tmp: Path, name: str) -> int:
    p = tmp / name
    wait_for(p.exists, timeout=5)
    return int(p.read_text())


@pytest.mark.parametrize("mode", ["wait", "orphan", "ignore"])
async def test_timeout_kills_launcher_and_descendants(tmp_path: Path, mode: str):
    cli = _cli(tmp_path, mode)
    t0 = time.monotonic()
    res = await cli.run(["--version"], timeout=0.5)
    returned = time.time()
    assert res.timed_out and not res.ok
    assert time.monotonic() - t0 < 10
    launcher, child = _pid(tmp_path, "launcher.pid"), _pid(tmp_path, "child.pid")
    assert not _alive(launcher)
    assert not _alive(child), "descendant survived the timeout"
    assert not group_alive(launcher)
    # No delayed writes after the API reported the timeout. (A write during the termination
    # grace period, i.e. before run() returned, is not "delayed".)
    await asyncio.sleep(2.0)
    late = tmp_path / "late-write"
    assert not late.exists() or late.stat().st_mtime <= returned


async def test_cancelled_caller_does_not_leak_group(tmp_path: Path):
    cli = _cli(tmp_path, "wait")
    task = asyncio.create_task(cli.run(["--version"], timeout=30))
    await asyncio.to_thread(wait_for, (tmp_path / "child.pid").exists, 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not _alive(_pid(tmp_path, "child.pid"))
    await asyncio.sleep(2.0)
    assert not (tmp_path / "late-write").exists()


async def test_terminate_group_waits_for_group_not_just_launcher(tmp_path: Path):
    env = {"PATH": "/usr/bin:/bin", "TREE_DIR": str(tmp_path), "TREE_MODE": "orphan"}
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        str(TREE),
        env=env,
        start_new_session=True,
        stdout=asyncio.subprocess.DEVNULL,
    )
    assert await proc.wait() == 0  # launcher gone, child still running in the group
    child = await asyncio.to_thread(_pid, tmp_path, "child.pid")
    assert group_alive(proc.pid) and _alive(child)
    assert await terminate_group(proc)
    assert not group_alive(proc.pid) and not _alive(child)


# ------------------------------------------------------------------ background jobs


def _job(client, job_id):
    return client.get(f"/api/v1/jobs/{job_id}").json()


def _terminal(client, job_id):
    j = _job(client, job_id)
    return j if j["status"] in ("succeeded", "failed", "cancelled", "interrupted") else None


def _start(client):
    assert client.post("/api/v1/projects", json=PROJECT).status_code == 201
    r = client.post("/api/v1/projects/hcm-demo/draft-jobs", json={"provider": "fixture"})
    assert r.status_code == 202, r.text
    return r.json()["job_id"]


def test_cancel_stops_descendants_that_ignore_sigint(client, fake_cli, tmp_root):
    """Launcher exits on SIGINT but its child ignores SIGINT/SIGTERM and holds the pipes."""
    fake_cli.env["FAKE_MODE"] = "tree_ignore"
    fake_cli.env["TREE_DIR"] = str(tmp_root)
    job_id = _start(client)
    child = _pid(tmp_root, "child.pid")
    wait_for(lambda: any(e["type"] == "log" for e in _job(client, job_id)["events"]))
    client.post(f"/api/v1/jobs/{job_id}/cancel")
    job = wait_for(lambda: _terminal(client, job_id), timeout=20)
    assert job["status"] == "cancelled"
    assert not _alive(child), "descendant survived cancellation"
    events_after = json.dumps(_job(client, job_id)["events"])
    time.sleep(0.5)
    assert json.dumps(_job(client, job_id)["events"]) == events_after  # no output after completion


def test_job_finishes_when_launcher_leaves_a_descendant(client, fake_cli, tmp_root):
    """Launcher exits 0 while a child keeps stdout open: the job must still complete."""
    fake_cli.env["FAKE_MODE"] = "tree_orphan"
    fake_cli.env["TREE_DIR"] = str(tmp_root)
    job_id = _start(client)
    job = wait_for(lambda: _terminal(client, job_id), timeout=15)
    assert job["status"] == "succeeded" and job["exit_code"] == 0
    assert not _alive(_pid(tmp_root, "child.pid"))
