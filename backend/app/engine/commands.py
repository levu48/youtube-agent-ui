"""Allowlisted argv builders for the engine CLI.

Only six operations exist. Every free-text value is validated and passed as a single
``--option=value`` argv element, so a value can never be parsed as another flag, and argv is
never handed to a shell. Force/replace/paid options are not representable here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

LANGUAGES = ("en", "vi")
PROVIDERS = ("ollama", "fixture")
FROM_STAGES = ("outline", "script", "storyboard")
MIN_DURATION, MAX_DURATION = 60, 3600

FIELD_LIMITS = {
    "idea": (5, 2000),
    "audience": (0, 500),
    "tone": (0, 200),
    "guidance": (0, 4000),
    # Engine ReviewRecord limits (models.py): reviewer 1-200, comment <= 2000.
    "reviewer": (1, 200),
    "comment": (0, 2000),
}


class EngineOp(StrEnum):
    VERSION = "version"
    CREATE = "create"
    DRAFT = "draft"
    PRODUCTION_STATUS = "production-status"
    DRAFT_CHECK = "draft-check"
    DRAFT_APPROVE = "draft-approve"


class ArgumentError(ValueError):
    """A value was rejected before reaching the engine."""


def clean_text(name: str, value: str | None, *, required: bool = False) -> str | None:
    if value is None or not value.strip():
        if required:
            raise ArgumentError(f"{name} is required")
        return None
    value = value.strip()
    if _CONTROL_RE.search(value):
        raise ArgumentError(f"{name} contains control characters")
    lo, hi = FIELD_LIMITS[name]
    if not lo <= len(value) <= hi:
        raise ArgumentError(f"{name} must be {lo}-{hi} characters")
    return value


def check_slug(slug: str) -> str:
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        raise ArgumentError("slug must match ^[a-z0-9][a-z0-9-]{0,62}$")
    return slug


def check_model(model: str) -> str:
    if not isinstance(model, str) or not MODEL_RE.fullmatch(model):
        raise ArgumentError("model name contains unsupported characters")
    return model


def _root(root: Path) -> str:
    if not isinstance(root, Path) or not root.is_absolute():
        raise ArgumentError("project root must be an absolute path")
    return f"--project-root={root}"


@dataclass(frozen=True)
class CreateSpec:
    idea: str
    language: str
    duration_seconds: int = 180
    audience: str | None = None
    tone: str | None = None
    guidance: str | None = None


def version_args() -> list[str]:
    return ["--version"]


def create_args(root: Path, spec: CreateSpec) -> list[str]:
    idea = clean_text("idea", spec.idea, required=True)
    if spec.language not in LANGUAGES:
        raise ArgumentError("language must be en or vi")
    if (
        isinstance(spec.duration_seconds, bool)
        or not isinstance(spec.duration_seconds, int)
        or not MIN_DURATION <= spec.duration_seconds <= MAX_DURATION
    ):
        raise ArgumentError("duration must be an integer 60-3600")
    argv = [
        EngineOp.CREATE.value,
        _root(root),
        f"--idea={idea}",
        f"--language={spec.language}",
        f"--duration={spec.duration_seconds}",
    ]
    for name, flag in (("audience", "--audience"), ("tone", "--tone"), ("guidance", "--guidance")):
        v = clean_text(name, getattr(spec, name))
        if v is not None:
            argv.append(f"{flag}={v}")
    argv.append("--draft-provider=none")
    return argv


def draft_args(root: Path, *, provider: str, model: str | None, from_stage: str) -> list[str]:
    if provider not in PROVIDERS:
        raise ArgumentError("provider must be ollama or fixture")
    if from_stage not in FROM_STAGES:
        raise ArgumentError("from_stage must be outline, script or storyboard")
    argv = [EngineOp.DRAFT.value, _root(root), f"--provider={provider}"]
    if provider == "ollama":
        if model is None:
            raise ArgumentError("model is required for the ollama provider")
        argv.append(f"--model={check_model(model)}")
    argv.append(f"--from-stage={from_stage}")
    return argv


def production_status_args(root: Path) -> list[str]:
    return [EngineOp.PRODUCTION_STATUS.value, _root(root), "--json"]


def draft_check_args(root: Path) -> list[str]:
    return [EngineOp.DRAFT_CHECK.value, _root(root), "--json"]


def draft_approve_args(
    root: Path,
    *,
    reviewer: str,
    comment: str | None = None,
    expect_revision: str | None = None,
) -> list[str]:
    """G1 approval. ``--reviewer`` is always explicit: the engine would otherwise fall back to
    ``$YTA_REVIEWER`` or the OS user name.

    With ``expect_revision`` (engines that report a draft ``revision``), the engine itself
    refuses the approval unless its locked snapshot is still at that revision, and answers
    in JSON."""
    name = clean_text("reviewer", reviewer, required=True) or ""
    if any(ch in name for ch in "\r\n\t"):
        raise ArgumentError("reviewer must be a single line")
    argv = [EngineOp.DRAFT_APPROVE.value, _root(root), f"--reviewer={name}"]
    note = clean_text("comment", comment)
    if note is not None:
        argv.append(f"--comment={note}")
    if expect_revision is not None:
        if not re.fullmatch(r"[0-9a-f]{64}", expect_revision):
            raise ArgumentError("expect_revision must be a 64-character hex revision")
        argv += [f"--expect-revision={expect_revision}", "--json"]
    return argv


ALLOWED_SUBCOMMANDS = frozenset(op.value for op in EngineOp if op is not EngineOp.VERSION)
FORBIDDEN_FLAGS = ("--force", "--replace-edits", "--replace-output", "--replace-plan", "--section")


def assert_allowlisted(argv: list[str]) -> None:
    """Last line of defence before spawning: shape check of a built argv."""
    if argv == ["--version"]:
        return
    if not argv or argv[0] not in ALLOWED_SUBCOMMANDS:
        raise ArgumentError("subcommand not allowlisted")
    for a in argv[1:]:
        if not a.startswith("--"):
            raise ArgumentError("positional engine arguments are not allowed")
        flag = a.split("=", 1)[0]
        if flag in FORBIDDEN_FLAGS:
            raise ArgumentError(f"{flag} is not allowed in this UI")
        if "\x00" in a:
            raise ArgumentError("NUL in argument")
