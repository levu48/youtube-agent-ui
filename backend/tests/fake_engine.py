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

``draft-edit`` (needs ``FAKE_REVISION=1``) mirrors the real engine's order and JSON errors
(verified at 573ebdd): patch validation (``invalid_patch``), revision (``revision_mismatch``),
downstream artifacts (``downstream_artifacts``), then the edit, published with regenerated
Markdown views. Modes: ``edit_conflict`` (exit 9 ``concurrency``), ``edit_race`` (the outline
changes before the revision check), ``edit_slow``. Every call is appended to
``edit-calls.jsonl`` as ``{"argv": [...], "stdin": "<patch>"}``.
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


DOWNSTREAM = ("research-plan.json", "research.json", "visuals.json", "storyboard.json")
OUTLINE_KEYS = {"title", "thesis_or_question", "sections"}
O_SECTION_KEYS = {"id", "heading", "purpose", "key_points", "claims_to_investigate"}
S_SECTION_KEYS = {"outline_section_id", "heading", "narration", "summary", "editorial_notes"}


def _patch_problems(patch: object, outline: dict, script: dict) -> list[dict]:
    if not isinstance(patch, dict) or not patch or set(patch) - {"outline", "script"}:
        return [{"loc": "<root>", "msg": "invalid patch"}]
    out: list[dict] = []
    o, sc = patch.get("outline"), patch.get("script")
    if o is not None:
        if not isinstance(o, dict) or set(o) - OUTLINE_KEYS or not o:
            out.append({"loc": "outline", "msg": "invalid outline patch"})
        else:
            ids = {x["id"] for x in outline["sections"]}
            for n, x in enumerate(o.get("sections") or []):
                if set(x) - O_SECTION_KEYS or any(v is None for v in x.values()):
                    out.append({"loc": f"outline.sections.{n}", "msg": "invalid section patch"})
                elif x.get("id") not in ids:
                    out.append(
                        {"loc": f"outline.sections.{n}.id", "msg": f"no section {x.get('id')!r}"}
                    )
            if any(v is None for v in o.values()):
                out.append({"loc": "outline", "msg": "null is not allowed"})
    if sc is not None:
        ids = {x["outline_section_id"] for x in script["sections"]}
        for n, x in enumerate((sc or {}).get("sections") or []):
            if set(x) - S_SECTION_KEYS or any(v is None for v in x.values()):
                out.append({"loc": f"script.sections.{n}", "msg": "invalid section patch"})
            elif x.get("outline_section_id") not in ids:
                sid = x.get("outline_section_id")
                out.append(
                    {"loc": f"script.sections.{n}.outline_section_id", "msg": f"no section {sid!r}"}
                )
    return out


def _views(outline: dict, script: dict) -> tuple[str, str]:
    o = [f"# {outline['title']}", ""]
    for x in outline["sections"]:
        o += [f"## {x['heading']}", "", x.get("purpose") or "", ""]
    sc = [f"# {script['title']}", ""]
    for x in script["sections"]:
        sc += [f"## {x['heading']}", "", x["narration"], ""]
    return "\n".join(o), "\n".join(sc)


def _draft_edit(root: Path, o: dict, mode: str) -> int:
    if mode == "edit_slow":
        time.sleep(30)
    raw = sys.stdin.buffer.read()
    with open(root / "edit-calls.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"argv": sys.argv[1:], "stdin": raw.decode("utf-8")}) + "\n")
    try:
        patch = json.loads(raw)
        outline = json.loads((root / "outline.json").read_text(encoding="utf-8"))
        script = json.loads((root / "script.json").read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        return _json_error("invalid_patch", 2, f"the patch is invalid: {exc}", details=[])
    problems = _patch_problems(patch, outline, script)
    if problems:
        msg = "the patch is invalid:\n" + "\n".join(f"  - {p['loc']}: {p['msg']}" for p in problems)
        return _json_error("invalid_patch", 2, msg, details=problems)
    if mode == "edit_conflict":
        return _json_error("concurrency", 9, "another run holds the draft lock")
    if mode == "edit_race":
        with open(root / "outline.json", "a", encoding="utf-8") as fh:
            fh.write("\n")
    previous = _revision(root)
    if o.get("expect-revision") != previous:
        msg = f"draft revision mismatch: the current revision is {previous}; nothing was written"
        return _json_error("revision_mismatch", 9, msg, current_revision=previous)
    downstream = [n for n in DOWNSTREAM if (root / n).exists()]
    if downstream:
        msg = "cannot edit the draft in place: later-stage work depends on it (" + (
            "; ".join(downstream) + ")."
        )
        return _json_error("downstream_artifacts", 9, msg, paths=downstream)
    before = {n: _sha(root / n) for n in DRAFT_FILES}
    op = patch.get("outline") or {}
    for k in ("title", "thesis_or_question"):
        if k in op:
            outline[k] = op[k]
    if "title" in op:
        script["title"] = op["title"]
    by_id = {x["id"]: x for x in outline["sections"]}
    for x in op.get("sections") or []:
        by_id[x["id"]].update({k: v for k, v in x.items() if k != "id"})
    s_by_id = {x["outline_section_id"]: x for x in script["sections"]}
    for x in (patch.get("script") or {}).get("sections") or []:
        s_by_id[x["outline_section_id"]].update(
            {k: v for k, v in x.items() if k != "outline_section_id"}
        )
    o_md, s_md = _views(outline, script)
    out_bytes = {
        "outline.json": json.dumps(outline, ensure_ascii=False, indent=2).encode(),
        "script.json": json.dumps(script, ensure_ascii=False, indent=2).encode(),
        "outline.md": o_md.encode(),
        "script.md": s_md.encode(),
    }
    changed = sorted(
        n for n, b in out_bytes.items() if hashlib.sha256(b).hexdigest() != before.get(n)
    )
    dry = "dry-run" in o
    if changed and not dry:
        for n in changed:
            (root / n).write_bytes(out_bytes[n])
    status = "already_current" if not changed else ("would_publish" if dry else "published")
    check = _check(root)
    report = {
        "ok": True,
        "status": status,
        "dry_run": dry,
        "project_root": str(root),
        "run_id": None if dry or not changed else "edit-fake",
        "previous_revision": previous,
        "revision": _revision(root),
        "changed_files": changed,
        "files": {n: _sha(root / n) for n in REVIEWED},
        "human_edited": [n for n in changed if n.endswith(".json")] if not dry else [],
        "storyboard": {
            "resplit_sections": [],
            "scenes_added": [],
            "scenes_removed": [],
            "briefs_need_review": [],
        },
        "check": {k: check[k] for k in ("ok", "errors", "warnings", "review_blockers")},
        "approval_status": check["approval_status"],
        "approval_changed": check["approval_changed"],
    }
    print(json.dumps(report, ensure_ascii=False))
    return 0


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
    if cmd == "draft-edit" and os.environ.get("FAKE_REVISION") == "1":
        return _draft_edit(root, o, mode)
    if cmd.startswith("research-"):
        import fake_research  # the fake's research commands (engine D-118)

        return fake_research.main(cmd, root, o, argv)
    print(f"error: unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
