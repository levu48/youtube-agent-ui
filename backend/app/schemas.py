"""Pydantic request/response schemas (the OpenAPI source of truth)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

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
