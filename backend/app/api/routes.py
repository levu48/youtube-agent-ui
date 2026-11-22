"""HTTP API v1 (see docs/api-contract.md)."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

from app import __version__
from app.artifacts import (
    draft_files_present,
    engine_revision,
    read_draft,
    read_review,
    record_digest,
    review_token,
    reviewed_hashes,
    verify_report,
)
from app.config import home_relative
from app.engine import commands
from app.engine.errors import redact
from app.engine.public_errors import MAX_ENGINE_MESSAGE, to_public
from app.errors import ApiError
from app.ollama import model_installed, ollama_info
from app.projects import ProjectRow, read_input
from app.schemas import (
    TERMINAL_STATUSES,
    DiscoveredProject,
    DraftApprove,
    DraftEditRequest,
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


@dataclass
class _Review:
    """One validation of the draft: the engine report plus what the reviewer may approve.

    ``mode`` is ``engine`` when the engine reports its own draft ``revision`` (engine D-117):
    the token *is* that revision and the engine checks it under its lock when approving.
    Otherwise (``ui``, engine @ d1325c4) the token is a UI hash of the reviewed files, issued
    only when the engine's report verifiably describes those exact bytes."""

    check: dict | None = None
    error: dict | None = None
    token: str | None = None
    reason: str | None = None
    mode: str | None = None
    error_status: int = 502
    hashes: dict[str, str | None] = field(default_factory=dict)


_RETRY_REASON = "The draft changed while it was being checked. Validate it again."


async def _checked(s: AppState, root) -> _Review:
    """Run the engine's draft-check and derive the review token for the same file contents."""
    out = _Review()
    for _ in range(2):
        try:
            before = reviewed_hashes(root)
        except OSError:
            before = None
        try:
            out.check, out.error = await s.engine.draft_check(root), None
        except Exception as exc:
            pe = to_public(exc, operation="draft-check")
            return _Review(error=pe.as_dict(), error_status=pe.status)
        rev = engine_revision(out.check)
        if rev is not None:
            out.mode, out.reason = "engine", None
            out.token = rev if out.check.get("ok") is True else None
            if out.token is None:
                out.reason = "The engine check did not pass."
            return out
        out.mode = "ui"
        try:
            after = reviewed_hashes(root)
        except OSError:
            after = None
        if before is None or before != after:
            out.reason = _RETRY_REASON
            continue
        out.hashes = after
        out.reason = verify_report(out.check, after)
        out.token = review_token(after) if out.reason is None else None
        break
    return out


def _approval_view(s: AppState, row: ProjectRow, review: _Review, record: dict | None) -> dict:
    """``approval_confirmed`` is False when the engine's current approval is one the UI could
    not confirm covers the version the reviewer validated; None when nothing is approved."""
    approved = bool(review.check) and review.check.get("approval_status") == "approved"
    if not approved:
        return {"approval_confirmed": None}
    unconfirmed = s.approvals.is_unconfirmed(row.id, record_digest(record))
    return {"approval_confirmed": not unconfirmed}


@router.get("/projects/{project_id}/draft")
async def project_draft(project_id: str, s: State) -> dict:
    """Artifacts, the engine's draft-check, the engine's review record and a review token.

    A failed check is reported with the same sanitized ``{code, message}`` as
    ``/draft-check`` would return, never a raw exception. Every call runs draft-check again,
    so this is also the "Validate draft" action."""
    row = s.projects.require(project_id)
    return await _draft_view(s, row, s.projects.confined_root(row))


async def _draft_view(s: AppState, row: ProjectRow, root) -> dict:
    out = read_draft(root)
    review = await _checked(s, root)
    record = read_review(root)
    out["draft_check"] = review.check
    out["draft_check_error"] = review.error
    out["review_token"] = review.token
    out["review_token_reason"] = None if review.token else review.reason
    out["review_mode"] = review.mode
    out["approval"] = record
    out.update(_approval_view(s, row, review, record))
    active = s.jobs.active_for(row.id)
    out["active_job_id"] = active.id if active else None
    return out


_DRAFT_CHANGED = (
    "The draft changed after you last validated it. Review the latest version, then approve again."
)


