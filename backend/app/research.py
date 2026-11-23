"""Read-only views of the engine's research artifacts (M3).

The engine is authoritative: everything here only *reads* documented artifacts (engine
D-118 read contract): ``research.json``, ``render/research/snapshots.json``,
``evidence.json`` and the content-addressed page texts. Nothing is written, nothing is
trusted for decisions (the engine's ``research-check`` decides), and snapshot text is only
served after its SHA-256 matches the snapshot record.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

RESEARCH = "research.json"
SNAPSHOTS = "render/research/snapshots.json"
EVIDENCE = "evidence.json"
REVIEW = "research-review.json"
MAX_RECORD_BYTES = 20 * 1024 * 1024
MAX_PAGE_BYTES = 2 * 1024 * 1024  # the engine caps page text at 400k characters
SNAPSHOT_ID = re.compile(r"^snap-[0-9a-f]{16}$")
PAGE_PATH = re.compile(r"^render/research/pages/[0-9a-f]{64}\.txt$")


class ResearchReadError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _regular(root: Path, rel: str, limit: int) -> bytes | None:
    """Bytes of a regular file inside the project (no symlinks), or None when absent."""
    path = root / rel
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(st.st_mode) or st.st_size > limit:
        raise ResearchReadError(502, "artifact_unreadable", f"{rel} is not a readable record")
    real = Path(os.path.realpath(path))
    if not real.is_relative_to(Path(os.path.realpath(root))):
        raise ResearchReadError(502, "artifact_unreadable", f"{rel} is outside the project")
    with open(path, "rb") as fh:
        return fh.read(limit + 1)


def _record(root: Path, rel: str) -> dict[str, Any] | None:
    data = _regular(root, rel, MAX_RECORD_BYTES)
    if data is None:
        return None
    try:
        obj = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ResearchReadError(502, "artifact_unreadable", f"{rel} is not valid JSON") from None
    if not isinstance(obj, dict):
        raise ResearchReadError(502, "artifact_unreadable", f"{rel} has an unexpected shape")
    return obj


def _host(url: str | None) -> str | None:
    return (urlsplit(url).hostname or None) if url else None


def sources(root: Path) -> list[dict[str, Any]]:
    record = _record(root, RESEARCH) or {}
    out = []
    for src in (record.get("sources") or {}).values():
        if not isinstance(src, dict):
            continue
        fetches = [f for f in src.get("fetches") or [] if isinstance(f, dict)]
        out.append({
            "id": src.get("id"),
            "kind": src.get("kind") or "web",
            "url": src.get("url"),
            "host": _host(src.get("url")),
            "state": src.get("state"),
            "fixture": bool(src.get("fixture")),
            "user_supplied": bool(src.get("user_supplied")),
            "candidate_for": list(src.get("candidate_for") or []),
            "snapshot_ids": list(src.get("snapshot_ids") or []),
            "discoveries": [
                {k: d.get(k) for k in ("provider", "query", "language", "rank", "title", "snippet")}
                for d in src.get("discoveries") or [] if isinstance(d, dict)
            ][:20],
            "fetches": [
                {k: f.get(k) for k in ("at", "outcome", "detail", "final_url", "snapshot_id")}
                for f in fetches
            ][-20:],
        })  # fmt: skip
    return out


_SNAPSHOT_FIELDS = (
    "id", "source_id", "acquisition", "requested_url", "final_url", "canonical_url",
    "retrieved_at", "title", "publisher", "author", "published_at", "language", "content_type",
    "text_sha256", "chars", "limitations", "fixture", "document_provenance",
)  # fmt: skip


def snapshots(root: Path) -> list[dict[str, Any]]:
    index = _record(root, SNAPSHOTS) or {}
    out = []
    for snap in (index.get("snapshots") or {}).values():
        if isinstance(snap, dict):
            d = {k: snap.get(k) for k in _SNAPSHOT_FIELDS}
            d["acquisition"] = d["acquisition"] or ("fixture" if d["fixture"] else "retrieved")
            out.append(d)
    return out


def evidence(root: Path) -> list[dict[str, Any]]:
    record = _record(root, EVIDENCE) or {}
    return [x for x in record.get("links") or [] if isinstance(x, dict)]


def snapshot_text(root: Path, snapshot_id: str) -> dict[str, Any]:
    """One snapshot's metadata and its verified plain text."""
    if not SNAPSHOT_ID.fullmatch(snapshot_id or ""):
        raise ResearchReadError(422, "validation_error", "not a snapshot id")
    index = _record(root, SNAPSHOTS) or {}
    snap = (index.get("snapshots") or {}).get(snapshot_id)
    if not isinstance(snap, dict):
        raise ResearchReadError(404, "not_found", "no such snapshot in this project")
    rel = snap.get("text_path")
    if not isinstance(rel, str) or not PAGE_PATH.fullmatch(rel):
        raise ResearchReadError(409, "snapshot_tampered", "the snapshot record is not valid")
    data = _regular(root, rel, MAX_PAGE_BYTES)
    if data is None or hashlib.sha256(data).hexdigest() != snap.get("text_sha256"):
        raise ResearchReadError(
            409, "snapshot_tampered", "the snapshot text is missing or does not match its hash"
        )
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ResearchReadError(
            409, "snapshot_tampered", "the snapshot text is not UTF-8"
        ) from None
    meta = {k: snap.get(k) for k in _SNAPSHOT_FIELDS}
    meta["acquisition"] = meta["acquisition"] or ("fixture" if meta["fixture"] else "retrieved")
    return {"snapshot": meta, "text": text}


