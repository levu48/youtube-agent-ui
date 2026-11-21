"""Launcher that spawns a child, imitating ``uv run`` -> ``ytagent`` (tests only).

TREE_DIR: directory for pid/marker files. TREE_MODE:
  wait    - launcher waits for the child (like uv); child writes a marker after 1.5 s
  orphan  - launcher exits immediately; the child keeps the inherited stdout open
  ignore  - like wait, but the child ignores SIGINT and SIGTERM
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

CHILD = r"""
import os, signal, sys, time
from pathlib import Path
d = Path(sys.argv[1]); mode = sys.argv[2]
if mode == "ignore":
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
(d / "child.pid").write_text(str(os.getpid()))
for i in range(30):
    print(f"child {i}", flush=True)
    time.sleep(0.05)
(d / "late-write").write_text("the child outlived the timeout")
time.sleep(30)
"""


def main() -> int:
    d = Path(os.environ["TREE_DIR"])
    mode = os.environ.get("TREE_MODE", "wait")
    (d / "launcher.pid").write_text(str(os.getpid()))
    child = subprocess.Popen([sys.executable, "-c", CHILD, str(d), mode])
    if mode == "orphan":
        print("launcher exiting", flush=True)
        return 0
    try:
        return child.wait()
    except KeyboardInterrupt:
        # Like the real engine: exit 130 on SIGINT, without waiting for the child.
        print("interrupted", file=sys.stderr, flush=True)
        return 130


if __name__ == "__main__":
    sys.exit(main())
