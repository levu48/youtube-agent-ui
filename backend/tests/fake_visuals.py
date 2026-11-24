"""Visuals commands of the fake engine (mirrors engine D-122 at 65c5f52, simplified).

``visuals-state --json`` prints the snapshot shape of the real engine (``m4-visuals-state-1``:
revision, inputs, evidence_inputs, pending_journals, recovery_required, catalogue, plan,
candidates, selection, applied, integrity, scenes, assets, report, gates). ``visuals-plan``,
``visuals-acquire`` (``--dry-run`` preview, ``--expect-preview`` + ``--allow-host``) and
``visuals-import --stdin`` take ``--expect-revision``, refuse ``recovery_required`` before
anything else, and answer with ``--json`` results or the error envelope.

Modes (FAKE_MODE): ``visuals_slow`` (acquire prints a progress line every 0.05 s for ~20 s),
``visuals_race`` (a visuals file changes during the network phase: ``revision_mismatch``),
``visuals_preview_drift`` (the run's preview differs from the dry run's: ``preview_mismatch``),
``visuals_partial`` (some scenes fail: exit 13 ``partial_acquire_failure``),
``visuals_state_fail`` (visuals-state exits 1). Every argv is appended to
``visuals-calls.jsonl``.
"""

from __future__ import annotations

import hashlib
import json
import os
import struct
import sys
import time
import zlib
from pathlib import Path

PLAN = "visual-plan.json"
SELECTION = "visual-selection.json"
CANDIDATES = "render/visuals/candidates.json"
PROVENANCE = "render/visuals/provenance.json"
MANIFEST = "render/visuals/manifest.json"
APPLIED = "render/visuals/applied.json"
ASSETS = "assets.json"
JOURNALS = {
    "render/llm/manifest.json": "draft/visuals",
    "render/research/manifest.json": "research",
    "render/production/manifest.json": "production package",
}
RECOVERY = ("render/llm/manifest.json", "render/research/manifest.json")
INPUTS = (
    "input.json", "outline.json", "script.json", "storyboard.draft.json", "review.json",
    ASSETS, "research-plan.json", PLAN, SELECTION, CANDIDATES, PROVENANCE, APPLIED, MANIFEST,
    "render/visuals/clearance-history.json", *JOURNALS,
)  # fmt: skip
HOSTS = {
    "fixture": ["commons.fixture.invalid", "upload.fixture.invalid"],
    "wikimedia": ["commons.wikimedia.org", "upload.wikimedia.org"],
}


def _sha_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _sha(p: Path) -> str | None:
    return _sha_bytes(p.read_bytes()) if p.is_file() and not p.is_symlink() else None


def sha256_json(obj) -> str:  # noqa: ANN001
    return _sha_bytes(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode())


def _read(root: Path, rel: str, default=None):  # noqa: ANN001, ANN202
    p = root / rel
    try:
        return json.loads(p.read_text("utf-8")) if p.is_file() else default
    except ValueError:
        return default


def _write(root: Path, rel: str, data) -> None:  # noqa: ANN001
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")


def _error(code: str, exit_code: int, message: str, **extra) -> int:
    err = {"code": code, "exit_code": exit_code, "message": message, **extra}
    print(json.dumps({"ok": False, "error": err}, ensure_ascii=False, indent=2))
    print(f"error: {message}", file=sys.stderr)
    return exit_code


