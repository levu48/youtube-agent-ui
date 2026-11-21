"""Process-group termination shared by short engine commands and background jobs.

Every engine command is started with ``start_new_session=True``, so the launcher
(``uv run …``) and everything it spawns (the ``ytagent`` Python process) share one process
group whose id is the launcher's pid. Signalling only the launcher is not enough: a
descendant could outlive it and keep writing engine artifacts. We therefore signal the whole
group and wait until the *group* is empty, not merely until the launcher has exited.

PID-reuse safety: POSIX does not reuse a pid while a process group with that id still has
members, and once the group is empty ``killpg`` fails with ``ProcessLookupError``. While our
asyncio ``Process`` object is unreaped, its pid also cannot be reused.
"""

from __future__ import annotations

import asyncio
import os
import signal
import time

# (signal, seconds to wait for the group to disappear before escalating)
DEFAULT_STEPS: tuple[tuple[signal.Signals, float], ...] = (
    (signal.SIGINT, 10.0),  # the engine handles KeyboardInterrupt and exits 130
    (signal.SIGTERM, 5.0),
    (signal.SIGKILL, 5.0),
)
FAST_STEPS: tuple[tuple[signal.Signals, float], ...] = (
    (signal.SIGTERM, 2.0),
    (signal.SIGKILL, 5.0),
)
_POLL = 0.05


def group_alive(pgid: int) -> bool:
    """True while any process (including an unreaped zombie) is in the group."""
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:  # pragma: no cover - exists but owned by someone else
        return True
    return True


def signal_group(pgid: int, sig: int) -> bool:
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        return False
    except PermissionError:  # pragma: no cover
        return False
    return True


async def wait_exit(proc: asyncio.subprocess.Process, timeout: float | None = None) -> int | None:
    """Wait for the launcher to exit and return its code (None on timeout).

    ``Process.wait()`` only resolves once every pipe is closed, so a descendant holding
    stdout open would block it indefinitely. ``returncode`` is set by the child watcher as
    soon as the launcher itself exits, so we watch that instead.
    """
    deadline = None if timeout is None else time.monotonic() + timeout
    while proc.returncode is None:
        if deadline is not None and time.monotonic() >= deadline:
            return None
        await asyncio.sleep(_POLL)
    return proc.returncode


async def _reap(proc: asyncio.subprocess.Process, timeout: float) -> None:
    await wait_exit(proc, timeout)


async def wait_group_gone(proc: asyncio.subprocess.Process, timeout: float) -> bool:
    """Wait until the launcher is reaped and no member of its group remains."""
    pgid = proc.pid
    deadline = time.monotonic() + timeout
    while True:
        await _reap(proc, _POLL)
        if proc.returncode is not None and not group_alive(pgid):
            return True
        if time.monotonic() >= deadline:
            return False
        if proc.returncode is not None:
            await asyncio.sleep(_POLL)


async def terminate_group(
    proc: asyncio.subprocess.Process,
    steps: tuple[tuple[signal.Signals, float], ...] = DEFAULT_STEPS,
) -> bool:
    """Signal the process group with escalating signals until it is gone.

    Returns True when the launcher is reaped and the group is empty.
    """
    pgid = proc.pid
    for sig, wait in steps:
        if proc.returncode is not None and not group_alive(pgid):
            return True
        signal_group(pgid, sig)
        if await wait_group_gone(proc, wait):
            return True
    return await wait_group_gone(proc, 1.0)
