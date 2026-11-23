"""research-edit, research-add-document, narration-attest and narration-provenance-init of the
fake engine (mirrors engine D-119/D-120 at fb6bffc, simplified but with the same JSON shapes,
error codes and refusal rules the UI relies on). The real engine is authoritative and is
exercised by the real-engine integration test."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
from datetime import UTC, datetime
from pathlib import Path

import fake_research as F

LINEAGE = "render/llm/narration-provenance.json"
REVIEW = "research-review.json"
STATUSES = (
    "unverified",
    "supported_pending_review",
    "verified",
    "disputed",
    "insufficient",
    "editorial_nonfactual",
)
NOT_PEOPLE = {"test", "reviewer", "admin", "user", "os-user", "fixture", "claude"}
_SENTENCE = re.compile(r"[^.!?…\n]+(?:[.!?…]+[\"'”’»)\]]*|$)", re.UNICODE)


class Refused(Exception):
    def __init__(self, code: str, msg: str) -> None:
        super().__init__(msg)
        self.code = code


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _canon(obj: object) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _id(prefix: str, *parts: object) -> str:
    return prefix + hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:16]


def _person(name: str, what: str) -> str:
    if not name.strip() or name.strip().casefold() in NOT_PEOPLE:
        raise Refused("invalid_reviewer", f"{what} must name the human who decided ({name!r})")
    return name.strip()


def claim_basis(c: dict) -> str:
    return _canon(
        {
            "assertion": c["assertion"],
            "kind": c["kind"],
            "contested": bool(c.get("contested")),
            "flags": sorted(c.get("flags") or []),
        }
    )


def link_basis(link: dict) -> str:
    return _canon({k: link.get(k) for k in sorted(link) if k != "claim_id"})


def review_file(root: Path) -> dict:
    rf = F._read(root, REVIEW, {})
    rf.setdefault("schema_version", "m5-review-0.2")
    for k in ("reviews", "source_rechecks", "history", "primary_source_attestations"):
        rf.setdefault(k, [])
    rf.setdefault("completeness", None)
    return rf


def history_ok(rf: dict) -> bool:
    prev = None
    for n, e in enumerate(rf.get("history") or [], 1):
        if e.get("seq") != n or e.get("prev_sha256") != prev:
            return False
        prev = _canon(e)
    return True


def _append(
    rf: dict,
    kind: str,
    subject: str | None,
    action: str,
    by: str | None,
    previous: dict,
    reason: str | None = None,
    outdated: list | None = None,
) -> None:
    hist = rf["history"]
    hist.append(
        {
            "id": _id("hist-", len(hist), kind, subject, _now()),
            "seq": len(hist) + 1,
            "prev_sha256": _canon(hist[-1]) if hist else None,
            "kind": kind,
            "subject_id": subject,
            "action": action,
            "at": _now(),
            "by_reviewer": by,
            "reason": reason,
            "previous": previous,
            "outdated_components": outdated or [],
        }
    )


def snapshot_text(root: Path, sid: str) -> str:
    index = F._read(root, "render/research/snapshots.json", {"snapshots": {}})
    snap = index["snapshots"].get(sid)
    if snap is None:
        raise Refused("unknown_snapshot", f"unknown snapshot {sid!r}")
    return (root / snap["text_path"]).read_text("utf-8")


class Work:
    def __init__(self, root: Path, dry: bool) -> None:
        self.root, self.dry = root, dry
        self.plan = F._read(root, "research-plan.json", None)
        self.evidence = F._read(root, "evidence.json", {"links": []})
        self.rf = review_file(root)
        self.created: list[dict] = []
        self.occurrences: list[dict] = []

    def claim(self, cid: str) -> dict:
        for c in (self.plan or {}).get("claims", []):
            if c["id"] == cid:
                return c
        raise Refused("unknown_claim", f"unknown claim {cid!r}")

    def link(self, lid: str) -> dict:
        for x in self.evidence["links"]:
            if x.get("id") == lid:
                return x
        raise Refused("unknown_link", f"unknown evidence link {lid!r}")

    def locate(self, i: int, field: str, text: str, quote: str, occurrence: int | None) -> int:
        starts = [m.start() for m in re.finditer(re.escape(quote), text)]
        if not starts:
            raise Refused("quote_not_found", f"{field} does not occur verbatim")
        if self.dry:
            self.occurrences.append(
                {
                    "op_index": i,
                    "field": field,
                    "occurrences": [
                        {
                            "n": n,
                            "start": s,
                            "end": s + len(quote),
                            "context": text[max(0, s - 40) : s + len(quote) + 40],
                        }
                        for n, s in enumerate(starts, 1)
                    ],
                }
            )
        if occurrence is None:
            if len(starts) > 1 and not self.dry:
                raise Refused(
                    "ambiguous_quote", f"{field} occurs {len(starts)} times: give occurrence"
                )
            occurrence = 1
        if not 1 <= occurrence <= len(starts):
            raise Refused("bad_occurrence", f"occurrence must be 1..{len(starts)}")
        return starts[occurrence - 1]

    def translation(self, i: int, t: dict) -> dict:
        text = snapshot_text(self.root, t["snapshot_id"])
        s = self.locate(i, "original_quote", text, t["quote"], t.get("occurrence"))
        return {
            "snapshot_id": t["snapshot_id"],
            "start": s,
            "end": s + len(t["quote"]),
            "quote": t["quote"],
            "language": t["language"],
            "speaker": t["speaker"],
            "equivalence_note": t["equivalence_note"],
        }

    def apply(self, i: int, op: dict) -> None:  # noqa: C901, PLR0912
        name = op["op"]
        if self.plan is None and name not in ("migrate_ids", "migrate_review_file"):
            raise Refused("plan_missing", "no research-plan.json: run research-plan first")
        if name == "claims.update":
            c = self.claim(op["id"])
            for k in ("assertion", "kind", "flags", "contested", "notes", "search_queries"):
                if k in op:
                    c[k] = op[k]
        elif name == "claims.add":
            a = op["anchor"]
            excerpt = a.get("excerpt") or "excerpt"
            cid = f"clm-{len(self.plan['claims']) + 1:03d}-editor"
            self.plan["claims"].append(
                {
                    "id": cid,
                    "assertion": op["assertion"],
                    "kind": op["kind"],
                    "flags": op.get("flags", []),
                    "contested": op.get("contested", False),
                    "notes": op.get("notes", ""),
                    "origin": "editor",
                    "search_queries": [],
                    "anchors": [
                        {
                            "scene_id": a["scene_id"],
                            "start": a.get("start", 0),
                            "end": a.get("end", len(excerpt)),
                            "excerpt": excerpt,
                            "narration_sha256": "0" * 64,
                        }
                    ],
                }
            )
            self.created.append({"op_index": i, "kind": "claim", "id": cid})
        elif name == "claims.remove":
            self.claim(op["id"])
            if any(x["claim_id"] == op["id"] for x in self.evidence["links"]) or any(
                r["claim_id"] == op["id"] for r in self.rf["reviews"]
            ):
                raise Refused("claim_referenced", "evidence or a review references the claim")
            self.plan["claims"] = [c for c in self.plan["claims"] if c["id"] != op["id"]]
        elif name == "evidence.add":
            self.claim(op["claim_id"])
            text = snapshot_text(self.root, op["snapshot_id"])
            s = self.locate(i, "quote", text, op["quote"], op.get("occurrence"))
            link = {
                "id": _id(
                    "ev-",
                    op["claim_id"],
                    op["snapshot_id"],
                    s,
                    op["role"],
                    len(self.evidence["links"]),
                ),
                "claim_id": op["claim_id"],
                "snapshot_id": op["snapshot_id"],
                "start": s,
                "end": s + len(op["quote"]),
                "quote": op["quote"],
                "role": op["role"],
                "explanation": op["explanation"],
                "source_type": op.get("source_type", "unknown"),
                "evidence_root": op.get("evidence_root"),
                "original_language": op.get("original_language"),
                "is_translation": op.get("is_translation", False),
                "translator": op.get("translator"),
                "translation_of": self.translation(i, op["translation_of"])
                if "translation_of" in op
                else None,
            }
            for x in self.evidence["links"]:
                if (x["claim_id"], x["snapshot_id"], x["start"], x["end"], x["role"]) == (
                    link["claim_id"],
                    link["snapshot_id"],
                    link["start"],
                    link["end"],
                    link["role"],
                ):
                    raise Refused("duplicate_link", "this exact passage is already linked")
            self.evidence["links"].append(link)
            self.created.append({"op_index": i, "kind": "link", "id": link["id"]})
        elif name == "evidence.update":
            link = self.link(op["link_id"])
            for k in ("role", "explanation", "source_type", "evidence_root"):
                if k in op:
                    link[k] = op[k]
        elif name == "evidence.set_translation":
            link = self.link(op["link_id"])
            link["translation_of"] = self.translation(i, op["translation_of"])
            link["is_translation"] = True
            for k in ("translator", "original_language"):
                if k in op:
                    link[k] = op[k]
        elif name == "evidence.clear_translation":
            link = self.link(op["link_id"])
            link.update(translation_of=None, is_translation=False, translator=None)
        elif name == "evidence.remove":
            self.link(op["link_id"])
            self.evidence["links"] = [
                x for x in self.evidence["links"] if x.get("id") != op["link_id"]
            ]
        elif name == "reviews.set":
            c = self.claim(op["claim_id"])
            if op["status"] not in STATUSES:
                raise Refused("invalid_value", "unknown status")
            who = _person(op["reviewer"], "reviewer")
            links = [x for x in self.evidence["links"] if x["claim_id"] == c["id"]]
            if any(x.get("id") is None for x in links):
                raise Refused("legacy_links", "migrate_ids first")
            new = {k: op[k] for k in op if k != "op"} | {
                "reviewer": who,
                "reviewed_at": _now(),
                "basis": {
                    "scheme": "m5-review-basis-1",
                    "claim": claim_basis(c),
                    "evidence": {x["id"]: link_basis(x) for x in links},
                },
            }
            old = next((r for r in self.rf["reviews"] if r["claim_id"] == c["id"]), None)
            if old is not None:
                _append(self.rf, "claim_review", c["id"], "replaced", who, old)
                self.rf["reviews"].remove(old)
            self.rf["reviews"].append(new)
        elif name == "reviews.clear":
            old = next((r for r in self.rf["reviews"] if r["claim_id"] == op["claim_id"]), None)
            if old is None:
                raise Refused("unknown_review", f"{op['claim_id']} has no recorded decision")
            who = _person(op["reviewer"], "reviewer")
            _append(self.rf, "claim_review", op["claim_id"], "cleared", who, old, op["reason"])
            self.rf["reviews"].remove(old)
        elif name == "completeness.set":
            who = _person(op["reviewer"], "reviewer")
            if self.rf["completeness"]:
                _append(self.rf, "completeness", None, "replaced", who, self.rf["completeness"])
            self.rf["completeness"] = {
                "reviewer": who,
                "confirmed_at": _now(),
                "narration_fingerprint": "0" * 64,
                "inventory_fingerprint": inventory(self.plan),
                "statement": op["statement"],
            }
        elif name == "source_rechecks.add":
            who = _person(op["reviewer"], "reviewer")
            rid = _id(
                "rc-", op["source_id"], op["cited_snapshot_id"], op["expected_current_snapshot_id"]
            )
            if any(r.get("id") == rid for r in self.rf["source_rechecks"]):
                raise Refused("recheck_exists", f"a recheck exists: {rid}")
            self.rf["source_rechecks"].append(
                {
                    "id": rid,
                    "source_id": op["source_id"],
                    "cited_snapshot_id": op["cited_snapshot_id"],
                    "current_snapshot_id": op["expected_current_snapshot_id"],
                    "claim_ids": op["claim_ids"],
                    "decision": "keep_cited_version",
                    "reviewer": who,
                    "reviewed_at": _now(),
                    "rationale": op["rationale"],
                }
            )
            self.created.append({"op_index": i, "kind": "recheck", "id": rid})
        elif name in ("source_rechecks.update", "source_rechecks.remove"):
            rc = next(
                (r for r in self.rf["source_rechecks"] if r.get("id") == op["recheck_id"]), None
            )
            if rc is None:
                raise Refused("unknown_recheck", f"unknown source recheck {op['recheck_id']!r}")
            who = _person(op["reviewer"], "reviewer")
            if name.endswith("remove"):
                _append(self.rf, "source_recheck", rc["id"], "removed", who, dict(rc), op["reason"])
                self.rf["source_rechecks"].remove(rc)
            else:
                _append(self.rf, "source_recheck", rc["id"], "updated", who, dict(rc))
                rc.update({k: op[k] for k in ("claim_ids", "rationale") if k in op}, reviewer=who)
        elif name == "documents.attest_primary":
            index = F._read(self.root, "render/research/snapshots.json", {"snapshots": {}})
            snap = index["snapshots"].get(op["snapshot_id"])
            if snap is None or snap.get("acquisition") != "imported":
                raise Refused("not_imported", f"{op['snapshot_id']} is not an imported document")
            who = _person(op["reviewer"], "reviewer")
            self.rf["primary_source_attestations"].append(
                {
                    "snapshot_id": op["snapshot_id"],
                    "text_sha256": snap["text_sha256"],
                    "provenance_sha256": _canon(snap.get("document_provenance")),
                    "reviewer": who,
                    "statement": op["statement"],
                    "at": _now(),
                }
            )
        elif name == "documents.revoke_primary":
            att = next(
                (
                    a
                    for a in self.rf["primary_source_attestations"]
                    if a["snapshot_id"] == op["snapshot_id"]
                ),
                None,
            )
            if att is None:
                raise Refused("unknown_attestation", "no primary-source attestation")
            who = _person(op["reviewer"], "reviewer")
            _append(
                self.rf,
                "primary_source_attestation",
                op["snapshot_id"],
                "removed",
                who,
                att,
                op["reason"],
            )
            self.rf["primary_source_attestations"].remove(att)
        elif name == "migrate_ids":
            for n, x in enumerate(self.evidence["links"]):
                x.setdefault("id", None)
                if x["id"] is None:
                    x["id"] = _id("ev-", "migrated", n, x["claim_id"])
        elif name == "migrate_review_file":
            if self.rf["schema_version"] == "m5-review-0.1":
                old = (self.root / REVIEW).read_bytes()
                for r in self.rf["reviews"]:
                    r["basis"] = None
                self.rf["schema_version"] = "m5-review-0.2"
                _append(
                    self.rf,
                    "migration",
                    None,
                    "migrated",
                    None,
                    {"schema_version": "m5-review-0.1", "sha256": hashlib.sha256(old).hexdigest()},
                )
        else:
            raise Refused("invalid_value", f"unknown operation {name}")


def inventory(plan: dict | None) -> str:
    return _canon([[c["id"], claim_basis(c)] for c in (plan or {}).get("claims", [])])


def research_edit(root: Path, o: dict, mode: str) -> int:
    if (rc := F._expect(root, o)) is not None:
        return rc
    try:
        patch = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return F._error("invalid_patch", 2, "the patch is not valid JSON")
    ops = patch.get("operations") or []
    rf_before = review_file(root)
    if not history_ok(rf_before):
        return F._error(
            "invalid_patch",
            2,
            "research-review.json history is not intact",
            details=[{"loc": REVIEW, "msg": "seq gap", "code": "history_tampered"}],
        )
    dry = o.get("dry-run") == "1"
    w = Work(root, dry)
    previous = F.revision(root)
    for i, op in enumerate(ops):
        if (
            op["op"] not in ("migrate_ids", "migrate_review_file")
            and w.rf["schema_version"] == "m5-review-0.1"
        ):
            return F._error(
                "migration_required",
                2,
                "research-review.json is m5-review-0.1: run migrate_review_file first",
            )
        try:
            w.apply(i, op)
        except Refused as exc:
            msg = str(exc)
            return F._error(
                "invalid_patch",
                2,
                f"operation {i} ({op['op']}) refused: {msg}",
                details=[{"loc": f"operations.{i}", "msg": msg, "code": exc.code}],
            )
    outputs = {}
    for rel, before, after in (
        ("research-plan.json", F._read(root, "research-plan.json", None), w.plan),
        ("evidence.json", F._read(root, "evidence.json", None), w.evidence),
        (REVIEW, F._read(root, REVIEW, None), w.rf),
    ):
        if after is not None and before != after:
            outputs[rel] = after
    status = "already_current" if not outputs else "would_publish" if dry else "published"
    if status == "published":
        if (rc := F._race(root, mode, o)) is not None:
            return rc
        for rel, data in outputs.items():
            F._write(root, rel, data)
    print(
        json.dumps(
            {
                "ok": True,
                "status": status,
                "dry_run": dry,
                "previous_revision": previous,
                "revision": F.revision(root),
                "changed_files": sorted(outputs),
                "created": w.created,
                "occurrences": w.occurrences,
                "check": {"approvable": False, "blocking_items": 1, "items": []},
                "approval_status": "not_approved",
            },
            ensure_ascii=False,
        )
    )
    return 0


def add_document(root: Path, o: dict) -> int:
    if (rc := F._expect(root, o)) is not None:
        return rc
    text = unicodedata.normalize("NFC", sys.stdin.read())
    for k in ("title", "language", "citation", "imported-by"):
        if not (o.get(k) or "").strip():
            return F._error("invalid_input", 2, f"--{k} is required")
    if o["imported-by"].casefold() in NOT_PEOPLE:
        return F._error("invalid_input", 2, "imported_by must name a real person")
    record = F._read(root, "research.json", {"schema_version": "m5-research-0.2", "sources": {}})
    index = F._read(
        root,
        "render/research/snapshots.json",
        {"schema_version": "m5-snapshots-0.2", "snapshots": {}},
    )
    sha = hashlib.sha256(text.encode()).hexdigest()
    prov = {
        "title": o["title"],
        "language": o["language"],
        "citation": o["citation"],
        "imported_by": o["imported-by"],
        "imported_at": _now(),
    }
    for k in ("edition", "declared-url", "original-published-at", "license", "note"):
        if o.get(k):
            prov[k.replace("-", "_")] = o[k]
    declared = {k: v for k, v in prov.items() if k != "imported_at"}
    new_of = o.get("new-version-of")
    for snap in index["snapshots"].values():
        same = snap.get("text_sha256") == sha and snap.get("acquisition") == "imported"
        if same and (
            new_of is None
            or {
                k: v
                for k, v in snap["document_provenance"].items()
                if k not in ("imported_at", "supersedes_snapshot_id")
            }
            == declared
        ):
            return F._error(
                "document_exists",
                2,
                "this document is already imported",
                details={"source_id": snap["source_id"], "snapshot_id": snap["id"]},
            )
    if new_of:
        src = record["sources"].get(new_of)
        if not src or src.get("kind") != "document":
            return F._error("invalid_input", 2, f"unknown document source {new_of}")
        prov["supersedes_snapshot_id"] = src["snapshot_ids"][-1]
    else:
        src = {
            "id": _id("doc-", sha, _now()),
            "kind": "document",
            "url": None,
            "state": "extracted",
            "user_supplied": True,
            "snapshot_ids": [],
            "candidate_for": [],
            "fetches": [],
        }
        record["sources"][src["id"]] = src
    snap_id = _id("snap-", src["id"], sha, _canon(declared))
    page = root / "render/research/pages" / f"{sha}.txt"
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_bytes(text.encode())
    index["snapshots"][snap_id] = {
        "id": snap_id,
        "source_id": src["id"],
        "acquisition": "imported",
        "requested_url": None,
        "final_url": None,
        "retrieved_at": prov["imported_at"],
        "title": o["title"],
        "language": o["language"],
        "text_path": f"render/research/pages/{sha}.txt",
        "text_sha256": sha,
        "chars": len(text),
        "limitations": [],
        "fixture": False,
        "document_provenance": prov,
    }
    src["snapshot_ids"].append(snap_id)
    F._write(root, "research.json", record)
    F._write(root, "render/research/snapshots.json", index)
    print(
        json.dumps(
            {
                "ok": True,
                "source_id": src["id"],
                "snapshot_id": snap_id,
                "supersedes_snapshot_id": prov.get("supersedes_snapshot_id"),
                "chars": len(text),
                "revision": F.revision(root),
            }
        )
    )
    return 0


# --------------------------------------------------------------------------- lineage


def _norm(text: str) -> str:
    text = unicodedata.normalize("NFC", text).casefold()
    kept = [" " if unicodedata.category(ch)[0] in "PSNZ" or ch.isspace() else ch for ch in text]
    return " ".join("".join(kept).split())


def sentences(narration: str) -> list[str]:
    text = unicodedata.normalize("NFC", narration)
    return [m.group(0).strip() for m in _SENTENCE.finditer(text) if m.group(0).strip()]


def write_lineage(root: Path, origin_of) -> None:  # noqa: ANN001
    """One segment per script sentence; ``origin_of(section, text)`` gives its origin."""
    script = F._read(root, "script.json", {"sections": []})
    old = F._read(root, LINEAGE, None)
    by_text = {(s["section_id"], s["text_sha256"]): s for s in (old or {}).get("segments", [])}
    segs = []
    for n, sec in enumerate(script.get("sections", []), 1):
        for t in sentences(sec.get("narration") or ""):
            sha = hashlib.sha256(t.encode()).hexdigest()
            kept = by_text.get((sec["outline_section_id"], sha))
            segs.append(
                kept
                or {
                    "segment_id": _id("seg-", sec["outline_section_id"], sha, len(segs)),
                    "section_id": sec["outline_section_id"],
                    "scene_id": f"scene-{n:03d}",
                    "text_sha256": sha,
                    "norm": _norm(t),
                    "origin": origin_of(sec["outline_section_id"], t),
                    "derived_from": [],
                    "attestation": None,
                    "initialized_from": None,
                }
            )
    F._write(
        root,
        LINEAGE,
        {
            "schema_version": "m3-narration-provenance-1",
            "fixture_project": True,
            "segments": segs,
            "tombstones": (old or {}).get("tombstones", []),
            "history": (old or {}).get("history", []),
        },
    )


def lineage_items(root: Path) -> list[dict]:
    rec = F._read(root, LINEAGE, None)
    if rec is None:
        return []
    left = [s for s in rec["segments"] if s["origin"] in ("fixture", "fixture_derived")]
    if not left:
        return []
    return [
        {
            "code": "fixture_narration",
            "claim_id": None,
            "blocking": True,
            "detail": f"{len(left)} narration sentence(s) are still fixture text or unattested "
            f"rewrites of it (segments: {', '.join(s['segment_id'] for s in left[:10])})",
        }
    ]


def narration_attest(root: Path, o: dict, argv: list[str]) -> int:
    if (rc := F._expect(root, o)) is not None:
        return rc
    rec = F._read(root, LINEAGE, None)
    if rec is None:
        return F._error(
            "lineage_refused",
            2,
            "no narration lineage",
            details={"reason": "narration_provenance_missing"},
        )
    who = o.get("reviewer", "")
    if who.casefold() in NOT_PEOPLE:
        return F._error("invalid_input", 2, "reviewer must name a real person")
    ids = [a.split("=", 1)[1] for a in argv if a.startswith("--segment=")]
    by_id = {s["segment_id"]: s for s in rec["segments"]}
    for sid in ids:
        seg = by_id.get(sid)
        if seg is None:
            return F._error(
                "lineage_refused",
                2,
                f"unknown narration segment {sid!r}",
                details={"reason": "unknown_segment"},
            )
        if seg["origin"] == "fixture":
            return F._error(
                "lineage_refused",
                2,
                f"{sid} equals fixture text",
                details={"reason": "unchanged_fixture_text"},
            )
        if seg["origin"] != "fixture_derived":
            return F._error(
                "lineage_refused",
                2,
                f"{sid} needs no attestation",
                details={"reason": "not_fixture_derived"},
            )
        if "fixture" in seg["norm"]:
            return F._error(
                "lineage_refused",
                2,
                f"{sid} is still close to the fixture text; rewrite it",
                details={"reason": "still_close"},
            )
    for sid in ids:
        by_id[sid].update(
            origin="human",
            attestation={"reviewer": who, "statement": o.get("statement"), "at": _now()},
        )
    rec["history"].append(
        {"kind": "attested", "at": _now(), "by": who, "segment_ids": ids, "note": None}
    )
    F._write(root, LINEAGE, rec)
    remaining = sum(1 for s in rec["segments"] if s["origin"] in ("fixture", "fixture_derived"))
    print(
        json.dumps(
            {
                "ok": True,
                "status": "attested",
                "segments": ids,
                "remaining": remaining,
                "recovered": None,
                "revision": F.revision(root),
            }
        )
    )
    return 0


def provenance_init(root: Path, o: dict) -> int:
    if (rc := F._expect(root, o)) is not None:
        return rc
    if (root / LINEAGE).is_file():
        return F._error(
            "lineage_refused",
            2,
            "the lineage is already initialised",
            details={"reason": "already_initialized"},
        )
    write_lineage(root, lambda _s, _t: "fixture")
    rec = F._read(root, LINEAGE, {})
    for s in rec["segments"]:
        s["initialized_from"] = "legacy_unrecoverable"
    rec["history"].append(
        {
            "kind": "initialized",
            "at": _now(),
            "by": None,
            "segment_ids": [],
            "note": "fixture originals could not be recovered",
        }
    )
    F._write(root, LINEAGE, rec)
    print(
        json.dumps(
            {
                "ok": True,
                "status": "initialized",
                "segments": [s["segment_id"] for s in rec["segments"]],
                "remaining": len(rec["segments"]),
                "recovered": False,
                "revision": F.revision(root),
            }
        )
    )
    return 0
