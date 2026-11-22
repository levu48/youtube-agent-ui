"""Read-only access to engine draft artifacts at fixed, verified file names.

The browser never supplies a path. Files must be regular files (no symlinks) directly in a
validated project directory, bounded in size and valid UTF-8.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

MAX_ARTIFACT_BYTES = 5 * 1024 * 1024


class _Lenient(BaseModel):
    model_config = ConfigDict(extra="allow")


class OutlineSection(_Lenient):
    id: str
    heading: str = ""
    role: str | None = None
    purpose: str | None = None
    key_points: list[str] = []
    claims_to_investigate: list[str] = []
    estimated_duration_seconds: float | None = None


class Outline(_Lenient):
    title: str = ""
    thesis_or_question: str | None = None
    language: str | None = None
    target_duration_seconds: float | None = None
    notice: str | None = None
    generated_by: str | None = None
    verification: str | None = None
    sections: list[OutlineSection] = Field(default_factory=list)


class ReviewFlag(_Lenient):
    kind: str = "flag"
    excerpt: str | None = None
    note: str | None = None
    origin: str | None = None


class ScriptSection(_Lenient):
    outline_section_id: str
    heading: str = ""
    narration: str = ""
    summary: str | None = None
    target_duration_seconds: float | None = None
    estimated_duration_seconds: float | None = None
    spoken_units: int | None = None
    editorial_notes: list[str] = []
    review_flags: list[ReviewFlag] = []


class Script(_Lenient):
    title: str = ""
    language: str | None = None
    target_duration_seconds: float | None = None
    notice: str | None = None
    generated_by: str | None = None
    verification: str | None = None
    sections: list[ScriptSection] = Field(default_factory=list)


def read_text(root: Path, name: str) -> tuple[str | None, str | None, str]:
    """Return ``(text, error, state)`` where state is ``ok | missing | malformed``."""
    if "/" in name or name.startswith("."):
        raise ValueError("artifact names are fixed")
    p = root / name
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        return None, f"{name} has not been generated yet.", "missing"
    if not stat.S_ISREG(st.st_mode):
        return None, f"{name} is not a regular file.", "malformed"
    if st.st_size > MAX_ARTIFACT_BYTES:
        return None, f"{name} is larger than the viewer limit.", "malformed"
    try:
        with open(p, "rb") as fh:
            raw = fh.read(MAX_ARTIFACT_BYTES + 1)
        return raw.decode("utf-8"), None, "ok"
    except UnicodeDecodeError:
        return None, f"{name} is not valid UTF-8.", "malformed"
    except OSError as exc:
        return None, f"{name} cannot be read ({exc.strerror}).", "malformed"


def _read_model(root: Path, name: str, model: type[BaseModel]) -> tuple[Any, str | None, str]:
    text, err, state = read_text(root, name)
    if text is None:
        return None, err, state
    try:
        return model.model_validate(json.loads(text)), None, "ok"
    except (ValueError, ValidationError):
        return None, f"{name} is malformed or has an unexpected structure.", "malformed"


def read_draft(root: Path) -> dict[str, Any]:
    outline, o_err, o_state = _read_model(root, "outline.json", Outline)
    script, s_err, s_state = _read_model(root, "script.json", Script)
    outline_md, _, _ = read_text(root, "outline.md")
    script_md, _, _ = read_text(root, "script.md")
    return {
        "available": outline is not None and script is not None,
        "outline": {
            "state": o_state,
            "error": o_err,
            "data": outline.model_dump() if outline else None,
            "markdown": outline_md,
        },
        "script": {
            "state": s_state,
            "error": s_err,
            "data": script.model_dump() if script else None,
            "markdown": script_md,
        },
    }


def draft_files_present(root: Path) -> bool:
    return all(read_text(root, n)[2] == "ok" for n in ("outline.json", "script.json"))


# ------------------------------------------------------------------ G1 review state

# Files the engine binds into a G1 approval (youtube-agent drafting.REVIEWED @ d1325c4).
# assets.json is only present once visuals exist.
REVIEWED_FILES = (
    "input.json",
    "outline.json",
    "script.json",
    "storyboard.draft.json",
    "assets.json",
)


def _read_bytes(root: Path, name: str) -> bytes | None:
    p = root / name
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_ARTIFACT_BYTES:
        raise OSError(f"{name} is not a readable regular file")
    with open(p, "rb") as fh:
        return fh.read(MAX_ARTIFACT_BYTES + 1)


def reviewed_hashes(root: Path) -> dict[str, str | None]:
    """SHA-256 of each file a G1 approval covers, as currently on disk (None if absent)."""
    out: dict[str, str | None] = {}
    for name in REVIEWED_FILES:
        data = _read_bytes(root, name)
        out[name] = hashlib.sha256(data).hexdigest() if data is not None else None
    return out


def review_token(hashes: dict[str, str | None]) -> str:
    """Opaque token for "the exact draft the reviewer saw".

    Not an engine revision: the UI uses it only to refuse an approval when the reviewed files
    changed after the reviewer last validated. The engine still decides what it approves."""
    h = hashlib.sha256()
    for name in REVIEWED_FILES:
        h.update(f"{name}\0{hashes.get(name) or '-'}\n".encode())
    return h.hexdigest()


# Reviewed files whose hashes the engine's draft-check reports in ``artifacts`` (verified at
# d1325c4: input.json and assets.json are bound by approval but not listed in the report).
ENGINE_REPORTED = ("outline.json", "script.json", "storyboard.draft.json")
APPROVAL_STATUSES = ("not_approved", "approved", "stale")


def _is_sha(v: object) -> bool:
    return isinstance(v, str) and len(v) == 64 and all(c in "0123456789abcdef" for c in v)


def verify_report(check: object, hashes: dict[str, str | None]) -> str | None:
    """Why a draft-check report cannot back a UI review token, or None if it can.

    The report must be well formed and must cover every reviewed file the engine reports on,
    each matching the bytes hashed on disk. A missing, duplicated, malformed or extra entry
    means the report does not describe the files the reviewer is looking at."""
    if not isinstance(check, dict) or check.get("ok") is not True:
        return "The engine check did not pass."
    if check.get("approval_status") not in APPROVAL_STATUSES:
        return "The engine reported an unrecognised approval status."
    arts = check.get("artifacts")
    if not isinstance(arts, list):
        return "The engine report has no artifact list."
    seen: dict[str, str] = {}
    for a in arts:
        if not isinstance(a, dict) or not isinstance(a.get("path"), str):
            return "The engine report has a malformed artifact entry."
        path, sha = a["path"], a.get("sha256")
        if path in seen:
            return f"The engine report lists {path} twice."
        if not _is_sha(sha):
            return f"The engine report has no valid hash for {path}."
        seen[path] = sha
    if hashes.get("input.json") is None:
        return "input.json is missing."
    for name in ENGINE_REPORTED:
        if hashes.get(name) is None:
            return f"{name} is missing."
        if name not in seen:
            return f"The engine report does not cover {name}."
    for name in REVIEWED_FILES:
        if name in seen and seen[name] != hashes.get(name):
            return f"{name} on disk differs from the version the engine checked."
    return None


def engine_revision(check: object) -> str | None:
    """The engine's own draft revision (``draft-check --json`` ``revision``, engine D-117)."""
    rev = check.get("revision") if isinstance(check, dict) else None
    return rev if _is_sha(rev) else None


def record_digest(record: dict[str, Any] | None) -> str | None:
    """Stable identity of one engine review.json record (who, when, which file hashes)."""
    if not record:
        return None
    ident = {k: record.get(k) for k in ("reviewer", "approved_at", "artifacts", "status")}
    return hashlib.sha256(json.dumps(ident, sort_keys=True).encode()).hexdigest()


class ReviewRecord(_Lenient):
    status: str | None = None
    reviewer: str | None = None
    approved_at: str | None = None
    comment: str | None = None
    artifacts: dict[str, str] = Field(default_factory=dict)
    unresolved_blockers: list[str] = Field(default_factory=list)
    meaning: str | None = None


def read_review(root: Path) -> dict[str, Any] | None:
    """The engine's review.json (read-only, for display). Whether the approval is current is
    decided by the engine's draft-check ``approval_status``, never by this record."""
    rec, _, state = _read_model(root, "review.json", ReviewRecord)
    if state != "ok" or rec is None:
        return None
    d = rec.model_dump(include=set(ReviewRecord.model_fields))
    return d
