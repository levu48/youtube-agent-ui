"""Subprocess execution for the engine CLI: no shell, explicit cwd, allowlisted env."""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.engine import commands
from app.engine.errors import Classification, classify, engine_error_line, redact
from app.engine.process import FAST_STEPS, terminate_group

_ENV_PASSTHROUGH = (
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "UV_CACHE_DIR",
    "UV_PYTHON_INSTALL_DIR",
)
MAX_CAPTURE = 2 * 1024 * 1024


class EngineUnavailable(RuntimeError):
    """The engine CLI could not be started (missing uv, repo or virtualenv)."""


@dataclass
class EngineResult:
    argv: list[str]
    exit_code: int | None
    stdout: str
    stderr: str
    elapsed: float
    timed_out: bool = False
    classification: Classification = field(init=False)

    def __post_init__(self) -> None:
        self.classification = classify(self.exit_code)

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out

    @property
    def message(self) -> str:
        return engine_error_line(self.stderr) or self.classification.summary

    def diagnostic(self) -> str:
        return redact(self.stderr.strip() or self.stdout.strip())

    def json(self) -> Any:
        """Parse stdout as JSON (raises ``ValueError`` on malformed output)."""
        return json.loads(self.stdout)


class EngineCLI:
    """Runs ``<base argv> <allowlisted args>`` in the engine repository."""

    def __init__(self, base_argv: list[str], cwd: Path, env: dict[str, str]) -> None:
        self.base_argv = list(base_argv)
        self.cwd = cwd
        self.env = dict(env)

    @classmethod
    def from_settings(cls, settings) -> EngineCLI:
        uv = settings.resolve_uv()
        base = [str(uv) if uv else "uv", "run", "--no-sync", "--quiet", "ytagent"]
        return cls(base, settings.engine_repo, build_env(settings, uv))

    def argv(self, args: list[str]) -> list[str]:
        commands.assert_allowlisted(args)
        return [*self.base_argv, *args]

    def _check_runnable(self) -> None:
        exe = self.base_argv[0]
        if not os.path.isabs(exe) or not os.access(exe, os.X_OK):
            raise EngineUnavailable(f"engine launcher not found or not executable: {exe}")
        if not self.cwd.is_dir():
            raise EngineUnavailable(f"engine repository not found: {redact(str(self.cwd))}")

    async def run(
        self, args: list[str], *, timeout: float, stdin: bytes | None = None
    ) -> EngineResult:
        """Run a short command to completion with bounded output.

        ``stdin`` (bounded by the caller) is written to the process and closed; otherwise
        stdin is /dev/null. It is data, never part of the command line."""
        argv = self.argv(args)
        self._check_runnable()
        start = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=self.cwd,
                env=self.env,
                stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
        except OSError as exc:
            raise EngineUnavailable(f"cannot start engine: {exc.strerror or exc}") from exc
        timed_out = False
        reader = asyncio.ensure_future(proc.communicate(stdin))
        try:
            done, _ = await asyncio.wait({reader}, timeout=timeout)
            if not done:
                # Timed out: stop the launcher *and* every descendant (the whole group),
                # wait until the group is empty, and reap the launcher.
                timed_out = True
                await terminate_group(proc, FAST_STEPS)
            try:
                out, err = await asyncio.wait_for(reader, timeout=5.0)
            except TimeoutError:  # pragma: no cover - pipes held open after SIGKILL
                reader.cancel()
                out, err = b"", b""
        except BaseException:
            # The caller was cancelled (e.g. client disconnected): never leave the group behind.
            reader.cancel()
            await asyncio.shield(terminate_group(proc, FAST_STEPS))
            raise
        return EngineResult(
            argv=args,
            exit_code=proc.returncode,
            stdout=out[:MAX_CAPTURE].decode("utf-8", "replace"),
            stderr=err[:MAX_CAPTURE].decode("utf-8", "replace"),
            elapsed=time.monotonic() - start,
            timed_out=timed_out,
        )

    async def spawn(self, args: list[str]) -> asyncio.subprocess.Process:
        """Start a long-running command in its own process group (for background jobs)."""
        argv = self.argv(args)
        self._check_runnable()
        try:
            return await asyncio.create_subprocess_exec(
                *argv,
                cwd=self.cwd,
                env=self.env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
                limit=64 * 1024,
            )
        except OSError as exc:
            raise EngineUnavailable(f"cannot start engine: {exc.strerror or exc}") from exc


def build_env(settings, uv: Path | None) -> dict[str, str]:
    env = {k: os.environ[k] for k in _ENV_PASSTHROUGH if k in os.environ}
    path = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    if uv is not None:
        path.insert(0, str(uv.parent))
    env.update(
        PATH=":".join(path),
        PYTHONUNBUFFERED="1",
        PYTHONIOENCODING="utf-8",
        NO_COLOR="1",
        OLLAMA_BASE_URL=settings.ollama_base_url,
    )
    env.setdefault("LANG", "en_US.UTF-8")
    return env
