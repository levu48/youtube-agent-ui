"""Visuals commands of the fake engine (mirrors engine D-122/D-123/D-124 at 26c608f, simplified).

``visuals-state --json`` prints the snapshot shape of the real engine (``m4-visuals-state-1``:
revision, inputs, evidence_inputs, pending_journals, recovery_required, catalogue, plan,
candidates, selection, applied, integrity, scenes, assets, report, gates). ``visuals-plan``,
``visuals-acquire`` (``--dry-run`` preview, ``--expect-preview`` + ``--allow-host``) and
``visuals-import --stdin`` take ``--expect-revision``, refuse ``recovery_required`` before
anything else, and answer with ``--json`` results or the error envelope. ``visuals-edit``
(UI-B, D-123) reads a strict patch on stdin (shots, clearances bound to the image hash and
rights fingerprint, revocations, plan narrowing) and keeps a hash-chained clearance history;
``visuals-apply`` installs content-addressed asset images and records ``applied.json``. G3
follows D-124: applied, intact, currently cleared images.

Modes (FAKE_MODE): ``visuals_slow`` (acquire prints a progress line every 0.05 s for ~20 s),
``visuals_race`` (a visuals file changes during the network phase: ``revision_mismatch``),
``visuals_preview_drift`` (the run's preview differs from the dry run's: ``preview_mismatch``),
``visuals_partial`` (some scenes fail: exit 13 ``partial_acquire_failure``),
``visuals_state_fail`` (visuals-state exits 1), ``visuals_edit_race`` (edit: ``concurrency``),
``visuals_apply_not_ready`` (apply: the shared-bytes ``not_ready`` refusal). Every argv is
appended to ``visuals-calls.jsonl``.
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
HISTORY = "render/visuals/clearance-history.json"
ACKNOWLEDGEMENT = (
    "I reviewed the source and licence of this exact image and take responsibility for this "
    "rights decision. The tool did not verify it and it is not legal advice."
)
BASES = ("license_confirmed_at_source", "public_domain_confirmed", "permission_obtained",
         "own_work", "provider_terms_reviewed")  # fmt: skip
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
    clear = _clearances(root, cands)
    by_id = {c["id"]: c for c in cands}
    sel_scenes = {
        x["scene_id"]: x.get("shots") or [] for x in (selection or {}).get("scenes") or []
    }
    for x in (selection or {}).get("rights_clearances") or []:
        if x.get("candidate_id") in by_id:
            integrity[x["candidate_id"]] = _integrity(root, by_id[x["candidate_id"]])
    applied_scenes = (applied or {}).get("scenes") or {}
    scenes, facts, rep_scenes, errors, unpublishable = [], {}, [], [], []
    for sc in _scenes(root):
        shots = sc.get("shots") or []
        choices = sel_scenes.get(sc["id"]) or []
        would = None
        if choices and all(by_id.get(ch["candidate_id"], {}).get("sha256") for ch in choices):
            would = [_shot(ch, by_id[ch["candidate_id"]]) for ch in choices]
        state_ = _apply_state(shots, would, applied_scenes.get(sc["id"]), bool(choices))
        scenes.append({
            "scene_id": sc["id"], "apply_state": state_, "draft_shots": shots,
            "selection_shots": would, "applied_shots": applied_scenes.get(sc["id"]),
        })  # fmt: skip
        valid, blockers = 0, []
        for ch in choices:
            c = by_id.get(ch["candidate_id"])
            if c is None:
                errors.append(f"{sc['id']}: unknown candidate {ch['candidate_id']!r}")
                continue
            if _integrity(root, c) != "ok":
                errors.append(
                    f"{sc['id']}: image file for {c['id']} is missing or its bytes changed"
                )
                continue
            valid += 1
            if not _verified(c, clear):
                why = f"{c['id']}: rights {c['rights']['status']}"
                blockers.append(why)
                unpublishable.append(f"{c['id']} ({sc['id']}): rights {c['rights']['status']}")
        via = (
            "selection"
            if choices and valid == len(choices)
            else ("existing_shots" if not choices and shots else None)
        )
        rep_scenes.append({
            "scene_id": sc["id"],
            "disposition": "candidates_available" if by_scene.get(sc["id"]) else "no_candidates",
            "messages": [], "selected": [ch["candidate_id"] for ch in choices],
            "render_ready": via is not None, "ready_via": via, "publication_blockers": blockers,
            "next_action": "review the selected image(s) and credits" if via == "selection"
            else "choose candidate id(s) in visual-selection.json",
        })  # fmt: skip
        for shot in shots:
            aid = shot.get("asset_id")
            if aid:
                facts.setdefault(aid, {"asset_id": aid, "scene_ids": []})["scene_ids"].append(
                    sc["id"]
                )
    asset_facts = [_asset_fact(root, f, assets, applied, by_id, clear) for f in facts.values()]
    history, history_problems = _history(root)
    plan = _read(root, PLAN, None)
    g1 = "not_approved"
    if (root / "review.json").is_file():
        stale = (applied or {}).get("review_sha") == _sha(root / "review.json")
        g1 = "stale_after_apply" if stale else "approved"
    render_ready = bool(rep_scenes) and all(x["render_ready"] for x in rep_scenes) and not errors
    g3 = _g3(plan, errors, rep_scenes, render_ready, unpublishable, scenes, asset_facts)
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
        "clearance_history": history,
        "clearance_history_problems": history_problems,
        "applied": applied,
        "integrity": integrity,
        "scenes": scenes,
        "assets": asset_facts,
        "report": {
            "schema_version": "m4-visual-report-0.1",
            "command": "visuals-state",
            "render_ready": render_ready,
            "totals": {"scenes": len(scenes), "candidates": len(cands)},
            "errors": errors,
            "warnings": [],
            "scenes": rep_scenes,
            "unpublishable": unpublishable,
            "image_integrity": [],
            "credits": [],
        },
        "gates": {"g1": {"status": g1, "findings": []}, "g3": g3},
    }


def _fingerprint(c: dict) -> str:
    return sha256_json(c.get("rights") or {})


def _shot(choice: dict, c: dict) -> dict:
    out = {"asset_id": f"img-{c['sha256'][:16]}", "motion": choice.get("motion") or "slow_zoom",
           "fit": choice.get("fit") or "auto"}  # fmt: skip
    if choice.get("duration_seconds") is not None:
        out["duration_seconds"] = choice["duration_seconds"]
    return out


def _apply_state(draft: list, would: list | None, applied: list | None, selected: bool) -> str:
    if not selected:
        return "existing_shots" if draft else "none"
    if would is not None and draft == would:
        return "applied_current"
    if applied is None:
        return "draft_edited" if draft else "selected_not_applied"
    return "changed_since_apply" if draft == applied else "draft_edited"


def _evidence_ok(root: Path, x: dict) -> bool:
    ref = str(x.get("evidence") or "").strip()
    if ref.startswith(("http://", "https://")):
        return True
    p = root / ref
    if not ref or ref.startswith("/") or ".." in ref.split("/") or not p.is_file():
        return False
    return x.get("evidence_sha256") in (None, _sha(p))


def _clearances(root: Path, cands: list[dict]) -> dict[str, dict]:
    """Valid clearances by candidate: bound to its bytes, fingerprint and evidence."""
    by_id = {c["id"]: c for c in cands}
    out = {}
    for x in (_read(root, SELECTION, {}) or {}).get("rights_clearances") or []:
        c = by_id.get(x.get("candidate_id"))
        if (
            c is not None
            and x.get("candidate_sha256") == c.get("sha256")
            and x.get("rights_fingerprint") == _fingerprint(c)
            and _evidence_ok(root, x)
        ):
            out[c["id"]] = x
    return out


def _verified(c: dict, clear: dict) -> bool:
    if c.get("placeholder") or c["rights"]["status"] in ("rejected", "not_applicable"):
        return False
    if c["rights"]["status"] == "accepted":
        return True
    return c["rights"]["status"] == "manual_review" and c["id"] in clear


def _history(root: Path) -> tuple[dict | None, list[str]]:
    doc = _read(root, HISTORY, None)
    want = (_read(root, MANIFEST, {}) or {}).get("clearance_history_sha256")
    have = _sha(root / HISTORY)
    if have != want:
        return doc, [f"{HISTORY} was modified outside the tool"]
    return doc, []


def _rights_reason(root: Path, rec: dict, bound: list[str], by_id: dict, clear: dict) -> str | None:
    if not rec.get("rights_verified"):
        return "not_verified"
    if not bound or any(b not in by_id for b in bound):
        return "candidate_missing"
    bad = [by_id[b] for b in bound if not _verified(by_id[b], clear)]
    if not bad:
        return None
    entries = (_read(root, HISTORY, {}) or {}).get("entries") or []
    last = [e for e in entries if e.get("candidate_id") == bad[0]["id"]]
    if last and last[-1].get("action") == "revoked":
        return "clearance_revoked"
    raw = next((x for x in (_read(root, SELECTION, {}) or {}).get("rights_clearances") or []
                if x.get("candidate_id") == bad[0]["id"]), None)  # fmt: skip
    if raw is not None and not _evidence_ok(root, raw):
        return (
            "evidence_changed"
            if (root / str(raw.get("evidence"))).is_file()
            else "clearance_invalid"
        )
    return "rights_changed"


def _asset_fact(root: Path, f: dict, assets: dict, applied: dict | None, by_id: dict,
                clear: dict) -> dict:  # fmt: skip
    aid = f["asset_id"]
    rec = assets.get(aid)
    rel = (rec or {}).get("local_path")
    sha = Path(rel).stem if rel else None
    p = root / rel if rel else None
    image = (
        None if not rel
        else "missing" if not (p.is_file() or p.is_symlink())
        else ("ok" if _sha(p) == sha else "mismatch")
    )  # fmt: skip
    intact = bool(rec) and (applied or {}).get("assets", {}).get(aid) == sha256_json(rec)
    bound = ((applied or {}).get("asset_candidates") or {}).get(aid) or []
    if rec is None:
        problem = "not in assets.json"
    elif not rec.get("rights_verified"):
        problem = "rights not verified"
    elif not intact:
        problem = "assets.json record was not written by visuals-apply (or was edited)"
    elif image == "missing":
        problem = "image file missing"
    elif image != "ok":
        problem = "image bytes no longer match their content address"
    else:
        problem = None
    reason = _rights_reason(root, rec, bound, by_id, clear) if rec else "candidate_missing"
    return {
        **f, "candidate_id": bound[0] if len(bound) == 1 else None,
        "candidate_ids": sorted(bound), "candidate_binding": "recorded" if bound else "missing",
        "sha256": sha, "local_path": rel, "image": image, "record_intact": intact,
        "problem": problem, "credit_problems": [], "fixture": bool((rec or {}).get("fixture")),
        "rights_current": reason is None, "rights_reason": reason,
    }  # fmt: skip


def _finding(code: str, detail: str, nxt: str | None = None, artifact: str | None = None) -> dict:
    return {"severity": "blocker", "stage": "visuals", "code": code, "artifact": artifact,
            "detail": detail, "next_action": nxt}  # fmt: skip


def _g3(plan, errors, rep_scenes, render_ready, unpublishable, scenes, facts) -> dict:  # noqa: ANN001
    if plan is None:
        return {
            "status": "pending",
            "findings": [
                _finding(
                    "visuals_not_started", "no visual-plan.json", "ytagent resume --through visuals"
                )
            ],
        }
    out = [_finding("visuals_invalid", e, "ytagent visuals-check") for e in errors]
    if not render_ready:
        missing = [x["scene_id"] for x in rep_scenes if not x["render_ready"]]
        out.append(
            _finding(
                "visuals_selection_needed",
                f"G3: {len(missing)} scene(s) have no selected, applied image: "
                + ", ".join(missing[:10]),
                "choose candidates in visual-selection.json, ytagent visuals-check, visuals-apply",
            )
        )
    nxt = "record a rights clearance or choose another image"
    out += [_finding("image_rights_not_cleared", u, nxt)
            for u in unpublishable]  # fmt: skip
    pending_ = [x for x in scenes if x["apply_state"] in
                ("selected_not_applied", "changed_since_apply", "draft_edited")]  # fmt: skip
    if pending_:
        out.append(
            _finding(
                "visuals_not_applied",
                f"G3: {len(pending_)} scene(s) do not show their selection in the draft: "
                + ", ".join(f"{x['scene_id']} ({x['apply_state']})" for x in pending_[:10]),
                "ytagent visuals-apply, then draft-approve",
                "storyboard.draft.json",
            )
        )
    for a in facts:
        where = f"{a['asset_id']} ({', '.join(a['scene_ids'])})"
        if a["problem"]:
            out.append(
                _finding(
                    "applied_image_problem",
                    f"{where}: {a['problem']}",
                    "choose another image or ytagent visuals-apply again",
                    "assets.json",
                )
            )
        elif not a["rights_current"]:
            revoked = a["rights_reason"] == "clearance_revoked"
            out.append(
                _finding(
                    "image_rights_not_cleared" if revoked else "applied_image_problem",
                    f"{where}: "
                    + (
                        "the rights clearance of the image it was applied from was revoked"
                        if revoked
                        else f"its rights are not current ({a['rights_reason']})"
                    ),
                    "record a new rights clearance or choose another image",
                    "assets.json",
                )
            )
    return {"status": "ready" if not out else "needs_review", "findings": out}


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
                # The draft's visual_brief is an object; the engine's plan brief is its text.
                "brief": (s.get("visual_brief") or {}).get("description")
                if isinstance(s.get("visual_brief"), dict)
                else f"Visual for {s['id']}.",
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
    keep = (_read(root, MANIFEST, {}) or {}).get("clearance_history_sha256")
    man = {"files": {rel: _sha(root / rel) for rel in (CANDIDATES, PROVENANCE)}}
    if keep:
        man["clearance_history_sha256"] = keep
    _write(root, MANIFEST, man)
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


def _words(text: str) -> int:
    return len([w for w in str(text).split() if len(w) > 1])


def _edit(root: Path, o: dict, mode: str) -> int:
    raw = sys.stdin.buffer.read(1024 * 1024 + 1)
    with open(root / "visuals-edit-stdin.json", "wb") as fh:
        fh.write(raw)
    if "expect-revision" not in o:
        return _error("invalid_input", 2, "visuals-edit needs --expect-revision")
    if (refused := _guard(root, o)) is not None:
        return refused
    if mode == "visuals_edit_race":
        return _error("concurrency", 9, "the project changed on every read attempt; try again")
    try:
        patch = json.loads(raw)
        ops = patch["operations"]
        assert isinstance(ops, list) and ops
    except (ValueError, KeyError, AssertionError):
        return _error("invalid_patch", 2, "the patch is invalid",
                      details=[{"loc": "operations", "msg": "invalid",
                                "code": "invalid"}])  # fmt: skip
    if not (root / "review.json").is_file():
        return _error("g1_not_current", 12, "the draft is not approved (G1)")
    trusted, _ = _catalog(root)
    if not trusted:
        return _error("catalog_untrusted", 2, "the candidate catalogue is not trusted")
    history, problems = _history(root)
    if problems:
        return _error(
            "invalid_patch", 2,
            f"{HISTORY} is not intact: {problems[0]}; every edit is refused until it is restored",
            details=[{"loc": HISTORY, "msg": problems[0], "code": "history_tampered"}],
        )  # fmt: skip
    cands = (_read(root, CANDIDATES, {}) or {}).get("candidates") or []
    by_id = {c["id"]: c for c in cands}
    sel = _read(root, SELECTION, None) or {"schema_version": "m4-visual-selection-0.1",
                                           "scenes": [], "rights_clearances": []}  # fmt: skip
    plan = _read(root, PLAN, None)
    before = (json.dumps(sel, sort_keys=True), json.dumps(plan, sort_keys=True))
    entries = list((history or {}).get("entries") or [])
    added, errs, touched = [], [], set()
    scene_ids = {x["id"] for x in _scenes(root)}

    def fail(i: int, op: dict, code: str, msg: str) -> None:
        errs.append({"loc": f"operations.{i}", "msg": msg, "code": code, "op": op.get("op")})

    def scene_entry(sid: str) -> dict:
        for x in sel["scenes"]:
            if x["scene_id"] == sid:
                return x
        x = {"scene_id": sid, "shots": [], "note": ""}
        sel["scenes"].append(x)
        return x

    integrity_bad = []
    for i, op in enumerate(ops):
        kind = op.get("op")
        if kind in ("shots.set", "shots.clear"):
            if op.get("scene_id") not in scene_ids:
                fail(i, op, "unknown_scene", f"unknown scene {op.get('scene_id')!r}")
                continue
            if kind == "shots.clear":
                scene_entry(op["scene_id"])["shots"] = []
                touched.add(SELECTION)
                continue
            shots = []
            for sh in op.get("shots") or []:
                c = by_id.get(sh.get("candidate_id"))
                if c is None:
                    fail(
                        i, op, "unknown_candidate", f"unknown candidate {sh.get('candidate_id')!r}"
                    )
                    break
                if not c.get("selectable"):
                    fail(i, op, "not_selectable", f"candidate {c['id']} cannot be used")
                    break
                if _integrity(root, c) != "ok":
                    integrity_bad.append(c["id"])
                shots.append({k: v for k, v in sh.items() if v is not None})
            else:
                scene_entry(op["scene_id"])["shots"] = shots
                touched.add(SELECTION)
        elif kind == "clearance.set":
            c = by_id.get(op.get("candidate_id"))
            if c is None:
                fail(i, op, "unknown_candidate", f"unknown candidate {op.get('candidate_id')!r}")
                continue
            if c.get("placeholder") or c["rights"]["status"] != "manual_review":
                fail(i, op, "not_clearable", f"{c['id']} is not a manual_review image")
                continue
            if (op.get("expected_candidate_sha256") != c["sha256"]
                    or op.get("expected_rights_fingerprint") != _fingerprint(c)):  # fmt: skip
                fail(i, op, "target_changed", f"the image or rights evidence of {c['id']} changed "
                     "since you reviewed it: review it again")  # fmt: skip
                continue
            problems_ = []
            if op.get("basis") not in BASES:
                problems_.append("basis is not allowed")
            if _words(op.get("justification", "")) < 6:
                problems_.append("justification must explain the decision (at least ~6 real words)")
            if (op.get("acknowledgement") or "").strip() != ACKNOWLEDGEMENT:
                problems_.append("acknowledgement must be exactly the text given in the template")
            ev = str(op.get("evidence") or "").strip()
            local = not ev.startswith(("http://", "https://"))
            if local and not (root / ev).is_file():
                problems_.append(f"evidence {ev!r} is not a file in the project")
            if problems_:
                fail(i, op, "clearance_invalid", "; ".join(problems_))
                continue
            if _integrity(root, c) != "ok":
                integrity_bad.append(c["id"])
            old = next((x for x in sel["rights_clearances"] if x["candidate_id"] == c["id"]), None)
            rec = {"candidate_id": c["id"], "decision": "cleared", "reviewer": op["reviewer"],
                   "decided_at": "2026-11-27T12:00:00Z", "basis": op["basis"],
                   "justification": op["justification"], "evidence": ev,
                   "acknowledgement": op["acknowledgement"], "candidate_sha256": c["sha256"],
                   "rights_fingerprint": _fingerprint(c)}  # fmt: skip
            if local:
                rec["evidence_sha256"] = _sha(root / ev)
            sel["rights_clearances"] = [x for x in sel["rights_clearances"]
                                        if x["candidate_id"] != c["id"]] + [rec]  # fmt: skip
            added.append((i, "replaced" if old else "set", c["id"], op["reviewer"], None, rec))
            touched |= {SELECTION, HISTORY, MANIFEST}
        elif kind == "clearance.revoke":
            old = next((x for x in sel["rights_clearances"]
                        if x["candidate_id"] == op.get("candidate_id")), None)  # fmt: skip
            if old is None:
                fail(
                    i,
                    op,
                    "unknown_clearance",
                    f"no rights clearance for {op.get('candidate_id')!r}",
                )
                continue
            if _words(op.get("reason", "")) < 6:
                fail(
                    i,
                    op,
                    "reason_too_thin",
                    "reason must explain the decision (at least ~6 real words)",
                )
                continue
            sel["rights_clearances"] = [x for x in sel["rights_clearances"] if x is not old]
            added.append((i, "revoked", old["candidate_id"], op["reviewer"], op["reason"], None))
            touched |= {SELECTION, HISTORY, MANIFEST}
        elif kind == "plan.update":
            ps = next(
                (
                    x
                    for x in (plan or {}).get("scenes") or []
                    if x["scene_id"] == op.get("scene_id")
                ),
                None,
            )
            if ps is None:
                fail(i, op, "unknown_scene", f"unknown scene {op.get('scene_id')!r}")
                continue
            if op.get("search_enabled") is True and not ps["search_enabled"]:
                fail(i, op, "not_narrowing", f"visual-plan.json {ps['scene_id']}: search_enabled "
                     f"cannot be switched on for a {ps['desired_kind']} scene")  # fmt: skip
                continue
            if op.get("generation_enabled") is True:
                fail(i, op, "not_narrowing", "generation cannot be switched on")
                continue
            for k in ("search_query", "search_enabled", "generation_enabled", "notes"):
                if k in op:
                    ps[k] = op[k]
            touched.add(PLAN)
        else:
            fail(i, op, "invalid", f"unknown operation {kind!r}")
    if errs:
        e = errs[0]
        return _error(
            "invalid_patch",
            2,
            f"operation {e['loc'].split('.')[1]} ({e['op']}) refused: {e['msg']}",
            details=[{k: e[k] for k in ("loc", "msg", "code")} for e in errs],
        )
    if integrity_bad:
        return _error("image_integrity", 2, f"image file for {integrity_bad[0]} is missing or its "
                      "bytes changed", details={"candidate_ids": integrity_bad})  # fmt: skip
    after = (json.dumps(sel, sort_keys=True), json.dumps(plan, sort_keys=True))
    changed = sorted(touched) if after != before or added else []
    hist_out = []
    prev = sha256_json(entries[-1]) if entries else None
    for i, action, cid, who, reason, rec in added:
        entry = {"id": f"ch-{len(entries) + 1:05d}", "seq": len(entries) + 1, "prev_sha256": prev,
                 "action": action, "candidate_id": cid, "at": "2026-11-27T12:00:00Z",
                 "by_reviewer": who, "reason": reason, "clearance": rec}  # fmt: skip
        entries.append(entry)
        prev = sha256_json(entry)
        hist_out.append({"op_index": i, "id": entry["id"], "action": action, "candidate_id": cid})
    previous = revision(root)
    dry = "dry-run" in o
    if not dry and changed:
        _write(root, SELECTION, sel)
        if PLAN in touched:
            _write(root, PLAN, plan)
        if added:
            _write(root, HISTORY, {"schema_version": "m4-clearance-history-1", "entries": entries})
            man = _read(root, MANIFEST, {}) or {}
            man["clearance_history_sha256"] = _sha(root / HISTORY)
            _write(root, MANIFEST, man)
    st = state(root)
    out = {"ok": True,
           "status": ("would_publish" if dry else "published") if changed else "already_current",
           "dry_run": dry, "previous_revision": previous,
           "revision": previous if dry or not changed else revision(root),
           "changed_files": changed, "history": hist_out,
           "check": {k: st["report"][k]
                     for k in ("render_ready", "errors", "unpublishable")}}  # fmt: skip
    print(json.dumps(out, indent=2))
    return 0


def _apply(root: Path, o: dict, mode: str) -> int:
    if (refused := _guard(root, o)) is not None:
        return refused
    if not o.get("reviewer"):
        return _error("invalid_input", 2, "--reviewer is required")
    if mode == "visuals_apply_not_ready":
        msg = ("img-0123456789abcdef would get two different rights records (scene-001-imp-a, "
               "scene-002-imp-b; scenes scene-001, scene-002)")  # fmt: skip
        return _error(
            "not_ready", 2, f"cannot apply visuals:\n  - {msg}", details={"errors": [msg]}
        )
    cands = (_read(root, CANDIDATES, {}) or {}).get("candidates") or []
    by_id = {c["id"]: c for c in cands}
    clear = _clearances(root, cands)
    sel = _read(root, SELECTION, {}) or {}
    choices = {
        x["scene_id"]: x.get("shots") or [] for x in sel.get("scenes") or [] if x.get("shots")
    }
    if not choices:
        return _error("not_ready", 2, "nothing is selected in visual-selection.json")
    sb = _read(root, "storyboard.draft.json", {}) or {}
    applied = _read(root, APPLIED, None) or {"assets": {}, "scenes": {}, "asset_candidates": {}}
    assets_doc = _read(root, ASSETS, None) or {"assets": {}}
    records = assets_doc.setdefault("assets", {})
    conflicts, bad, changed, added, unchanged, unverified, restored = [], [], [], [], [], [], []
    for scene in sb.get("scenes") or []:
        picks = choices.get(scene["id"])
        if not picks:
            continue
        shots = []
        for ch in picks:
            c = by_id.get(ch["candidate_id"])
            if c is None or _integrity(root, c) != "ok":
                bad.append(ch["candidate_id"])
                continue
            shots.append(_shot(ch, c))
        current = scene.get("shots") or []
        if current and current != shots and current != applied["scenes"].get(scene["id"]):
            conflicts.append(f"{scene['id']} has shots that visuals-apply did not write "
                             "(human-authored); pass --replace-shots to replace them")  # fmt: skip
        if current != shots:
            changed.append(scene["id"])
        scene["_new"] = shots
    if bad:
        return _error("image_integrity", 2,
                      f"image file for {bad[0]} is missing or its bytes changed",
                      details={"candidate_ids": bad})  # fmt: skip
    if conflicts:
        return _error("human_edit_conflict", 2, "nothing was applied:\n" +
                      "\n".join(f"  - {c}" for c in conflicts))  # fmt: skip
    for scene in sb.get("scenes") or []:
        shots = scene.pop("_new", None)
        if shots is None:
            continue
        for ch, shot in zip(choices[scene["id"]], shots, strict=True):
            c = by_id[ch["candidate_id"]]
            aid = shot["asset_id"]
            rel = f"assets/images/{c['sha256']}.png"
            dest = root / rel
            if not dest.is_file():
                if aid in records:
                    restored.append(aid)
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes((root / c["local_path"]).read_bytes())
            ok = _verified(c, clear)
            rec = {"id": aid, "kind": c.get("kind"), "local_path": rel,
                   "source_url": c.get("source_page_url"), "creator": c["rights"].get("creator"),
                   "license_name": c["rights"].get("license_name"),
                   "license_url": c["rights"].get("license_url"),
                   "attribution": c["rights"].get("credit_line"), "rights_verified": ok,
                   "rights_basis": ("human_attestation" if c["id"] in clear else "licence_metadata")
                   if ok else None, "fixture": bool(c.get("placeholder"))}  # fmt: skip
            (unchanged if records.get(aid) == rec else added).append(aid)
            if not ok:
                unverified.append(aid)
            records[aid] = rec
            applied["assets"][aid] = sha256_json(rec)
            applied.setdefault("asset_candidates", {})[aid] = sorted(
                set(applied["asset_candidates"].get(aid, [])) | {c["id"]}
            )
        scene["shots"] = shots
        applied["scenes"][scene["id"]] = shots
    status = (
        "published" if changed or added else ("images_restored" if restored else "already_current")
    )
    written = []
    if status == "published":
        _write(root, "storyboard.draft.json", sb)
        _write(root, ASSETS, assets_doc)
        applied["review_sha"] = _sha(root / "review.json")
        _write(root, APPLIED, applied)
        written = ["storyboard.draft.json", ASSETS, APPLIED]
    print("applied the visual selection", file=sys.stderr, flush=True)
    st = state(root)
    out = {"ok": True, "status": status, "run_id": "fake-apply", "scenes_changed": changed,
           "assets_added": sorted(set(added)),
           "assets_unchanged": sorted(set(unchanged) - set(added)),
           "rights_unverified": sorted(set(unverified)), "written": written,
           "report": st["report"], "images_restored": restored,
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
    if cmd == "visuals-edit":
        return _edit(root, o, mode)
    if cmd == "visuals-apply":
        return _apply(root, o, mode)
    print(f"error: unknown command {cmd}", file=sys.stderr)
    return 2