def _engine_json_error(res) -> dict:
    try:
        data = json.loads(res.stdout)
    except ValueError:
        return {}
    err = data.get("error") if isinstance(data, dict) else None
    return err if isinstance(err, dict) else {}


def _approve_failure(res) -> ApiError:
    """Map a non-zero draft-approve exit to a public error (redacted engine message)."""
    jerr = _engine_json_error(res)
    if jerr.get("code") == "revision_mismatch":
        return ApiError(409, "draft_changed", _DRAFT_CHANGED)
    text = redact(str(jerr.get("message") or "")) if jerr else redact(res.stderr)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    msg = next((ln.removeprefix("error:").strip() for ln in lines if not ln.startswith("- ")), "")
    msg = msg[:MAX_ENGINE_MESSAGE]
    if res.exit_code == 2:
        errors = [ln.removeprefix("- ").strip() for ln in lines if ln.startswith("- ")][:50]
        return ApiError(
            422,
            "approval_refused",
            f"The engine refused the approval: {msg}" if msg else "The engine refused it.",
            {"errors": errors},
        )
    if res.exit_code == 9:
        return ApiError(
            409,
            "engine_conflict",
            "Another engine run is using this project. Try again when it has finished.",
        )
    code = res.classification.code
    return ApiError(
        502, code, f"The engine reported an error: {msg}" if msg else res.classification.summary
    )


@router.post("/projects/{project_id}/draft/approve")
async def approve_draft(project_id: str, body: DraftApprove, s: State) -> dict:
    """Record G1 editorial approval through ``ytagent draft-approve``.

    Refused while a job is active (409 ``job_conflict``) or when the reviewed files changed
    since the reviewer's last validation (409 ``draft_changed``). With an engine that reports
    a draft revision, the engine enforces that check itself under its lock
    (``--expect-revision``). Otherwise, an approval the UI cannot confirm covers the validated
    version is recorded as unconfirmed and answered with 409 ``approval_unconfirmed``, never
    as success. The response reports the engine's state after the command."""
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    with s.jobs.exclusive(row.id):
        pre = await _checked(s, root)
        if pre.check is None:
            err = pre.error or {}
            raise ApiError(
                pre.error_status,
                err.get("code", "engine_error"),
                err.get("message", "The engine check could not be run."),
            )
        # A failing check goes to the engine, which refuses with its own error list.
        if pre.check.get("ok") is True:
            if pre.token is None and pre.reason != _RETRY_REASON:
                raise ApiError(
                    422, "draft_unverifiable", pre.reason or "The draft cannot be verified."
                )
            if pre.token != body.review_token:
                raise ApiError(409, "draft_changed", _DRAFT_CHANGED)
        engine_mode = pre.mode == "engine"
        try:
            res = await s.engine.draft_approve(
                root,
                reviewer=body.reviewer,
                comment=body.comment,
                expect_revision=body.review_token if engine_mode else None,
            )
        except commands.ArgumentError as exc:
            raise ApiError(422, "validation_error", str(exc)) from None
        except Exception as exc:
            pe = to_public(exc, operation="draft-approve")
            raise ApiError(pe.status, pe.code, pe.message) from None
        finally:
            s.engine.invalidate(row.id)
            s.projects.touch(row.id)
        if res.timed_out:
            raise ApiError(
                504,
                "engine_timeout",
                "The engine did not finish the approval in time. Reload to see whether it "
                "was recorded.",
            )
        if res.exit_code != 0:
            raise _approve_failure(res)

        record = read_review(root)
        if engine_mode:
            try:
                data = json.loads(res.stdout)
            except ValueError:
                data = {}
            already = bool(isinstance(data, dict) and data.get("already_approved"))
            # The engine compared the revision on the snapshot it approved.
            matches = (
                isinstance(data, dict)
                and data.get("ok") is True
                and data.get("revision") == body.review_token
            )
        else:
            already = res.stdout.lstrip().startswith("already approved")
            # The engine (d1325c4) approves its own snapshot; confirm it is the validated one.
            validated = {k: v for k, v in pre.hashes.items() if v}
            matches = bool(record) and record.get("artifacts") == validated
        digest = record_digest(record)
        if matches:
            s.approvals.clear(row.id)
        elif digest is not None:
            s.approvals.mark_unconfirmed(row.id, digest)

    review = await _checked(s, root)
    status = (await _status(s, row, fresh=True)).model_dump()
    if not matches:
        raise ApiError(
            409,
            "approval_unconfirmed",
            "The engine recorded an approval, but a file changed while it was being approved, "
            "so it does not match the version you validated. It is not shown as your approval. "
            "Validate the draft, review the current version, and approve it again.",
            {"approval_status": (review.check or {}).get("approval_status")},
        )
    return {
        "already_approved": already,
        "approved_version_matches": True,
        "approval": record,
        "approval_confirmed": True,
        "draft_check": review.check,
        "draft_check_error": review.error,
        "review_token": review.token,
        "review_token_reason": None if review.token else review.reason,
        "review_mode": review.mode,
        "status": status,
    }


