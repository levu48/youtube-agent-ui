"""Stand-in for the engine CLI in unit tests (behaviour selected with FAKE_MODE).

Modes for ``draft``: ``ok`` (default), ``slow`` (prints a line every 0.05 s for ~20 s),
``fail`` (exit 10), ``gate`` (exit 16), ``stubborn`` (ignores SIGINT), ``secret``
(credential-looking output), ``tree_wait|tree_orphan|tree_ignore`` (launcher + child,
see spawn_tree.py), ``secret``
(prints a credential-looking line), ``bad_json`` (status/check print garbage).

``draft-approve`` mirrors the real engine (verified at d1325c4): exit 2 with the check's errors
when the draft is incomplete, "already approved" when review.json matches, otherwise it writes
review.json binding the reviewed files' hashes. Modes: ``approve_conflict`` (exit 9),
``approve_race`` (the outline changes just before the engine snapshots it), ``approve_slow``,
``approve_garbled`` (draft-check lists no artifacts, as a malformed or incomplete report).

``FAKE_REVISION=1`` emulates an engine with the draft revision of engine D-117 (PR B):
draft-check reports ``revision`` and draft-approve takes ``--expect-revision`` and ``--json``,
checking the revision on the same snapshot it approves (so ``approve_race`` is refused).
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import sys
import time
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures" / "engine"
DRAFT_FILES = ("outline.json", "outline.md", "script.json", "script.md", "storyboard.draft.json")
REVIEWED = ("input.json", "outline.json", "script.json", "storyboard.draft.json", "assets.json")
MEANING = (
    "Approval means editorial acceptance of this draft. It is not factual verification, "
    "rights clearance, or permission to publish, and it does not start narration."
)


def _revision(root: Path) -> str:
    files = {n: _sha(root / n) for n in sorted({*REVIEWED, *DRAFT_FILES})}
    blob = json.dumps(
        {"files": files, "scheme": "m3-draft-revision-1"}, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(blob.encode()).hexdigest()


def _json_error(code: str, exit_code: int, message: str, **extra) -> int:
    err = {"code": code, "exit_code": exit_code, "message": message, **extra}
    print(json.dumps({"ok": False, "error": err}, ensure_ascii=False))
    return exit_code


def _sha(p: Path) -> str | None:
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None


def _approval(root: Path) -> tuple[str, list[str], dict | None]:
    try:
        rec = json.loads((root / "review.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return "not_approved", [], None
    except ValueError:
        return "stale", ["review.json (unreadable)"], None
    current = {n: h for n in REVIEWED if (h := _sha(root / n))}
    changed = sorted(
        n for n in set(current) | set(rec["artifacts"]) if current.get(n) != rec["artifacts"].get(n)
    )
    return ("stale" if changed else "approved"), changed, rec


def _check(root: Path) -> dict:
    ok = (root / "script.json").exists()
    name = "draft-check-ok.json" if ok else "draft-check-missing.json"
    report = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    if ok:
        for a in report["artifacts"]:
            h = _sha(root / a["path"])
            a["state"] = "generated" if h == a["sha256"] else "edited"
            a["sha256"] = h
    status, changed, _ = _approval(root)
    report["approval_status"], report["approval_changed"] = status, changed
    if os.environ.get("FAKE_REVISION") == "1":
        report["revision"] = _revision(root)
    if os.environ.get("FAKE_MODE") == "approve_garbled":
        report["artifacts"] = []
    return report


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
        report = _check(root)
        print(json.dumps(report, ensure_ascii=False))
        return 0 if report["ok"] else 2
    if cmd == "draft-approve":
        (root / "approve-argv.json").write_text(json.dumps(argv), encoding="utf-8")
        if mode == "approve_slow":
            time.sleep(30)
        as_json = "json" in o
        if mode == "approve_conflict":
            if as_json:
                return _json_error("concurrency", 9, "another run holds the draft lock")
            print("error: another run holds the draft lock", file=sys.stderr)
            return 9
        if mode == "approve_race":  # lands before the engine takes its snapshot
            with open(root / "outline.json", "a", encoding="utf-8") as fh:
                fh.write("\n")
        report = _check(root)
        expect = o.get("expect-revision")
        if expect is not None and expect != report.get("revision"):
            msg = "draft revision mismatch; nothing was approved"
            return _json_error("revision_mismatch", 9, msg, current_revision=report["revision"])
        if not report["ok"]:
            msg = "cannot approve: the draft has errors:\n" + "\n".join(
                f"  - {e}" for e in report["errors"]
            )
            if as_json:
                return _json_error("invalid_input", 2, msg)
            print(f"error: {msg}", file=sys.stderr)
            return 2
        status, _, rec = _approval(root)
        if status == "approved" and rec:
            if as_json:
                out = {"ok": True, "already_approved": True, "revision": report.get("revision")}
                print(json.dumps({**out, **rec}, ensure_ascii=False))
                return 0
            print(f"already approved by {rec['reviewer']} at {rec['approved_at'][:16]}Z")
            return 0
        rec = {
            "schema_version": "m3-review-0.1",
            "status": "approved",
            "reviewer": o.get("reviewer") or "os-user",
            "approved_at": "2026-11-21T12:00:00Z",
            "comment": o.get("comment"),
            "artifacts": {n: h for n in REVIEWED if (h := _sha(root / n))},
            "unresolved_blockers": report["review_blockers"],
            "meaning": MEANING,
        }
        (root / "review.json").write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
        if as_json:
            out = {"ok": True, "already_approved": False, "revision": report.get("revision")}
            print(json.dumps({**out, **rec}, ensure_ascii=False))
            return 0
        print(f"approved by {rec['reviewer']}; recorded in {root / 'review.json'}")
        return 0
    print(f"error: unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
