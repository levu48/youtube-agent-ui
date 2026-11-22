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
    claims = []
    for c in (plan or {}).get("claims", []):
        claims.append(
            {
                "id": c["id"],
                "kind": c["kind"],
                "assertion": c["assertion"],
                "contested": False,
                "flags": [],
                "status": "unverified",
                "suggested_status": "unverified",
                "scenes": [c["anchors"][0]["scene_id"]],
                "supports": [],
                "contradicts": [],
                "context": [],
                "independent_roots": 0,
                "quotation_basis": None,
                "reviewer": None,
                "rationale": None,
                "counterargument_summary": None,
                "review_outdated": [],
                "outdated_review": None,
            }
        )
        items.append(
            {
                "code": "no_sources",
                "claim_id": c["id"],
                "blocking": True,
                "detail": f"{c['id']}: no sources collected or linked",
            }
        )
    if plan:
        items.append(
            {
                "code": "completeness_missing",
                "claim_id": None,
                "blocking": True,
                "detail": "no completeness attestation",
            }
        )
    report = {
        "schema_version": "m5-report-0.1",
        "generated_at": "1970-01-01T00:00:00Z",
        "approvable": False,
        "approval_status": "not_approved",
        "applied": False,
        "narration_fingerprint": None,
        "counts": {"claims": len(claims), "blocking_items": len(items)},
        "items": items,
        "claims": claims,
        "coverage": {"sentences": len(claims), "covered": len(claims), "uncovered": [], "note": ""},
        "revision": revision(root),
    }
    print(json.dumps(report, ensure_ascii=False))
    return 14


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
    for rel, empty in (("evidence.json", {"links": []}), ("research-review.json", {"reviews": []})):
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
    return _error("invalid_input", 2, f"unknown command {cmd}")
