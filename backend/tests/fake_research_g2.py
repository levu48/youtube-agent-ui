"""G2, apply and export for the fake engine (mirrors engine fb6bffc, simplified).

- ``research-approve --reviewer --comment --expect-revision --json``: refuses a changed revision
  (``revision_mismatch``), a non-current G1 (``g1_not_current``, exit 12), blocking items
  (``not_approvable``, exit 14, one ``  - [code] detail`` line per item) and a generic reviewer
  (``invalid_input``). Writes ``research-approval.json`` binding the research files (not the
  storyboard) and the scene → claim mapping; ``already_approved`` when still current.
- ``research-apply``: needs a current approval (``approval_stale``, exit 12); writes only the
  scenes' ``claim_ids``, so G1 becomes ``stale_after_apply``.
- ``research-export``: needs a current, applied approval; writes ``output/sources.md`` and three
  ``render/research`` files, and refuses (``human_edit_conflict``) to overwrite one edited by hand.

Mode ``research_race``: a research file changes after the revision is read, so the approval is
refused with ``revision_mismatch``.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import fake_research as R

APPROVAL = "research-approval.json"
STORYBOARD = "storyboard.draft.json"
EXPORTS = (
    "output/sources.md",
    "render/research/citation-plan.json",
    "render/research/research-report.json",
    "render/research/research-report.md",
)
EXPORT_LOG = "render/research/.fake-export.json"  # the fake's record of what it wrote
FINAL = ("verified", "disputed", "editorial_nonfactual")
MEANING = (
    "A named reviewer's audit attestation that the recorded evidence was reviewed for these "
    "exact claims and narration. It is not a guarantee of historical truth, not a "
    "cryptographic signature, and not permission to publish."
)


def bound(root: Path) -> str:
    """What an approval covers: every research file except the approval itself."""
    files = {rel: R._sha(root / rel) for rel in R.FILES if rel != APPROVAL}
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


def scene_claims(root: Path) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for c in R._claims(root):
        for a in c.get("anchors", []):
            out.setdefault(a["scene_id"], [])
            if c["id"] not in out[a["scene_id"]]:
                out[a["scene_id"]].append(c["id"])
    return out


def g1(root: Path) -> str:
    """G1 as the engine's production gate reports it."""
    import fake_engine as F

    try:
        status, changed, _ = F._approval(root)
    except (KeyError, TypeError):  # a placeholder review.json some tests write
        return "invalid"
    if status == "stale" and set(changed) <= {STORYBOARD, "assets.json"}:
        return "stale_after_apply"
    return status


def state(root: Path) -> tuple[str, bool]:
    """(approval_status, applied)."""
    rec = R._read(root, APPROVAL, None)
    if rec is None:
        return "not_approved", False
    if rec.get("bound") != bound(root):
        return "stale", False
    sb = R._read(root, STORYBOARD, {"scenes": []})
    mapping = rec.get("scene_claims") or {}
    applied = all(
        list(mapping.get(s["id"], [])) == list(s.get("claim_ids") or []) for s in sb["scenes"]
    )
    return "approved", applied


def gate(root: Path, approvable: bool) -> str:
    status, applied = state(root)
    if status == "approved":
        return "approved" if applied else "approved_not_applied"
    return "needs_review" if R._read(root, "research-plan.json", None) else "pending"


def extra_items(root: Path, claims: list[dict]) -> list[dict]:
    """Undecided claims with evidence, and the editorial note after apply."""
    items = [
        {
            "code": "human_review_required",
            "claim_id": c["id"],
            "blocking": True,
            "detail": f"{c['id']}: evidence is linked; a reviewer must decide",
        }
        for c in claims
        if c["status"] not in FINAL and (c["supports"] or c["contradicts"] or c["context"])
    ]
    if g1(root) == "stale_after_apply":
        items.append(
            {
                "code": "editorial_storyboard_changed",
                "claim_id": None,
                "blocking": False,
                "detail": "M3 approval predates the current storyboard.draft.json (claim_ids or "
                "shots only); run draft-approve before rendering",
            }
        )
    return items


def _evaluated(root: Path) -> dict:
    import contextlib
    import io

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        R.check(root)
    return json.loads(buf.getvalue())