def research_started(root: Path) -> bool:
    return (root / "research-plan.json").is_file()


# --------------------------------------------------------------------------- UI-B reads

PLAN = "research-plan.json"
STORYBOARD = "storyboard.draft.json"
SCRIPT = "script.json"
LINEAGE = "render/llm/narration-provenance.json"
REVIEW_SCHEMAS = ("m5-review-0.1", "m5-review-0.2")
HISTORY_PAGE_MAX = 200
CONTEXT_CHARS = 160
_SENTENCE = re.compile(r"[^.!?…\n]+(?:[.!?…]+[\"'”’»)\]]*|$)", re.UNICODE)  # engine lineage.py


def _nfc(text: str) -> str:
    import unicodedata

    return unicodedata.normalize("NFC", text)


def scenes(root: Path) -> dict[str, dict[str, Any]]:
    """Scene narrations from the draft storyboard (NFC, as the engine anchors them)."""
    sb = _record(root, STORYBOARD) or {}
    out: dict[str, dict[str, Any]] = {}
    for sc in sb.get("scenes") or []:
        if isinstance(sc, dict) and isinstance(sc.get("id"), str):
            out[sc["id"]] = {
                "id": sc["id"],
                "section_id": sc.get("outline_section_id"),
                "narration": _nfc(sc.get("narration") or ""),
            }
    return out


