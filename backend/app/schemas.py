"""Pydantic request/response schemas (the OpenAPI source of truth)."""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.engine import commands

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]
TERMINAL_STATUSES = frozenset({"succeeded", "failed", "cancelled", "interrupted"})


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ProjectCreate(_Strict):
    slug: str = Field(min_length=1, max_length=63, examples=["hcm-demo"])
    idea: str = Field(min_length=5, max_length=2000)
    language: Literal["en", "vi"] = "vi"
    duration_seconds: int = Field(default=180, ge=60, le=3600, strict=True)
    audience: str | None = Field(default=None, max_length=500)
    tone: str | None = Field(default=None, max_length=200)
    guidance: str | None = Field(default=None, max_length=4000)

    @field_validator("slug")
    @classmethod
    def _slug(cls, v: str) -> str:
        if not commands.SLUG_RE.fullmatch(v):
            raise ValueError(
                "Use lowercase letters, digits and hyphens; start with a letter or digit"
            )
        return v

    @field_validator("idea", "audience", "tone", "guidance")
    @classmethod
    def _text(cls, v: str | None, info) -> str | None:
        try:
            return commands.clean_text(info.field_name, v, required=info.field_name == "idea")
        except commands.ArgumentError as exc:
            raise ValueError(str(exc)) from None


class ProjectRegister(_Strict):
    slug: str

    @field_validator("slug")
    @classmethod
    def _slug(cls, v: str) -> str:
        if not commands.SLUG_RE.fullmatch(v):
            raise ValueError("invalid slug")
        return v


class DraftApprove(_Strict):
    """Explicit G1 approval request. ``review_token`` comes from the last ``GET /draft`` the
    reviewer saw; the approval is refused if the reviewed files changed since."""

    reviewer: str = Field(min_length=1, max_length=200)
    comment: str | None = Field(default=None, max_length=2000)
    confirm: Literal[True]
    review_token: str = Field(pattern=r"^[0-9a-f]{64}$")

    @field_validator("reviewer", "comment")
    @classmethod
    def _text(cls, v: str | None, info) -> str | None:
        try:
            v = commands.clean_text(info.field_name, v, required=info.field_name == "reviewer")
        except commands.ArgumentError as exc:
            raise ValueError(str(exc)) from None
        if info.field_name == "reviewer" and v and any(c in v for c in "\r\n\t"):
            raise ValueError("reviewer must be a single line")
        return v


class DraftJobCreate(_Strict):
    provider: Literal["ollama", "fixture"] = "ollama"
    model: str | None = Field(default=None, max_length=128)
    from_stage: Literal["outline", "script", "storyboard"] = "outline"

    @field_validator("model")
    @classmethod
    def _model(cls, v: str | None) -> str | None:
        if v is None:
            return None
        try:
            return commands.check_model(v)
        except commands.ArgumentError as exc:
            raise ValueError(str(exc)) from None


class StageOut(BaseModel):
    stage: str
    status: str
    mode: str | None = None
    detail: str | None = None
    next_action: str | None = None


class StatusSummary(BaseModel):
    """Derived from the engine's ``production-status --json``; never UI-invented."""

    available: bool
    stages: list[StageOut] = []
    current_stage: StageOut | None = None
    error: str | None = None
    error_code: str | None = None


class JobOut(BaseModel):
    id: str
    project_id: str
    type: str
    status: JobStatus
    created_at: str
    started_at: str | None
    finished_at: str | None
    exit_code: int | None
    message: str | None
    error_message: str | None
    error_code: str | None = None
    cancel_requested: bool
    provider: str | None = None
    model: str | None = None
    from_stage: str | None = None


class JobEventOut(BaseModel):
    id: int
    type: str
    data: dict[str, Any]
    created_at: str


class JobEventPage(BaseModel):
    """Cursor page of persisted events: every event with id > ``after``, in order."""

    job_id: str
    status: JobStatus
    events: list[JobEventOut]
    next_after: int
    has_more: bool


class JobDetail(JobOut):
    events: list[JobEventOut] = []
    events_truncated: bool = False


class ProjectOut(BaseModel):
    id: str
    slug: str
    display_name: str
    location: str
    created_at: str
    updated_at: str
    idea: str | None = None
    language: str | None = None
    duration_seconds: int | None = None
    audience: str | None = None
    tone: str | None = None
    guidance: str | None = None
    input_error: str | None = None
    last_activity: str
    active_job: JobOut | None = None


class ProjectSummary(ProjectOut):
    status: StatusSummary