def approve(root: Path, o: dict, mode: str) -> int:
    if (err := R._expect(root, o)) is not None:
        return err
    if mode == "research_race":
        return R._race(root, mode, o) or 0
    who = (o.get("reviewer") or "").strip()
    if not who or who.casefold() in ("reviewer", "admin", "user", "test"):
        msg = "--reviewer must name the human who reviewed the research"
        return R._error("invalid_input", 2, msg)
    if g1(root) not in ("approved", "stale_after_apply"):
        msg = f"research-approve needs current M3 editorial approval: {g1(root)}"
        return R._error("g1_not_current", 12, msg)
    report = _evaluated(root)
    blocking = [i for i in report["items"] if i["blocking"]]
    if blocking:
        lines = "\n".join(f"  - [{i['code']}] {i['detail']}" for i in blocking[:25])
        return R._error("not_approvable", 14, f"research is not approvable:\n{lines}")
    status, _ = state(root)
    rec = R._read(root, APPROVAL, None)
    if status == "approved" and rec:
        out = {"ok": True, "status": "already_approved", "approval": rec}
        out["revision"] = R.revision(root)
        print(json.dumps(out, ensure_ascii=False))
        return 0
    rec = {
        "schema_version": "m5-approval-0.1",
        "reviewer": " ".join(who.split()),
        "approved_at": "2026-11-23T12:00:00Z",
        "comment": o.get("comment"),
        "policy_version": "m5-research-3",
        "bound": bound(root),
        "claim_statuses": {c["id"]: c["status"] for c in report["claims"]},
        "scene_claims": scene_claims(root),
        "meaning": MEANING,
    }
    R._write(root, APPROVAL, rec)
    out = {"ok": True, "status": "approved", "approval": rec, "revision": R.revision(root)}
    print(json.dumps(out, ensure_ascii=False))
    return 0


def apply(root: Path, o: dict) -> int:
    if (err := R._expect(root, o)) is not None:
        return err
    status, applied = state(root)
    if status != "approved":
        return R._error(
            "approval_stale",
            12,
            f"research approval is {status}: run research-check and "
            "research-approve before research-apply",
        )
    revision = R.revision(root)
    if applied:
        out = {"ok": True, "status": "already_current", "scenes_changed": [], "written": [],
               "revision": revision}  # fmt: skip
        print(json.dumps(out))
        return 0
    sb = R._read(root, STORYBOARD, {"scenes": []})
    mapping = R._read(root, APPROVAL, {})["scene_claims"]
    changed = []
    for s in sb["scenes"]:
        new = list(mapping.get(s["id"], []))
        if list(s.get("claim_ids") or []) != new:
            s["claim_ids"] = new
            changed.append(s["id"])
    R._write(root, STORYBOARD, sb)
    out = {"ok": True, "status": "published", "scenes_changed": changed, "written": [STORYBOARD],
           "revision": revision}  # fmt: skip
    print(json.dumps(out))
    return 0


def export(root: Path, o: dict) -> int:
    if (err := R._expect(root, o)) is not None:
        return err
    status, applied = state(root)
    if status != "approved":
        return R._error("approval_stale", 12, f"research approval is {status}: approve first")
    if not applied:
        return R._error(
            "not_approvable", 14, "claim IDs are not applied to the scenes: run research-apply"
        )
    rec = R._read(root, APPROVAL, {})
    outputs = {
        "output/sources.md": f"# Sources\n\nResearch approval: approved, by {rec['reviewer']}\n",
        "render/research/citation-plan.json": json.dumps({"scene_claims": rec["scene_claims"]}),
        "render/research/research-report.json": json.dumps({"approval_status": "approved"}),
        "render/research/research-report.md": "# Research report\n",
    }
    log = R._read(root, EXPORT_LOG, {})
    edited = [
        rel
        for rel, data in outputs.items()
        if (p := root / rel).is_file()
        and R._sha(p) != log.get(rel)
        and p.read_text("utf-8") != data
    ]
    if edited:
        return R._error(
            "human_edit_conflict", 2,
            f"{', '.join(edited)} were edited by hand; pass --replace-output to overwrite them",
        )  # fmt: skip
    written = []
    for rel, data in outputs.items():
        p = root / rel
        if p.is_file() and p.read_text("utf-8") == data:
            continue
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(data, "utf-8")
        log[rel] = R._sha(p)
        written.append(rel)
    R._write(root, EXPORT_LOG, log)
    out = {"ok": True, "written": written, "unchanged": [r for r in outputs if r not in written],
           "revision": R.revision(root)}  # fmt: skip
    print(json.dumps(out))
    return 0


def production_stages(root: Path, stages: list[dict]) -> list[dict]:
    """Once research has started: G1 and G2 as production-status reports them."""
    if R._read(root, "research-plan.json", None) is None:
        return stages
    g = g1(root)
    out = []
    for st in stages:
        if st["stage"] == "draft":
            st = {**st, "status": "completed" if g == "approved" else "needs_review",
                  "detail": f"G1 editorial: {g}"}  # fmt: skip
        out.append(st)
    if g in ("approved", "stale_after_apply"):
        g2 = gate(root, False)
        out.append({"stage": "research", "mode": None,
                    "status": "completed" if g2 == "approved" else "needs_review",
                    "detail": f"G2 research: {g2}", "next_action": None})  # fmt: skip
    return out