# ------------------------------------------------------------------ draft editing (M2)

EDIT_LIMITS = {
    "title": 300,
    "thesis_or_question": 2000,
    "heading": 300,
    "purpose": 2000,
    "key_point": 1000,
    "key_points": 50,
    "claims_to_investigate": 50,
    "narration": 50_000,
    "summary": 2000,
    "editorial_note": 2000,
    "editorial_notes": 50,
}

_EDIT_UNSUPPORTED = (
    "The installed engine cannot edit drafts: it reports no draft revision. Editing needs "
    "youtube-agent with `draft-edit` (decision D-117)."
)


def _safe_paths(value: object) -> list[str]:
    """Relative artifact names from an engine error (never absolute paths)."""
    if not isinstance(value, list):
        return []
    return [p for p in value if isinstance(p, str) and not p.startswith("/") and ".." not in p][:20]


def _edit_failure(res) -> ApiError:
    """Map a failed ``draft-edit --json`` to a public error. Messages are redacted."""
    jerr = _engine_json_error(res)
    code = jerr.get("code")
    message = redact(str(jerr.get("message") or "")).strip()
    first = message.splitlines()[0].removeprefix("error:").strip() if message else ""
    first = first[:MAX_ENGINE_MESSAGE]
    if code == "revision_mismatch":
        current = jerr.get("current_revision")
        return ApiError(
            409,
            "revision_conflict",
            "The draft changed since you loaded it (another save, the CLI or a draft job). "
            "Nothing was saved. Reload the latest version, then apply your edits again.",
            {"current_revision": current if engine_revision({"revision": current}) else None},
        )
    if code == "downstream_artifacts":
        return ApiError(
            409,
            "downstream_artifacts",
            "The draft cannot be edited in place: later-stage work depends on it. Nothing "
            "was saved.",
            {"paths": _safe_paths(jerr.get("paths"))},
        )
    if code == "invalid_patch":
        details = jerr.get("details") if isinstance(jerr.get("details"), list) else []
        errors = [
            {"loc": str(d.get("loc", ""))[:200], "msg": redact(str(d.get("msg", "")))[:500]}
            for d in details
            if isinstance(d, dict)
        ][:50]
        return ApiError(
            422, "invalid_edit", first or "The engine rejected the edit.", {"errors": errors}
        )
    if code in ("invalid_input", "human_edit_conflict"):
        lines = [ln.strip() for ln in message.splitlines()[1:] if ln.strip().startswith("- ")]
        return ApiError(
            422,
            "edit_refused",
            f"The engine refused the edit: {first}" if first else "The engine refused the edit.",
            {"errors": [ln.removeprefix("- ").strip()[:500] for ln in lines][:50]},
        )
    if code == "unresolved_publication":
        return ApiError(
            409,
            "unresolved_publication",
            "An earlier engine write of this draft was interrupted and must be resolved in "
            "the CLI first. Nothing was saved.",
        )
    if res.exit_code == 9:
        return ApiError(
            409,
            "engine_conflict",
            "Another engine run is using this project. Try again when it has finished.",
        )
    return ApiError(
        502,
        res.classification.code,
        f"The engine reported an error: {first}" if first else res.classification.summary,
    )