class ProjectCreated(BaseModel):
    id: str
    status: str
    next_action: str


class LocationPreview(BaseModel):
    slug: str
    location: str
    available: bool
    reason: str | None = None


class DiscoveredProject(BaseModel):
    slug: str
    location: str


class EngineInfo(BaseModel):
    available: bool
    version: str | None = None
    repo: str
    reason: str | None = None
    capabilities: list[str] = []


class OllamaModel(BaseModel):
    name: str
    size_bytes: int | None = None
    parameter_size: str | None = None
    quantization: str | None = None


class OllamaInfo(BaseModel):
    available: bool
    base_url: str
    models: list[OllamaModel] = []
    default_model: str
    default_model_installed: bool = False
    reason: str | None = None


class SystemConfig(BaseModel):
    projects_root: str
    default_language: Literal["en", "vi"] = "vi"
    default_model: str
    providers: list[str]
    research_network: bool = True
    visuals_network: bool = True


# ---------------------------------------------------------------------- research (M3)

HEX64 = r"^[0-9a-f]{64}$"
CLAIM_ID = r"^clm-[a-z0-9-]{3,40}$"


class ResearchPlanRequest(_Strict):
    expected_revision: str = Field(pattern=HEX64)


class CollectPreviewRequest(_Strict):
    """What a collection would do; the engine computes the hosts (no network)."""

    expected_revision: str = Field(pattern=HEX64)
    languages: Annotated[list[Literal["vi", "en"]], Field(min_length=1, max_length=2)] = [
        "vi",
        "en",
    ]
    claim_ids: Annotated[list[Annotated[str, Field(pattern=CLAIM_ID)]], Field(max_length=200)] = []
    max_queries: int = Field(default=8, ge=0, le=50)
    max_results_per_query: int = Field(default=5, ge=0, le=20)
    max_pages: int = Field(default=15, ge=0, le=100)


class CollectRequest(CollectPreviewRequest):
    """Run a collection the reviewer confirmed: ``plan_sha256`` and ``allow_hosts`` must be
    exactly those of the engine's current preview for the same parameters."""

    network: Literal[True]
    plan_sha256: str = Field(pattern=HEX64)
    allow_hosts: Annotated[
        list[Annotated[str, Field(min_length=1, max_length=253)]],
        Field(min_length=1, max_length=200),
    ]


class AddSourceRequest(_Strict):
    expected_revision: str = Field(pattern=HEX64)
    url: str = Field(min_length=9, max_length=2000)
    claim_ids: Annotated[list[Annotated[str, Field(pattern=CLAIM_ID)]], Field(max_length=200)] = []
    fetch: Literal["queue", "live"] = "queue"
    network: bool = False
    allow_hosts: Annotated[
        list[Annotated[str, Field(min_length=1, max_length=253)]], Field(max_length=1)
    ] = []


# ---------------------------------------------------------------------- visuals (M4)

SCENE_ID = commands.SCENE_ID_RE.pattern


class VisualsPlanRequest(_Strict):
    expected_revision: str = Field(pattern=HEX64)


class AcquirePreviewRequest(_Strict):
    """What an image search would do; the engine computes the preview (no network)."""

    expected_revision: str = Field(pattern=HEX64)
    scene_ids: Annotated[list[Annotated[str, Field(pattern=SCENE_ID)]], Field(max_length=500)] = []
    max_candidates_per_scene: int = Field(default=4, ge=1, le=20)


class AcquireRequest(AcquirePreviewRequest):
    """Run the search the reviewer confirmed: ``preview_sha256`` and ``allow_hosts`` must be
    exactly those of the engine's current preview for the same parameters. The engine checks
    both again itself (``--expect-preview``)."""

    network: Literal[True]
    preview_sha256: str = Field(pattern=HEX64)
    allow_hosts: Annotated[
        list[Annotated[str, Field(min_length=1, max_length=253)]],
        Field(min_length=1, max_length=50),
    ]


_ONE_LINE = re.compile(r"^[^\x00-\x1f\x7f]*$")


