"""Stand-in for the engine CLI in unit tests (behaviour selected with FAKE_MODE).

Modes for ``draft``: ``ok`` (default), ``slow`` (prints a line every 0.05 s for ~20 s),
``fail`` (exit 10), ``gate`` (exit 16), ``stubborn`` (ignores SIGINT), ``secret``
(prints a credential-looking line), ``bad_json`` (status/check print garbage).
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
from pathlib import Path


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
        print("ytagent 9.9.9-fake")
        return 0
    cmd, o = argv[0], _opts(argv[1:])
    root = Path(o["project-root"])
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
        (root / "outline.json").write_text(
            json.dumps({"title": "Bản nháp", "sections": [{"id": "sec-01", "heading": "Mở đầu"}]}),
            encoding="utf-8",
        )
        (root / "script.json").write_text(
            json.dumps(
                {
                    "title": "Bản nháp",
                    "sections": [
                        {
                            "outline_section_id": "sec-01",
                            "heading": "Mở đầu",
                            "narration": "Xin chào.",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        (root / "outline.md").write_text("# Bản nháp\n", encoding="utf-8")
        (root / "script.md").write_text("# Bản nháp\n\nXin chào.\n", encoding="utf-8")
        print("draft published", flush=True)
        return 0
    if cmd == "production-status":
        if mode == "bad_json":
            print("not json")
            return 0
        drafted = (root / "script.json").exists()
        print(
            json.dumps(
                {
                    "project_id": "prj-x",
                    "stages": [
                        {
                            "stage": "intake",
                            "mode": None,
                            "status": "completed",
                            "detail": "ok",
                            "next_action": None,
                        },
                        {
                            "stage": "draft",
                            "mode": None,
                            "status": "needs_review" if drafted else "blocked",
                            "detail": "G1",
                            "next_action": "review",
                        },
                    ],
                }
            )
        )
        return 0
    if cmd == "draft-check":
        if mode == "bad_json":
            print("{oops")
            return 0
        ok = (root / "script.json").exists()
        print(
            json.dumps(
                {
                    "ok": ok,
                    "errors": [] if ok else ["script.json is missing"],
                    "warnings": [],
                    "review_blockers": ["unverified"],
                    "approval_status": "not_approved",
                    "artifacts": [],
                }
            )
        )
        return 0 if ok else 2
    print(f"error: unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
