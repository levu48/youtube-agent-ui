"""Read-only access to engine draft artifacts at fixed, verified file names.

The browser never supplies a path. Files must be regular files (no symlinks) directly in a
validated project directory, bounded in size and valid UTF-8.
"""

from __future__ import annotations

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