class VisualsImportFields(_Strict):
    """The text fields of an image import (sent before the file part)."""

    expected_revision: str = Field(pattern=HEX64)
    scene_id: str = Field(pattern=SCENE_ID)
    kind: Literal["archival", "document", "chart", "generated"]
    provenance: str = Field(min_length=10, max_length=2000)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    source_url: str | None = Field(default=None, max_length=2000)
    creator: str | None = Field(default=None, min_length=1, max_length=300)
    license_name: str | None = Field(default=None, min_length=1, max_length=200)
    license_url: str | None = Field(default=None, max_length=2000)
    attribution: str | None = Field(default=None, min_length=1, max_length=1000)

    @field_validator("*", mode="before")
    @classmethod
    def _blank_is_none(cls, v: object) -> object:
        return None if isinstance(v, str) and not v.strip() else v

    @field_validator(
        "provenance", "title", "source_url", "creator", "license_name", "license_url",
        "attribution",
    )  # fmt: skip
    @classmethod
    def _single_line(cls, v: str | None) -> str | None:
        if v is not None and not _ONE_LINE.fullmatch(v):
            raise ValueError("must be one line without control characters")
        return v

    @field_validator("source_url", "license_url")
    @classmethod
    def _https(cls, v: str | None) -> str | None:
        if v is not None:
            try:
                commands.url_host(v)
            except commands.ArgumentError as exc:
                raise ValueError(str(exc)) from None
        return v


class JobCreated(BaseModel):
    job_id: str
    project_id: str
    status: JobStatus


class Health(BaseModel):
    status: Literal["ok"]
    version: str
    schema_version: int


class Session(BaseModel):
    csrf_token: str


class PublicErrorOut(BaseModel):
    code: str
    message: str


# --------------------------------------------------------------- draft editing (M2)
# Mirrors the engine's draft-edit patch (youtube-agent D-117 @ 573ebdd,
# agents/draft_edit.py): same fields and limits. The engine validates again and is
# authoritative; this layer rejects malformed requests before any engine run.

SECTION_ID = r"^[a-z0-9][a-z0-9-]{0,39}$"
_EDIT_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

EditShort = Annotated[str, Field(min_length=1, max_length=300)]
EditText = Annotated[str, Field(min_length=1, max_length=2000)]
EditItem = Annotated[str, Field(min_length=1, max_length=1000)]
EditNote = Annotated[str, Field(min_length=1, max_length=2000)]
EditNarration = Annotated[str, Field(min_length=1, max_length=50_000)]
EditSummary = Annotated[str, Field(max_length=2000)]


class _Edit(BaseModel):
    """Strict: unknown fields, wrong types and explicit nulls are rejected (omit a field to
    keep it). Text is not trimmed or rewritten here; the engine normalises it."""

    model_config = ConfigDict(extra="forbid", strict=True)

    @model_validator(mode="before")
    @classmethod
    def _no_nulls(cls, value: object) -> object:
        if isinstance(value, dict):
            nulls = sorted(k for k, v in value.items() if v is None)
            if nulls:
                raise ValueError(f"null is not allowed ({', '.join(nulls)}); omit the field")
        return value

    @field_validator("*", mode="after")
    @classmethod
    def _text(cls, value: object) -> object:
        for v in value if isinstance(value, list) else [value]:
            if isinstance(v, str) and _EDIT_CONTROL.search(v):
                raise ValueError("contains control characters")
        return value


class OutlineSectionEdit(_Edit):
    id: str = Field(pattern=SECTION_ID)
    heading: EditShort | None = None
    purpose: EditText | None = None
    key_points: Annotated[list[EditItem], Field(min_length=1, max_length=50)] | None = None
    claims_to_investigate: Annotated[list[EditItem], Field(max_length=50)] | None = None


class OutlineEdit(_Edit):
    title: EditShort | None = None
    thesis_or_question: EditText | None = None
    sections: Annotated[list[OutlineSectionEdit], Field(max_length=100)] | None = None


class ScriptSectionEdit(_Edit):
    outline_section_id: str = Field(pattern=SECTION_ID)
    heading: EditShort | None = None
    narration: EditNarration | None = None
    summary: EditSummary | None = None
    editorial_notes: Annotated[list[EditNote], Field(max_length=50)] | None = None


class ScriptEdit(_Edit):
    sections: Annotated[list[ScriptSectionEdit], Field(min_length=1, max_length=100)]


class DraftEditRequest(_Edit):
    """One atomic edit of the outline and/or script, based on ``expected_revision`` (the
    engine's draft revision the editor loaded). ``dry_run`` validates without writing."""

    expected_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    dry_run: bool = False
    outline: OutlineEdit | None = None
    script: ScriptEdit | None = None

    @model_validator(mode="after")
    def _something(self) -> DraftEditRequest:
        if self.outline is None and self.script is None:
            raise ValueError("nothing to save: give outline and/or script changes")
        return self

    def patch(self) -> dict[str, Any]:
        """The engine patch: only the fields the client set."""
        return self.model_dump(exclude_unset=True, exclude={"expected_revision", "dry_run"})