def png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """A valid, solid-colour RGB PNG (no imaging library needed)."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    row = b"\x00" + bytes(rgb) * width
    raw = zlib.compress(row * height)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


# --------------------------------------------------------------------------- snapshot


def inputs(root: Path) -> dict[str, str | None]:
    return {rel: _sha(root / rel) for rel in INPUTS}


def _evidence(root: Path) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for c in (_read(root, SELECTION, {}) or {}).get("rights_clearances") or []:
        ref = str(c.get("evidence") or "").strip()
        if ref and not ref.startswith(("http://", "https://")):
            p = root / ref
            out[ref] = (
                _sha(p)
                if not ref.startswith("/") and ".." not in ref.split("/") and p.is_file()
                else None
            )
    return out


def revision(root: Path) -> str:
    return sha256_json({"files": inputs(root), "scheme": "m4-visuals-revision-1"})


def pending(root: Path) -> list[dict]:
    out = []
    for rel, what in JOURNALS.items():
        doc = _read(root, rel, None)
        if isinstance(doc, dict) and doc.get("pending") is not None:
            out.append({
                "severity": "blocker", "stage": "package" if "production" in rel else "draft",
                "code": "recovery_required", "artifact": None,
                "detail": f"{what} publication was interrupted and is still pending; inspection "
                "never repairs it, and nothing can be certified until it is recovered",
                "next_action": "ytagent resume --project-root <project> (or the stage's own "
                "command) to recover it",
            })  # fmt: skip
    return out


def recovery_journals(root: Path) -> list[str]:
    return [
        rel
        for rel in RECOVERY
        if isinstance(d := _read(root, rel, None), dict) and d.get("pending") is not None
    ]


def _catalog(root: Path) -> tuple[bool, list[str]]:
    man = _read(root, MANIFEST, None)
    if man is None:
        return True, []
    problems = [
        f"{rel} is not the file the tool last wrote"
        for rel in (CANDIDATES, PROVENANCE)
        if (man.get("files") or {}).get(rel) != _sha(root / rel)
    ]
    return not problems, problems


def _integrity(root: Path, c: dict) -> str:
    p = root / (c.get("local_path") or "")
    if not c.get("local_path") or not (p.is_file() or p.is_symlink()):
        return "missing"
    return "ok" if _sha(p) == c.get("sha256") else "mismatch"


def _scenes(root: Path) -> list[dict]:
    return [s for s in (_read(root, "storyboard.draft.json", {}) or {}).get("scenes") or []]


def state(root: Path) -> dict:
    trusted, problems = _catalog(root)
    cands = (_read(root, CANDIDATES, {}) or {}).get("candidates") or []
    by_scene: dict[str, list[dict]] = {}
    for c in cands:
        by_scene.setdefault(c["scene_id"], []).append(
            {**c, "rights_fingerprint": sha256_json(c.get("rights") or {})}
        )
    selection = _read(root, SELECTION, None)
    applied = _read(root, APPLIED, None)
    assets = (_read(root, ASSETS, {}) or {}).get("assets") or {}
    integrity = {}
    for s in (selection or {}).get("scenes") or []:
        for shot in s.get("shots") or []:
            c = next((x for x in cands if x["id"] == shot.get("candidate_id")), None)
            if c:
                integrity[c["id"]] = _integrity(root, c)
    scenes, facts = [], {}
    for sc in _scenes(root):
        shots = sc.get("shots") or []
        scenes.append({
            "scene_id": sc["id"],
            "apply_state": "existing_shots" if shots else "none",
            "draft_shots": shots, "selection_shots": None, "applied_shots": None,
        })  # fmt: skip
        for shot in shots:
            aid = shot.get("asset_id")
            if not aid:
                continue
            f = facts.setdefault(aid, {"asset_id": aid, "scene_ids": []})
            f["scene_ids"].append(sc["id"])
    asset_facts = []
    for aid, f in facts.items():
        rec = assets.get(aid)
        rel = (rec or {}).get("local_path")
        sha = Path(rel).stem if rel else None
        p = root / rel if rel else None
        image = (
            None
            if not rel
            else "missing"
            if not (p.is_file() or p.is_symlink())
            else ("ok" if _sha(p) == sha else "mismatch")
        )
        intact = bool(rec) and (applied or {}).get("assets", {}).get(aid) == sha256_json(rec)
        bound = ((applied or {}).get("asset_candidates") or {}).get(aid) or []
        asset_facts.append({
            **f, "candidate_id": bound[0] if len(bound) == 1 else None,
            "candidate_ids": sorted(bound), "candidate_binding": "recorded" if bound else "missing",
            "sha256": sha, "local_path": rel, "image": image, "record_intact": intact,
            "problem": None if intact and image == "ok" and (rec or {}).get("rights_verified")
            else "asset not releasable",
            "credit_problems": [], "fixture": bool((rec or {}).get("fixture")),
            "rights_current": bool((rec or {}).get("rights_verified")) and bound != [],
            "rights_reason": None if (rec or {}).get("rights_verified") else "not_verified",
        })  # fmt: skip
    plan = _read(root, PLAN, None)
    g1 = "approved" if (root / "review.json").is_file() else "not_approved"
    if (root / APPLIED).is_file() and g1 == "approved":
        g1 = "stale_after_apply"
    g3 = (
        {"status": "pending", "findings": []}
        if plan is None
        else {
            "status": "needs_review",
            "findings": [{
                "severity": "blocker", "stage": "visuals", "code": "visuals_selection_needed",
                "artifact": None, "detail": f"G3: {len(scenes)} scene(s) have no selected, "
                "applied image", "next_action": "choose candidates in visual-selection.json",
            }],
        }
    )  # fmt: skip
    pj = pending(root)
    return {
        "ok": True,
        "scheme": "m4-visuals-state-1",
        "revision": revision(root),
        "revision_scheme": "m4-visuals-revision-1",
        "inputs": inputs(root),
        "evidence_inputs": _evidence(root),
        "pending_journals": pj,
        "recovery_required": bool(recovery_journals(root)),
        "catalog_trusted": trusted,
        "catalog_problems": problems,
        "plan": plan,
        "candidates": by_scene,
        "selection": selection,
        "clearance_history": None,
        "applied": applied,
        "integrity": integrity,
        "scenes": scenes,
        "assets": asset_facts,
        "report": {
            "schema_version": "m4-visual-report-0.1",
            "command": "visuals-state",
            "render_ready": False,
            "totals": {"scenes": len(scenes), "candidates": len(cands)},
            "errors": [],
            "warnings": [],
            "scenes": [
                {
                    "scene_id": s["scene_id"],
                    "disposition": "candidates_available"
                    if by_scene.get(s["scene_id"])
                    else "no_candidates",
                    "messages": [],
                }
                for s in scenes
            ],
            "unpublishable": [],
            "image_integrity": [],
        },
        "gates": {"g1": {"status": g1, "findings": []}, "g3": g3},
    }


# --------------------------------------------------------------------------- commands


def _guard(root: Path, o: dict) -> int | None:
    """Recovery first (before recovering anything), then the revision (D-122)."""
    journals = recovery_journals(root)
    if journals and "expect-revision" in o:
        return _error(
            "recovery_required",
            9,
            "a draft/visuals or research publication is pending; recover it first "
            "(visuals-check, research-check or resume). Nothing was done.",
            details={"journals": journals},
        )
    want, current = o.get("expect-revision"), revision(root)
    if want is not None and want != current:
        return _error(
            "revision_mismatch",
            9,
            f"visuals revision mismatch: expected {want} but the current revision is {current}",
            details={"current_revision": current},
        )
    return None


def _plan(root: Path, o: dict) -> int:
    if (refused := _guard(root, o)) is not None:
        return refused
    if not (root / "review.json").is_file():
        return _error("g1_not_current", 12, "the draft is not approved (G1); approve it first")
    scenes = _scenes(root)
    if not scenes:
        return _error("invalid_input", 2, "storyboard.draft.json has no scenes")
    plan = {
        "schema_version": "m4-visual-plan-0.1",
        "scenes": [
            {
                "scene_id": s["id"],
                "section_id": s.get("outline_section_id"),
                "desired_kind": "chart" if n == 2 else "illustration",
                "brief": s.get("visual_brief") or f"Visual for {s['id']}.",
                "search_query": f"test query {n + 1}",
                "search_enabled": n != 2,
                "generation_enabled": False,
                "requires_manual_asset": n == 2,
                "notes": "",
            }
            for n, s in enumerate(scenes)
        ],
    }
    if not (root / PLAN).exists():
        _write(root, PLAN, plan)
    by_kind: dict[str, int] = {}
    for s in plan["scenes"]:
        by_kind[s["desired_kind"]] = by_kind.get(s["desired_kind"], 0) + 1
    print("planned visuals", file=sys.stderr, flush=True)
    manual = [s["scene_id"] for s in plan["scenes"] if s["requires_manual_asset"]]
    out = {"ok": True, "status": "written", "scenes": len(scenes), "by_kind": by_kind,
           "requires_manual": manual, "revision": revision(root)}  # fmt: skip
    print(json.dumps(out, indent=2))
    return 0


def _preview(root: Path, o: dict, argv: list[str]) -> dict:
    plan = _read(root, PLAN, {}) or {}
    wanted = [a.split("=", 1)[1] for a in argv if a.startswith("--scene=")]
    scenes = [s for s in plan.get("scenes") or [] if not wanted or s["scene_id"] in wanted]
    provider = o.get("search-provider", "none")
    queries = [
        {"scene_id": s["scene_id"], "query": s["search_query"]}
        for s in scenes
        if s.get("search_enabled")
    ]
    return {
        "scheme": "m4-acquire-preview-1",
        "project_id": "prj-fake",
        "revision": revision(root),
        "search_provider": f"{provider}-search",
        "image_provider": o.get("image-provider", "none"),
        "scene_ids": sorted(s["scene_id"] for s in scenes),
        "queries": queries,
        "generate": [],
        "max_candidates_per_scene": int(o.get("max-candidates-per-scene", "4")),
        "timeout": 30.0,
        "concurrency": 2,
        "force": False,
        "hosts": sorted(HOSTS.get(provider, [])) if queries else [],
    }


def _store(root: Path, data: bytes) -> tuple[str, str]:
    sha = _sha_bytes(data)
    rel = f"render/visuals/candidates/{sha}.png"
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.write_bytes(data)
    return rel, sha


def _publish(root: Path, cands: list[dict]) -> None:
    _write(root, CANDIDATES, {"schema_version": "m4-candidates-0.1", "candidates": cands})
    _write(root, PROVENANCE, {"schema_version": "m4-provenance-0.1", "runs": []})
    _write(
        root,
        MANIFEST,
        {"files": {rel: _sha(root / rel) for rel in (CANDIDATES, PROVENANCE)}},
    )
    if not (root / SELECTION).exists():
        plan = _read(root, PLAN, {}) or {}
        _write(
            root,
            SELECTION,
            {
                "schema_version": "m4-visual-selection-0.1",
                "scenes": [{"scene_id": s["scene_id"], "shots": [], "note": ""}
                           for s in plan.get("scenes") or []],
                "rights_clearances": [],
            },
        )  # fmt: skip


def _candidate(scene_id: str, n: int, rel: str, sha: str, provider: str) -> dict:
    host = HOSTS[provider][0] if provider in HOSTS else "commons.fixture.invalid"
    title = f"File:Fixture {scene_id} {n}.png"
    page = f"https://{host}/wiki/File:Fixture_{scene_id}_{n}.png"
    accepted = n % 2 == 0
    return {
        "id": f"{scene_id}-cm-{_sha_bytes(page.encode())[:10]}",
        "scene_id": scene_id, "source_type": "commons", "provider": f"{provider}-search",
        "kind": "archival", "title": title, "status": "available", "selectable": True,
        "placeholder": provider == "fixture", "synthetic": False, "local_path": rel,
        "sha256": sha, "width": 64, "height": 36, "format": "png", "source_page_url": page,
        "rights": {
            "status": "accepted" if accepted else "manual_review",
            "license_id": "CC-BY-4.0" if accepted else None,
            "license_name": "CC BY 4.0" if accepted else None,
            "license_url": "https://creativecommons.org/licenses/by/4.0" if accepted else None,
            "creator": f"Fixture Photographer {n}",
            "credit_line": f'"{title}" by Fixture Photographer {n}, via fixture data',
            "restrictions": [] if accepted else ["personality rights may apply"],
            "reasons": ["licence and attribution evidence complete for the policy"]
            if accepted else ["the licence could not be verified automatically"],
        },
        "disclosure_label": None,
        "review_reasons": ["fixture search result: placeholder, not a real source"]
        if provider == "fixture" else [],
        "warnings": [],
    }  # fmt: skip


def _acquire(root: Path, o: dict, argv: list[str], mode: str) -> int:
    if (refused := _guard(root, o)) is not None:
        return refused
    if not (root / PLAN).is_file():
        return _error("invalid_input", 2, "visual-plan.json is missing: run visuals-plan first")
    preview = _preview(root, o, argv)
    if "dry-run" in o:
        print(json.dumps({"ok": True, "dry_run": True, "preview": preview,
                          "preview_sha256": sha256_json(preview)}, indent=2))  # fmt: skip
        return 0
    if mode == "visuals_preview_drift":
        preview = {**preview, "max_candidates_per_scene": preview["max_candidates_per_scene"] + 1}
    allowed = sorted({a.split("=", 1)[1] for a in argv if a.startswith("--allow-host=")})
    digest = sha256_json(preview)
    if "expect-preview" in o and (o["expect-preview"] != digest or allowed != preview["hosts"]):
        return _error(
            "preview_mismatch",
            9,
            f"the acquisition that would run now is not the one that was previewed and "
            f"confirmed (preview {digest}, hosts {', '.join(preview['hosts'])}); nothing was "
            "contacted",
            details={"preview_sha256": digest, "hosts": preview["hosts"]},
        )
    provider = o.get("search-provider", "none")
    if mode == "visuals_slow":
        try:
            for i in range(400):
                print(f"search scene-{i:03d}: slow", file=sys.stderr, flush=True)
                time.sleep(0.05)
        except KeyboardInterrupt:
            print("interrupted", file=sys.stderr, flush=True)
            return 130
    cands = list((_read(root, CANDIDATES, {}) or {}).get("candidates") or [])
    done, failed = {}, []
    for k, q in enumerate(preview["queries"]):
        sid = q["scene_id"]
        print(f"search {sid}: {q['query']}", file=sys.stderr, flush=True)
        if mode == "visuals_partial" and k % 2 == 1:
            failed.append(sid)
            done[sid] = "search_failed"
            continue
        for n in range(2):
            rel, sha = _store(root, png(64, 36, (40 + 30 * k, 90 + 40 * n, 160)))
            print(f"  downloaded {sid} candidate {n}", file=sys.stderr, flush=True)
            c = _candidate(sid, n, rel, sha, provider)
            cands = [x for x in cands if x["id"] != c["id"]] + [c]
        done[sid] = "candidates_available"
    if mode == "visuals_race":
        p = root / PLAN
        p.write_text(p.read_text("utf-8") + "\n", "utf-8")
        if (refused := _guard(root, o)) is not None:
            return refused
    _publish(root, cands)
    report = {"run_id": "fake-run", "search_provider": f"{provider}-search",
              "image_provider": "none", "scenes": done, "candidates": len(cands),
              "failures": {"search_failed": len(failed)} if failed else {}}  # fmt: skip
    if failed:
        return _error(
            "partial_acquire_failure",
            13,
            f"{len(failed)} image search(es) failed; completed scenes were recorded",
            details=report,
        )
    print(json.dumps({"ok": True, **report}, indent=2))
    return 0


def _import(root: Path, o: dict) -> int:
    data = sys.stdin.buffer.read(20 * 1024 * 1024 + 1)
    with open(root / "visuals-import-stdin.bin", "wb") as fh:
        fh.write(data)
    if (refused := _guard(root, o)) is not None:
        return refused
    if not data:
        return _error("invalid_input", 2, "no image bytes on stdin")
    if not (data.startswith(b"\x89PNG") or data[:3] == b"\xff\xd8\xff"
            or data[:4] in (b"RIFF", b"II*\x00", b"MM\x00*")):  # fmt: skip
        return _error("error", 3, "unrecognised image data (not JPEG, PNG, WebP or TIFF)")
    if len(" ".join(o.get("provenance", "").split())) < 10:
        return _error(
            "invalid_input",
            2,
            "--provenance must describe where the image comes from (>= 10 chars)",
        )
    scene = o["scene"]
    if scene not in {s["id"] for s in _scenes(root)}:
        return _error("invalid_input", 2, f"unknown scene {scene!r}")
    # The engine re-encodes every import as PNG or JPEG; the fake stores a normalised PNG.
    stored = data if data.startswith(b"\x89PNG") else png(48, 48, (200, 120, 40))
    rel, sha = _store(root, stored)
    cid = f"{scene}-imp-{_sha_bytes(data)[:10]}"
    cands = [c for c in (_read(root, CANDIDATES, {}) or {}).get("candidates") or []
             if c["id"] != cid]  # fmt: skip
    cands.append({
        "id": cid, "scene_id": scene, "source_type": "import", "provider": "import",
        "kind": o.get("kind"), "title": o.get("title"), "status": "available",
        "selectable": True, "placeholder": False, "synthetic": o.get("kind") == "generated",
        "local_path": rel, "sha256": sha, "width": 48, "height": 48, "format": "png",
        "source_page_url": o.get("source-url"),
        "rights": {"status": "manual_review", "license_name": o.get("license-name"),
                   "license_url": o.get("license-url"), "creator": o.get("creator"),
                   "credit_line": o.get("attribution"), "restrictions": [],
                   "reasons": ["imported: a human must clear its rights"]},
        "disclosure_label": None, "review_reasons": [], "warnings": [],
    })  # fmt: skip
    _publish(root, cands)
    out = {"ok": True, "candidate_id": cid, "scene_id": scene, "local_path": rel, "width": 48,
           "height": 48, "rights_status": "manual_review", "warnings": [], "sha256": sha,
           "revision": revision(root)}  # fmt: skip
    print(json.dumps(out, indent=2))
    return 0


def main(cmd: str, root: Path, o: dict, argv: list[str]) -> int:
    mode = os.environ.get("FAKE_MODE", "ok")
    with open(root / "visuals-calls.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"argv": argv}) + "\n")
    if cmd == "visuals-state":
        if mode == "visuals_state_fail":
            print("error: cannot read the visuals state", file=sys.stderr)
            return 1
        print(json.dumps(state(root), ensure_ascii=False, indent=2))
        return 0
    if cmd == "visuals-plan":
        return _plan(root, o)
    if cmd == "visuals-acquire":
        return _acquire(root, o, argv, mode)
    if cmd == "visuals-import":
        return _import(root, o)
    print(f"error: unknown command {cmd}", file=sys.stderr)
    return 2