def _anchor_view(anchor: dict[str, Any], narr: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """An anchor with its surrounding narration, split by the engine's code-point offsets
    in Python (never in the browser), and only when the recorded excerpt still matches."""
    out = {k: anchor.get(k) for k in ("scene_id", "start", "end", "excerpt")}
    text = (narr.get(anchor.get("scene_id")) or {}).get("narration")
    start, end = anchor.get("start"), anchor.get("end")
    out["context"] = None
    if (
        isinstance(text, str)
        and isinstance(start, int)
        and isinstance(end, int)
        and 0 <= start < end <= len(text)
        and text[start:end] == anchor.get("excerpt")
    ):
        out["context"] = {
            "before": text[max(0, start - CONTEXT_CHARS) : start],
            "excerpt": text[start:end],
            "after": text[end : end + CONTEXT_CHARS],
            "truncated_before": start > CONTEXT_CHARS,
            "truncated_after": end + CONTEXT_CHARS < len(text),
        }
    return out


def plan(root: Path) -> dict[str, Any] | None:
    """The claim inventory (``research-plan.json``, a human file written by the engine), with
    the fields the report leaves out: anchors, notes, origin, search queries, and the leads."""
    record = _record(root, PLAN)
    if record is None:
        return None
    narr = scenes(root)
    claims = []
    for c in record.get("claims") or []:
        if not isinstance(c, dict):
            continue
        anchors = c.get("anchors") or []
        claims.append({
            "id": c.get("id"),
            "assertion": c.get("assertion"),
            "kind": c.get("kind"),
            "flags": list(c.get("flags") or []),
            "contested": bool(c.get("contested")),
            "notes": c.get("notes") or "",
            "origin": c.get("origin") or "rule",
            "search_queries": list(c.get("search_queries") or []),
            "anchors": [_anchor_view(a, narr) for a in anchors if isinstance(a, dict)],
        })  # fmt: skip
    leads = [
        {"section_id": x.get("section_id"), "text": x.get("text")}
        for x in record.get("leads") or []
        if isinstance(x, dict)
    ]
    return {"claims": claims, "leads": leads, "language": record.get("language")}


def review_file(root: Path) -> dict[str, Any]:
    """Decisions, completeness, rechecks and primary attestations from
    ``research-review.json`` (a human file the engine writes). Read only; the engine's
    research-check decides what counts. History is summarised here and paged separately."""
    record = _record(root, REVIEW)
    if record is None:
        return {
            "present": False,
            "schema_version": None,
            "supported": True,
            "reviews": [],
            "completeness": None,
            "source_rechecks": [],
            "primary_source_attestations": [],
            "history_summary": {"count": 0, "last_seq": None},
        }
    schema = record.get("schema_version")
    comp = record.get("completeness")
    history = [h for h in record.get("history") or [] if isinstance(h, dict)]
    return {
        "present": True,
        "schema_version": schema,
        "supported": schema in REVIEW_SCHEMAS,
        "reviews": [r for r in record.get("reviews") or [] if isinstance(r, dict)],
        "completeness": comp if isinstance(comp, dict) else None,
        "source_rechecks": [r for r in record.get("source_rechecks") or [] if isinstance(r, dict)],
        "primary_source_attestations": [
            a for a in record.get("primary_source_attestations") or [] if isinstance(a, dict)
        ],
        "history_summary": {
            "count": len(history),
            "last_seq": history[-1].get("seq") if history else None,
        },
    }  # fmt: skip


def history_page(
    root: Path,
    *,
    kind: str | None = None,
    subject_id: str | None = None,
    after_seq: int = 0,
    limit: int = 50,
) -> dict[str, Any]:
    """One page of the review history (engine D-119), ordered by ``seq``. Integrity is the
    engine's to judge: the caller reports ``chain_ok`` from research-check's
    ``history_tampered`` item at the same revision."""
    record = _record(root, REVIEW)
    if record is None:
        return {"entries": [], "next_after_seq": None, "has_more": False}
    if record.get("schema_version") != "m5-review-0.2":
        raise ResearchReadError(
            502,
            "engine_unsupported",
            "The review history needs research-review.json m5-review-0.2: upgrade the "
            "research records first.",
        )
    entries = [h for h in record.get("history") or [] if isinstance(h, dict)]
    picked = [
        e
        for e in entries
        if isinstance(e.get("seq"), int)
        and e["seq"] > after_seq
        and (kind is None or e.get("kind") == kind)
        and (subject_id is None or e.get("subject_id") == subject_id)
    ]
    limit = max(1, min(limit, HISTORY_PAGE_MAX))
    page = picked[:limit]
    return {
        "entries": page,
        "next_after_seq": page[-1]["seq"] if page else None,
        "has_more": len(picked) > limit,
    }


def _sentences(narration: str) -> list[str]:
    text = _nfc(narration)
    return [m.group(0).strip() for m in _SENTENCE.finditer(text) if m.group(0).strip()]


def lineage(root: Path) -> dict[str, Any]:
    """The narration lineage (engine D-120, tool-owned ``narration-provenance.json``), read
    only. A segment's text is shown only when a current script sentence has exactly the
    recorded ``text_sha256``; otherwise only the engine's normalised form is available."""
    record = _record(root, LINEAGE)
    if record is None:
        return {"present": False, "fixture_project": None, "segments": [], "history": []}
    if record.get("schema_version") != "m3-narration-provenance-1":
        return {
            "present": True,
            "supported": False,
            "fixture_project": None,
            "segments": [],
            "history": [],
        }
    script = _record(root, SCRIPT) or {}
    texts: dict[tuple[str, str], list[str]] = {}
    for sec in script.get("sections") or []:
        if isinstance(sec, dict):
            for t in _sentences(sec.get("narration") or ""):
                key = (sec.get("outline_section_id"), hashlib.sha256(t.encode("utf-8")).hexdigest())
                texts.setdefault(key, []).append(t)
    segments = []
    for s in record.get("segments") or []:
        if not isinstance(s, dict):
            continue
        found = texts.get((s.get("section_id"), s.get("text_sha256")))
        segments.append({
            "segment_id": s.get("segment_id"),
            "section_id": s.get("section_id"),
            "scene_id": s.get("scene_id"),
            "origin": s.get("origin"),
            "text": found[0] if found else None,
            "norm": s.get("norm"),
            "derived_from": list(s.get("derived_from") or []),
            "attestation": s.get("attestation") if isinstance(s.get("attestation"), dict) else None,
            "initialized_from": s.get("initialized_from"),
        })  # fmt: skip
    history = [h for h in record.get("history") or [] if isinstance(h, dict)][-50:]
    return {
        "present": True,
        "supported": True,
        "fixture_project": bool(record.get("fixture_project")),
        "segments": segments,
        "history": history,
    }
