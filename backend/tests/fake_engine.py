"""Stand-in for the engine CLI in unit tests (behaviour selected with FAKE_MODE).

Modes for ``draft``: ``ok`` (default), ``slow`` (prints a line every 0.05 s for ~20 s),
``fail`` (exit 10), ``gate`` (exit 16), ``stubborn`` (ignores SIGINT), ``secret``
(credential-looking output), ``tree_wait|tree_orphan|tree_ignore`` (launcher + child,
see spawn_tree.py), ``secret``
(prints a credential-looking line), ``bad_json`` (status/check print garbage).
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import sys
import time
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures" / "engine"
DRAFT_FILES = ("outline.json", "outline.md", "script.json", "script.md", "storyboard.draft.json")


def _opts(argv: list[str]) -> dict[str, str]:
    out = {}
    for a in argv:
        if a.startswith("--") and "=" in a:
            k, v = a[2:].split("=", 1)
            out[k] = v
        elif a.startswith("--"):
            out[a[2:]] = "1"
    return out


def main() -> int:
    argv = sys.argv[1:]
    mode = os.environ.get("FAKE_MODE", "ok")
    if argv == ["--version"]:
        print("ytagent 0.1.0+fake")
        return 0
    cmd, o = argv[0], _opts(argv[1:])
    root = Path(o["project-root"])
    # Per-project override for browser tests: an idea containing "[slow]" drafts slowly.
    try:
        if "[slow]" in json.loads((root / "input.json").read_text(encoding="utf-8"))["idea"]:
            mode = "slow"
    except (OSError, ValueError, KeyError):
        pass
    if cmd == "create":
        if (root / "input.json").exists():
            print(f"error: {root} is already a project", file=sys.stderr)
            return 2
        if mode == "create_fail":
            print("error: invalid project input: idea: bad", file=sys.stderr)
            return 2
        root.mkdir(parents=True, exist_ok=True)
        (root / "input.json").write_text(
            json.dumps(
                {
                    "idea": o["idea"],
                    "language": o["language"],
                    "target_duration_seconds": int(o["duration"]),
                    "audience": o.get("audience"),
                    "tone": o.get("tone"),
                    "editorial_guidance": o.get("guidance"),
                }
            ),
            encoding="utf-8",
        )
        (root / "state.json").write_text("{}", encoding="utf-8")
        (root / "argv.json").write_text(json.dumps(argv), encoding="utf-8")
        print(f"created {root}")
        return 0
    if cmd == "draft":
        (root / "draft-argv.json").write_text(json.dumps(argv), encoding="utf-8")
        print("starting draft", flush=True)
        if mode.startswith("tree_"):
            # Launcher/child process tree (see tests/spawn_tree.py).
            sys.path.insert(0, str(Path(__file__).parent))
            import spawn_tree

            os.environ["TREE_MODE"] = mode.removeprefix("tree_")
            return spawn_tree.main()
        if mode == "secret":
            print("using api_key=sk-abcdefghijklmnop1234 Bearer abcdefghijklmnop", flush=True)
        if mode in ("slow", "stubborn"):
            if mode == "stubborn":
                signal.signal(signal.SIGINT, signal.SIG_IGN)
            try:
                for i in range(400):
                    print(f"working {i}", flush=True)
                    time.sleep(0.05)
            except KeyboardInterrupt:
                print("interrupted", file=sys.stderr, flush=True)
                return 130
        if mode == "fail":
            print("error: LLM request failed: model crashed", file=sys.stderr)
            return 10
        if mode == "gate":
            print("error: human gate", file=sys.stderr)
            return 16
        # Publish the real engine's fixture-provider output (captured from youtube-agent).
        for name in DRAFT_FILES:
            shutil.copyfile(FIXTURES / "draft" / name, root / name)
        print("draft published", flush=True)
        return 0
    if cmd == "production-status":
        if mode == "bad_json":
            print("not json")
            return 0
        drafted = (root / "script.json").exists()
        name = "production-status-drafted.json" if drafted else "production-status-created.json"
        print((FIXTURES / name).read_text(encoding="utf-8"))
        return 0
    if cmd == "draft-check":
        if mode == "bad_json":
            print("{oops")
            return 0
        ok = (root / "script.json").exists()
        name = "draft-check-ok.json" if ok else "draft-check-missing.json"
        print((FIXTURES / name).read_text(encoding="utf-8"))
        return 0 if ok else 2
    print(f"error: unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
