"""HTTP API v1 (see docs/api-contract.md)."""

from __future__ import annotations

import asyncio
import json
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

from app import __version__
from app.artifacts import draft_files_present, read_draft
from app.config import home_relative
from app.engine import commands
from app.engine.public_errors import to_public
from app.errors import ApiError
from app.ollama import model_installed, ollama_info
from app.projects import ProjectRow, read_input
from app.schemas import (
    TERMINAL_STATUSES,
    DiscoveredProject,
    DraftJobCreate,
    EngineInfo,
    Health,
    JobCreated,
    JobDetail,
    JobEventPage,
    JobOut,
    LocationPreview,
    OllamaInfo,
    ProjectCreate,
    ProjectCreated,
    ProjectOut,
    ProjectRegister,
    ProjectSummary,
    Session,
    StatusSummary,
    SystemConfig,
)
from app.state import AppState, get_state

router = APIRouter(prefix="/api/v1")
State = Annotated[AppState, Depends(get_state)]


# ---------------------------------------------------------------------- system


@router.get("/health", response_model=Health)
async def health(s: State) -> Health:
    return Health(status="ok", version=__version__, schema_version=s.db.schema_version())


@router.get("/session", response_model=Session)
async def session(s: State) -> Session:
    """CSRF token for state-changing requests (same-origin pages only)."""
    return Session(csrf_token=s.csrf_token)


@router.get("/system/engine", response_model=EngineInfo)
async def system_engine(s: State) -> EngineInfo:
    return await s.engine.info()


@router.get("/system/ollama", response_model=OllamaInfo)
async def system_ollama(s: State) -> OllamaInfo:
    return await ollama_info(s.settings.ollama_base_url, s.settings.default_model)


@router.get("/system/config", response_model=SystemConfig)
async def system_config(s: State) -> SystemConfig:
    providers = ["ollama"] + (["fixture"] if s.settings.allow_fixture_provider else [])
    return SystemConfig(
        projects_root=home_relative(s.settings.projects_root_real),
        default_model=s.settings.default_model,
        providers=providers,
    )


# ---------------------------------------------------------------------- projects


def _project_out(s: AppState, row: ProjectRow) -> dict:
    meta, err = read_input(row.root)
    meta = meta or {}
    last = s.jobs.last_activity(row.id)
    return dict(
        id=row.id,
        slug=row.slug,
        display_name=row.display_name,
        location=home_relative(row.root_path),
        created_at=row.created_at,
        updated_at=row.updated_at,
        idea=meta.get("idea"),
        language=meta.get("language"),
        duration_seconds=meta.get("target_duration_seconds"),
        audience=meta.get("audience"),
        tone=meta.get("tone"),
        guidance=meta.get("editorial_guidance"),
        input_error=err,
        last_activity=max(filter(None, [row.updated_at, last])),
        active_job=s.jobs.active_for(row.id),
    )


async def _status(s: AppState, row: ProjectRow, *, fresh: bool) -> StatusSummary:
    try:
        root = s.projects.confined_root(row)
    except ApiError as exc:
        return StatusSummary(available=False, error=exc.message)
    if fresh:
        return await s.engine.production_status(row.id, root)
    return await s.engine.cached_status(row.id, root)


@router.get("/projects", response_model=list[ProjectSummary])
async def list_projects(s: State) -> list[ProjectSummary]:
    rows = s.projects.list()
    statuses = await asyncio.gather(*(_status(s, r, fresh=False) for r in rows))
    return [
        ProjectSummary(**_project_out(s, r), status=st)
        for r, st in zip(rows, statuses, strict=True)
    ]


@router.post("/projects", response_model=ProjectCreated, status_code=201)
async def create_project(body: ProjectCreate, s: State) -> ProjectCreated:
    spec = commands.CreateSpec(
        idea=body.idea,
        language=body.language,
        duration_seconds=body.duration_seconds,
        audience=body.audience,
        tone=body.tone,
        guidance=body.guidance,
    )
    try:
        row = await s.projects.create(spec, body.slug)
    except commands.ArgumentError as exc:
        raise ApiError(422, "validation_error", str(exc)) from None
    return ProjectCreated(id=row.id, status="created", next_action="generate_draft")


@router.get("/projects/location-preview", response_model=LocationPreview)
async def location_preview(
    s: State, slug: Annotated[str, Query(max_length=100)]
) -> LocationPreview:
    return LocationPreview(**s.projects.preview(slug))


@router.get("/projects/discoverable", response_model=list[DiscoveredProject])
async def discoverable(s: State) -> list[DiscoveredProject]:
    return [DiscoveredProject(**d) for d in s.projects.discover()]


@router.post("/projects/register", response_model=ProjectOut, status_code=201)
async def register(body: ProjectRegister, s: State) -> ProjectOut:
    row = s.projects.register(body.slug)
    return ProjectOut(**_project_out(s, row))


@router.get("/projects/{project_id}", response_model=ProjectOut)
async def get_project(project_id: str, s: State) -> ProjectOut:
    return ProjectOut(**_project_out(s, s.projects.require(project_id)))


@router.get("/projects/{project_id}/status", response_model=StatusSummary)
async def project_status(project_id: str, s: State) -> StatusSummary:
    return await _status(s, s.projects.require(project_id), fresh=True)


