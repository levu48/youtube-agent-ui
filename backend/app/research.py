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