async def _editing(s: AppState, row: ProjectRow, root, view: dict) -> dict:
    """Whether the draft can be edited now, decided by the engine (a no-op dry run)."""
    check = view.get("draft_check")
    revision = engine_revision(check)
    out: dict = {
        "supported": revision is not None,
        "can_edit": False,
        "revision": revision,
        "reason": None,
        "reason_code": None,
        "paths": [],
        "limits": EDIT_LIMITS,
    }
    if check is None:
        out["reason"] = "The engine check could not be run."
        out["reason_code"] = "check_unavailable"
        return out
    if revision is None:
        out["reason"], out["reason_code"] = _EDIT_UNSUPPORTED, "engine_unsupported"
        return out
    if view.get("active_job_id"):
        out["reason"] = "A draft job is running for this project. Wait for it to finish."
        out["reason_code"] = "job_conflict"
        return out
    outline = (view.get("outline") or {}).get("data") or {}
    title = outline.get("title")
    if (view.get("outline") or {}).get("state") != "ok" or not title:
        out["reason"], out["reason_code"] = "There is no draft to edit yet.", "no_draft"
        return out
    try:
        res = await s.engine.draft_edit(
            root, {"outline": {"title": title}}, expect_revision=revision, dry_run=True
        )
    except Exception as exc:
        pe = to_public(exc, operation="draft-edit")
        out["reason"], out["reason_code"] = pe.message, pe.code
        return out
    if res.exit_code == 0 and not res.timed_out:
        out["can_edit"] = True
        return out
    if res.timed_out:
        out["reason"], out["reason_code"] = "The engine did not answer in time.", "engine_timeout"
        return out
    err = _edit_failure(res)
    if err.code == "revision_conflict":
        out["reason"] = "The draft changed while it was being checked. Validate it again."
    else:
        out["reason"] = err.message
        if err.details and err.details.get("errors"):
            out["reason"] += (
                " "
                + "; ".join(
                    e if isinstance(e, str) else e.get("msg", "") for e in err.details["errors"]
                )[:1000]
            )
    out["reason_code"] = err.code
    out["paths"] = (err.details or {}).get("paths", [])
    return out


@router.get("/projects/{project_id}/draft/editable")
async def project_draft_editable(project_id: str, s: State) -> dict:
    """The draft view plus ``editing``: whether the engine allows an edit now, the engine
    revision every save must be based on, and the field limits. Also the Validate action."""
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    view = await _draft_view(s, row, root)
    view["editing"] = await _editing(s, row, root, view)
    return view


def _public_report(data: dict) -> dict:
    keep = (
        "status",
        "dry_run",
        "previous_revision",
        "revision",
        "changed_files",
        "human_edited",
        "storyboard",
        "check",
        "approval_status",
        "approval_changed",
    )
    return {k: data.get(k) for k in keep}


@router.post("/projects/{project_id}/draft/edit")
async def edit_draft(project_id: str, body: DraftEditRequest, s: State) -> dict:
    """Save (or, with ``dry_run``, validate) one edit of the outline and/or script through
    ``ytagent draft-edit``. The engine checks ``expected_revision`` under its lock, validates,
    regenerates the Markdown views and storyboard scenes, and publishes atomically. The UI
    never writes a draft file. A changed draft is 409 ``revision_conflict``; nothing is
    overwritten."""
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    with s.jobs.exclusive(row.id):
        try:
            res = await s.engine.draft_edit(
                root,
                body.patch(),
                expect_revision=body.expected_revision,
                dry_run=body.dry_run,
            )
        except commands.ArgumentError as exc:
            raise ApiError(422, "validation_error", str(exc)) from None
        except Exception as exc:
            pe = to_public(exc, operation="draft-edit")
            raise ApiError(pe.status, pe.code, pe.message) from None
        finally:
            if not body.dry_run:
                s.engine.invalidate(row.id)
                s.projects.touch(row.id)
        if res.timed_out:
            raise ApiError(
                504,
                "engine_timeout",
                "The engine did not finish in time. Reload the draft to see whether the edit "
                "was saved before editing again.",
            )
        if res.exit_code != 0:
            raise _edit_failure(res)
        try:
            data = json.loads(res.stdout)
        except ValueError:
            data = None
        if not isinstance(data, dict) or data.get("ok") is not True:
            raise ApiError(502, "engine_bad_json", "The engine returned an unrecognised result.")
    out: dict = {"result": _public_report(data)}
    if not body.dry_run:
        view = await _draft_view(s, row, root)
        view["editing"] = await _editing(s, row, root, view)
        out["draft"] = view
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