@router.get("/projects/{project_id}/draft-check")
async def project_draft_check(project_id: str, s: State) -> dict:
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    try:
        return await s.engine.draft_check(root)
    except Exception as exc:
        pe = to_public(exc, operation="draft-check")
        raise ApiError(pe.status, pe.code, pe.message) from None


@router.get("/projects/{project_id}/draft")
async def project_draft(project_id: str, s: State) -> dict:
    """Artifacts plus the engine's draft-check. A failed check is reported with the same
    sanitized ``{code, message}`` as ``/draft-check`` would return, never a raw exception."""
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    out = read_draft(root)
    try:
        out["draft_check"] = await s.engine.draft_check(root)
        out["draft_check_error"] = None
    except Exception as exc:
        out["draft_check"] = None
        out["draft_check_error"] = to_public(exc, operation="draft-check").as_dict()
    return out


@router.get("/projects/{project_id}/draft-available")
async def project_draft_available(project_id: str, s: State) -> dict:
    row = s.projects.require(project_id)
    return {"available": draft_files_present(s.projects.confined_root(row))}


# ---------------------------------------------------------------------- jobs


@router.post("/projects/{project_id}/draft-jobs", response_model=JobCreated, status_code=202)
async def create_draft_job(project_id: str, body: DraftJobCreate, s: State) -> JobCreated:
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    model = None
    if body.provider == "fixture":
        if not s.settings.allow_fixture_provider:
            raise ApiError(
                422,
                "provider_disabled",
                "The fixture provider is for offline tests and is disabled here.",
            )
    else:
        model = body.model or s.settings.default_model
        info = await ollama_info(s.settings.ollama_base_url, s.settings.default_model)
        if not info.available:
            raise ApiError(503, "ollama_unavailable", info.reason or "Ollama is unavailable.")
        if not model_installed(info, model):
            raise ApiError(
                422,
                "model_not_installed",
                f"The model {model!r} is not installed. Run `ollama pull {model}`.",
                {"model": model},
            )
    args = commands.draft_args(
        root, provider=body.provider, model=model, from_stage=body.from_stage
    )
    job = s.jobs.submit(
        project_id,
        "draft",
        args,
        {"provider": body.provider, "model": model, "from_stage": body.from_stage},
    )
    s.projects.touch(project_id)
    return JobCreated(job_id=job.id, project_id=project_id, status=job.status)


@router.get("/jobs", response_model=list[JobOut])
async def list_jobs(
    s: State,
    project_id: Annotated[str | None, Query(max_length=63)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> list[JobOut]:
    if project_id is not None:
        s.projects.require(project_id)
    return s.jobs.list(project_id=project_id, limit=limit)


@router.get("/jobs/{job_id}", response_model=JobDetail)
async def get_job(
    job_id: str, s: State, events: Annotated[int, Query(ge=0, le=1000)] = 200
) -> JobDetail:
    return s.jobs.detail(job_id, limit=events)


@router.get("/jobs/{job_id}/events/page", response_model=JobEventPage)
async def job_events_page(
    job_id: str,
    s: State,
    after: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=1000)] = 500,
) -> JobEventPage:
    """Polling fallback: page through events after a cursor without gaps or duplicates."""
    job = s.jobs.get(job_id)
    batch = s.jobs.events_after(job_id, after, limit + 1)
    page = batch[:limit]
    return JobEventPage(
        job_id=job_id,
        status=job.status,
        events=[e.out() for e in page],
        next_after=page[-1].id if page else after,
        has_more=len(batch) > limit,
    )


@router.get("/jobs/{job_id}/events")
async def job_events(
    job_id: str,
    request: Request,
    s: State,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    after: Annotated[int | None, Query(ge=0)] = None,
):
    s.jobs.get(job_id)  # 404 for unknown jobs
    try:
        cursor = int(last_event_id) if last_event_id else (after or 0)
    except ValueError:
        cursor = after or 0

    async def stream():
        nonlocal cursor
        q = s.jobs.subscribe(job_id)
        try:
            while True:
                # Replay/catch up from the database (bounded pages), then wait for live events.
                while True:
                    batch = s.jobs.events_after(job_id, cursor)
                    for ev in batch:
                        cursor = ev.id
                        yield _sse(ev)
                        if ev.type == "completed":
                            return
                    if len(batch) < 1000:
                        break
                if s.jobs.get(job_id).status in TERMINAL_STATUSES:
                    # Terminal but no "completed" event after the cursor: nothing more to send.
                    if not s.jobs.events_after(job_id, cursor):
                        return
                    continue
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=5.0)
                except TimeoutError:
                    if await request.is_disconnected():
                        return
                    continue
                if ev.id <= cursor:
                    continue
                cursor = ev.id
                yield _sse(ev)
                if ev.type == "completed":
                    return
        finally:
            s.jobs.unsubscribe(job_id, q)

    return EventSourceResponse(
        stream(),
        ping=15,
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _sse(ev) -> dict:
    return {
        "id": str(ev.id),
        "event": ev.type,
        "data": json.dumps({**ev.data, "created_at": ev.created_at}, ensure_ascii=False),
    }


@router.post("/jobs/{job_id}/cancel", response_model=JobOut)
async def cancel_job(job_id: str, s: State) -> JSONResponse:
    job = await s.jobs.cancel(job_id)
    return JSONResponse(job.model_dump(), status_code=202 if job.status == "running" else 200)
