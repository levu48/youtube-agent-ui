"""Research commands of the fake engine (mirrors engine D-118 at fb6bffc, simplified).

``research-check --json`` reports the research revision; ``research-plan``, ``-collect``
(with ``--dry-run`` fetch plan and ``--allow-host``) and ``-add-url`` take
``--expect-revision`` and answer with ``--json`` results or the error envelope. Modes:
``research_race`` (a research file changes after the revision is checked, as during a
network phase: the command then refuses with ``revision_mismatch``), ``research_slow``
(collect prints a progress line every 0.05 s for ~20 s, for cancel tests).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

FILES = (
    "input.json",
    "outline.json",
    "script.json",
    "research-plan.json",
    "evidence.json",
    "research-review.json",
    "research.json",
    "render/research/snapshots.json",
    "research-approval.json",
    "render/llm/narration-provenance.json",
)
SEARCH_HOST = "search.fixture.invalid"
RESULT_HOST = "archive.fixture.invalid"
PAGE = "Ngày 2 tháng 9 năm 1945, tại Quảng trường Ba Đình, Hồ Chí Minh đọc bản Tuyên ngôn Độc lập."


def _sha(p: Path) -> str | None:
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None


def revision(root: Path) -> str:
    files = {rel: _sha(root / rel) for rel in FILES}
    blob = json.dumps(
        {"files": files, "narration_fingerprint": None, "scheme": "m5-research-revision-1"},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(blob.encode()).hexdigest()


def _error(code: str, exit_code: int, message: str, **extra) -> int:
    print(
        json.dumps(
            {
                "ok": False,
                "error": {"code": code, "exit_code": exit_code, "message": message, **extra},
            }
        )
    )
    print(f"error: {message}", file=sys.stderr)
    return exit_code


def _read(root: Path, rel: str, default):  # noqa: ANN001, ANN202
    p = root / rel
    return json.loads(p.read_text("utf-8")) if p.is_file() else default


def _write(root: Path, rel: str, data) -> None:  # noqa: ANN001
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")


def _expect(root: Path, o: dict) -> int | None:
    want = o.get("expect-revision")
    current = revision(root)
    if want is not None and want != current:
        return _error(
            "revision_mismatch",
            9,
            f"research revision mismatch: expected {want} but the current revision is {current}",
            current_revision=current,
        )
    return None


def _race(root: Path, mode: str, o: dict) -> int | None:
    """After the network phase: refuse when anything changed meanwhile (D-118)."""
    if mode == "research_race":
        rv = root / "research-review.json"
        rv.write_text(rv.read_text("utf-8") + "\n" if rv.is_file() else "{}\n", "utf-8")
        return _expect(root, o)
    return None


def _claims(root: Path) -> list[dict]:
    return _read(root, "research-plan.json", {}).get("claims", [])


def check(root: Path) -> int:
    plan = _read(root, "research-plan.json", None)
    items = (
        []
        if plan
        else [
            {
                "code": "plan_missing",
                "claim_id": None,
                "blocking": True,
                "detail": "research-plan.json is missing (run research-plan)",
            }
        ]
    )
    import fake_research_edit as E

    claims = []
    rf = E.review_file(root)
    links = _read(root, "evidence.json", {"links": []}).get("links", [])
    index = _read(root, "render/research/snapshots.json", {"snapshots": {}})["snapshots"]

    def ref(x: dict) -> dict:
        snap = index.get(x["snapshot_id"]) or {}
        return {
            "snapshot_id": x["snapshot_id"],
            "source_id": snap.get("source_id"),
            "start": x["start"],
            "end": x["end"],
            "source_type": x.get("source_type", "unknown"),
            "acquisition": snap.get("acquisition"),
            "evidence_root": x.get("evidence_root") or snap.get("source_id"),
            "is_translation": bool(x.get("is_translation")),
            "translator": x.get("translator"),
            "translation_of": None,
        }

    if not E.history_ok(rf):
        items.append(
            {
                "code": "history_tampered",
                "claim_id": None,
                "blocking": True,
                "detail": "research-review.json history is not intact",
            }
        )
    for c in (plan or {}).get("claims", []):
        mine = [x for x in links if x["claim_id"] == c["id"]]
        review = next((r for r in rf["reviews"] if r["claim_id"] == c["id"]), None)
        outdated: list[str] = []
        if review is not None:
            basis = review.get("basis")
            if not basis:
                outdated = ["basis_missing"]
            else:
                if basis.get("claim") != E.claim_basis(c):
                    outdated.append("claim")
                was, now = basis.get("evidence") or {}, {x["id"]: E.link_basis(x) for x in mine}
                outdated += [f"evidence.added:{k}" for k in now if k not in was]
                outdated += [f"evidence.removed:{k}" for k in was if k not in now]
                outdated += [f"evidence.changed:{k}" for k in now if k in was and was[k] != now[k]]
        if outdated:
            items.append(
                {
                    "code": "review_outdated",
                    "claim_id": c["id"],
                    "blocking": True,
                    "detail": f"{c['id']}: the {review['status']} decision was made on a different "
                    "claim or evidence; record a new decision",
                    "refs": {"components": outdated, "outdated_status": review["status"]},
                }
            )
        current = None if outdated else review
        claims.append(
            {
                "id": c["id"],
                "kind": c["kind"],
                "assertion": c["assertion"],
                "contested": bool(c.get("contested")),
                "flags": list(c.get("flags") or []),
                "status": current["status"] if current else "unverified",
                "suggested_status": "supported_pending_review"
                if any(x["role"] == "supports" for x in mine)
                else "unverified",
                "scenes": sorted({a["scene_id"] for a in c.get("anchors", [])}),
                "supports": [ref(x) for x in mine if x["role"] == "supports"],
                "contradicts": [ref(x) for x in mine if x["role"] == "contradicts"],
                "context": [ref(x) for x in mine if x["role"] in ("context", "mentions_only")],
                "independent_roots": len(
                    {x["snapshot_id"] for x in mine if x["role"] == "supports"}
                ),
                "quotation_basis": None,
                "reviewer": current["reviewer"] if current else None,
                "rationale": current["rationale"] if current else None,
                "counterargument_summary": current.get("counterargument_summary")
                if current
                else None,
                "review_outdated": outdated,
                "outdated_review": {
                    "status": review["status"],
                    "reviewer": review.get("reviewer"),
                    "reviewed_at": review.get("reviewed_at"),
                }
                if outdated
                else None,
            }
        )
        if not mine:
            items.append(
                {
                    "code": "no_sources",
                    "claim_id": c["id"],
                    "blocking": True,
                    "detail": f"{c['id']}: no sources collected or linked",
                }
            )
    if plan:
        comp = rf.get("completeness")
        if comp is None:
            items.append(
                {
                    "code": "completeness_missing",
                    "claim_id": None,
                    "blocking": True,
                    "detail": "no completeness attestation",
                }
            )
        elif comp.get("inventory_fingerprint") != E.inventory(plan):
            items.append(
                {
                    "code": "completeness_stale",
                    "claim_id": None,
                    "blocking": True,
                    "detail": "the completeness attestation is for a different claim inventory",
                }
            )
    items += E.lineage_items(root)
    import fake_research_g2 as G

    items += G.extra_items(root, claims)
    approvable = bool(plan) and not any(i["blocking"] for i in items)
    approval_status, applied = G.state(root)
    report = {
        "schema_version": "m5-report-0.1",
        "generated_at": "1970-01-01T00:00:00Z",
        "approvable": approvable,
        "approval_status": approval_status,
        "applied": applied,
        "narration_fingerprint": None,
        "counts": {"claims": len(claims), "blocking_items": len(items)},
        "items": items,
        "claims": claims,
        "coverage": {"sentences": len(claims), "covered": len(claims), "uncovered": [], "note": ""},
        "revision": revision(root),
    }
    print(json.dumps(report, ensure_ascii=False))
    return 0 if approvable else 14


def plan(root: Path, o: dict) -> int:
    if (rc := _expect(root, o)) is not None:
        return rc
    if not (root / "review.json").is_file():
        return _error("g1_not_current", 12, "research-plan needs an editorially approved draft")
    if o.get("claim-provider") != "none":
        return _error("invalid_input", 2, "the fake only supports --claim-provider=none")
    script = _read(root, "script.json", {"sections": []})
    claims = []
    for n, sec in enumerate(script.get("sections", []), 1):
        sentence = (sec.get("narration") or "").split(".")[0].strip()
        if sentence:
            claims.append(
                {
                    "id": f"clm-{n:03d}-fake",
                    "assertion": sentence,
                    "kind": "factual",
                    "anchors": [
                        {
                            "scene_id": f"scene-{n:03d}",
                            "start": 0,
                            "end": len(sentence),
                            "excerpt": sentence,
                            "narration_sha256": "0" * 64,
                        }
                    ],
                    "search_queries": [sentence[:60]],
                    "origin": "rule",
                }
            )
    _write(root, "research-plan.json", {"schema_version": "m5-research-plan-0.1", "claims": claims})
    legacy = os.environ.get("FAKE_MODE") == "legacy_review"
    review = (
        {
            "schema_version": "m5-review-0.1",
            "reviews": [
                {
                    "claim_id": claims[0]["id"],
                    "status": "disputed",
                    "reviewer": "Trần Thị B",
                    "rationale": "Recorded before the review policy changed.",
                }
            ],
        }
        if legacy and claims
        else {
            "schema_version": "m5-review-0.2",
            "reviews": [],
            "source_rechecks": [],
            "history": [],
            "primary_source_attestations": [],
        }
    )
    for rel, empty in (("evidence.json", {"links": []}), ("research-review.json", review)):
        if not (root / rel).is_file():
            _write(root, rel, empty)
    print(
        json.dumps(
            {
                "ok": True,
                "status": "written",
                "claims": len(claims),
                "uncovered": 0,
                "leads": 0,
                "revision": revision(root),
            }
        )
    )
    return 0


def _targets(root: Path) -> list[dict]:
    record = _read(root, "research.json", {"sources": {}})
    return [
        {
            "source_id": s["id"],
            "url": s["url"],
            "host": s["url"].split("/")[2],
            "reason": "user_supplied" if s.get("user_supplied") else "discovered",
        }
        for s in record.get("sources", {}).values()
        if not s.get("snapshot_ids")
    ]


def collect(root: Path, o: dict, hosts: list[str], mode: str) -> int:
    if (rc := _expect(root, o)) is not None:
        return rc
    if not (root / "research-plan.json").is_file():
        return _error("invalid_input", 2, "no research-plan.json: run research-plan first")
    queries = len(_claims(root))
    targets = _targets(root)
    search_hosts = [SEARCH_HOST] if queries else []
    result_hosts = [RESULT_HOST] if queries else []
    all_hosts = sorted({*search_hosts, *result_hosts, *(t["host"] for t in targets)})
    if "dry-run" in o:
        rev = revision(root)
        plan_sha = hashlib.sha256(
            json.dumps([rev, sorted(o.items()), all_hosts]).encode()
        ).hexdigest()
        print(
            json.dumps(
                {
                    "ok": True,
                    "dry_run": True,
                    "revision": rev,
                    "search_provider": o.get("search-provider"),
                    "fetch": True,
                    "queries": queries,
                    "search_hosts": search_hosts,
                    "provider_result_hosts": result_hosts,
                    "known_targets": targets,
                    "hosts": all_hosts,
                    "plan_sha256": plan_sha,
                }
            )
        )
        return 0
    if not hosts:
        return _error(
            "invalid_input", 2, "research-collect contacts the network: pass --allow-host"
        )
    for n in range(400 if mode == "research_slow" else 0):
        print(f"search vi 'q{n}': 0 hits", file=sys.stderr, flush=True)
        time.sleep(0.05)
    print(f"search vi {queries} queries", file=sys.stderr)
    if (rc := _race(root, mode, o)) is not None:
        return rc
    record = _read(root, "research.json", {"schema_version": "m5-research-0.2", "sources": {}})
    index = _read(
        root,
        "render/research/snapshots.json",
        {"schema_version": "m5-snapshots-0.2", "snapshots": {}},
    )
    fetched = refused = 0
    if RESULT_HOST in hosts and queries:
        url = f"https://{RESULT_HOST}/tuyen-ngon-1945"
        record["sources"].setdefault(
            "src-archive000001",
            {
                "id": "src-archive000001",
                "kind": "web",
                "url": url,
                "state": "discovered",
                "snapshot_ids": [],
                "candidate_for": [c["id"] for c in _claims(root)],
            },
        )
    for src in record["sources"].values():
        if src.get("snapshot_ids") or src.get("kind") == "document":
            continue
        host = src["url"].split("/")[2]
        if host not in hosts:
            refused += 1
            src.setdefault("fetches", []).append({"outcome": "host_not_allowed"})
            print(f"fetch {src['url']}: host_not_allowed", file=sys.stderr)
            continue
        _snapshot(root, index, src)
        fetched += 1
        print(f"fetch {src['url']}: fetched", file=sys.stderr)
    _write(root, "research.json", record)
    _write(root, "render/research/snapshots.json", index)
    print(
        json.dumps(
            {
                "ok": True,
                "run_id": "fake",
                "searches": queries,
                "hits": queries,
                "fetched": fetched,
                "reused": 0,
                "failures": {},
                "new_snapshots": fetched,
                "host_not_allowed": refused,
                "revision": revision(root),
            }
        )
    )
    return 0


def _snapshot(root: Path, index: dict, src: dict) -> None:
    data = PAGE.encode()
    sha = hashlib.sha256(data).hexdigest()
    page = root / "render/research/pages" / f"{sha}.txt"
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_bytes(data)
    snap_id = "snap-" + hashlib.sha256(f"{src['id']}|{sha}".encode()).hexdigest()[:16]
    index["snapshots"][snap_id] = {
        "id": snap_id,
        "source_id": src["id"],
        "acquisition": "fixture",
        "requested_url": src["url"],
        "final_url": src["url"],
        "retrieved_at": "2026-11-22T00:00:00Z",
        "title": "Tuyên ngôn Độc lập (thử nghiệm)",
        "language": "vi",
        "text_path": f"render/research/pages/{sha}.txt",
        "text_sha256": sha,
        "chars": len(PAGE),
        "limitations": ["FIXTURE TEST DATA"],
        "fixture": True,
    }
    src["snapshot_ids"] = [snap_id]
    src["state"] = "extracted"
    src.setdefault("fetches", []).append({"outcome": "fetched", "snapshot_id": snap_id})


def add_url(root: Path, o: dict, hosts: list[str], mode: str) -> int:
    if (rc := _expect(root, o)) is not None:
        return rc
    url = o["url"]
    if not url.startswith("https://"):
        return _error("invalid_input", 2, "only https URLs")
    fetch = o.get("fetch", "live")
    if fetch == "live" and not hosts:
        return _error("invalid_input", 2, "research-add-url --fetch live contacts the network")
    if (rc := _race(root, mode, o)) is not None:
        return rc
    record = _read(root, "research.json", {"schema_version": "m5-research-0.2", "sources": {}})
    index = _read(
        root,
        "render/research/snapshots.json",
        {"schema_version": "m5-snapshots-0.2", "snapshots": {}},
    )
    sid = "src-" + hashlib.sha256(url.encode()).hexdigest()[:12]
    src = record["sources"].setdefault(
        sid,
        {
            "id": sid,
            "kind": "web",
            "url": url,
            "state": "discovered",
            "user_supplied": True,
            "snapshot_ids": [],
            "candidate_for": [],
        },
    )
    outcome = "queued"
    if fetch in ("live", "fixture"):
        _snapshot(root, index, src)
        outcome = "fetched"
    _write(root, "research.json", record)
    _write(root, "render/research/snapshots.json", index)
    print(
        json.dumps(
            {
                "ok": True,
                "source_id": sid,
                "url": url,
                "outcome": outcome,
                "snapshot_id": src["snapshot_ids"][0] if src["snapshot_ids"] else None,
                "revision": revision(root),
            }
        )
    )
    return 0


def main(cmd: str, root: Path, o: dict, argv: list[str]) -> int:
    mode = os.environ.get("FAKE_MODE", "ok")
    hosts = [a.split("=", 1)[1] for a in argv if a.startswith("--allow-host=")]
    if cmd == "research-check":
        return check(root)
    if cmd == "research-plan":
        return plan(root, o)
    if cmd == "research-collect":
        return collect(root, o, hosts, mode)
    if cmd == "research-add-url":
        return add_url(root, o, hosts, mode)
    import fake_research_edit as E

    if cmd == "research-edit":
        return E.research_edit(root, o, mode)
    if cmd == "research-add-document":
        return E.add_document(root, o)
    if cmd == "narration-attest":
        return E.narration_attest(root, o, argv)
    if cmd == "narration-provenance-init":
        return E.provenance_init(root, o)
    import fake_research_g2 as G

    if cmd == "research-approve":
        return G.approve(root, o, mode)
    if cmd == "research-apply":
        return G.apply(root, o)
    if cmd == "research-export":
        return G.export(root, o)
    return _error("invalid_input", 2, f"unknown command {cmd}")
