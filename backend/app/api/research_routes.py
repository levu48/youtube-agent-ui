"""Research review API (M3 UI-B): claim edits, evidence, translations, decisions, history,
completeness, rechecks, imported documents, primary attestations and narration lineage.

Every mutation is one allowlisted engine command (``research-edit``, ``research-add-document``,
``narration-attest``, ``narration-provenance-init``) under the research revision the page
loaded, held with ``JobManager.exclusive``. The UI never writes an engine file; reads are of
documented artifacts only, and the engine's ``research-check`` decides what counts.
"""

from __future__ import annotations

import json
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query

from app import research as RS
from app.api.routes import _engine_json_error, _research_failure, _search_provider
from app.artifacts import engine_revision
from app.engine import commands
from app.engine.errors import redact
from app.engine.public_errors import MAX_ENGINE_MESSAGE, to_public
from app.errors import ApiError
from app.projects import ProjectRow
from app.research_schemas import (
    DocumentImportRequest,
    NarrationAttestRequest,
    ProvenanceInitRequest,
    ResearchEditRequest,
)
from app.state import AppState, get_state

router = APIRouter(prefix="/api/v1")
State = Annotated[AppState, Depends(get_state)]

HISTORY_KINDS = (
    "claim_review",
    "source_recheck",
    "completeness",
    "primary_source_attestation",
    "migration",
)
INTEGRITY_CODES = (
    "history_tampered",
    "narration_provenance_invalid",
    "narration_provenance_missing",
)
LINEAGE_CODES = (
    "fixture_narration",
    "narration_provenance_missing",
    "narration_provenance_invalid",
)


# ---------------------------------------------------------------------- reads


async def _report(s: AppState, root) -> tuple[dict | None, dict | None]:
    try:
        return await s.engine.research_check(root), None
    except Exception as exc:  # normalised; the page shows why the report is missing
        pe = to_public(exc, operation="research-check")
        return None, {"code": pe.code, "message": pe.message}


def _records(root) -> dict[str, Any]:
    try:
        return {
            "sources": RS.sources(root),
            "snapshots": RS.snapshots(root),
            "evidence": RS.evidence(root),
            "plan": RS.plan(root),
            "review": RS.review_file(root),
            "scenes": list(RS.scenes(root).values()),
            "records_error": None,
        }
    except RS.ResearchReadError as exc:
        return {
            "sources": [],
            "snapshots": [],
            "evidence": [],
            "plan": None,
            "review": None,
            "scenes": [],
            "records_error": {"code": exc.code, "message": exc.message},
        }


def _editing(report: dict | None, records: dict[str, Any]) -> dict[str, Any]:
    """Whether the page may offer research edits now, and why not. The engine decides on
    every save; this only avoids offering what it would certainly refuse."""
    review = records.get("review") or {}
    if report is None:
        return {"supported": False, "reason": "The engine's research report is unavailable."}
    if records.get("plan") is None:
        return {"supported": False, "reason": "Prepare the claims first."}
    if review.get("present") and not review.get("supported"):
        return {
            "supported": False,
            "reason": "research-review.json has a schema this UI does not know.",
        }
    return {
        "supported": True,
        "reason": None,
        "migration_required": review.get("schema_version") == "m5-review-0.1",
        "legacy_ids": any(link.get("id") is None for link in records.get("evidence") or [])
        or any(r.get("id") is None for r in review.get("source_rechecks") or []),
    }


async def research_view(s: AppState, row: ProjectRow, root) -> dict:
    """The research workspace: the engine's report (with its revision), plus read-only
    claim, source, snapshot, evidence and review records."""
    report, report_error = await _report(s, root)
    records = _records(root)
    status = await s.engine.cached_status(row.id, root)
    stage = next((st.model_dump() for st in status.stages if st.stage == "research"), None)
    active = s.jobs.active_for(row.id)
    return {
        "report": report,
        "report_error": report_error,
        "revision": report.get("revision") if report else None,
        "started": RS.research_started(root),
        **records,
        "editing": _editing(report, records),
        "stage": stage,
        "network": {
            "enabled": s.settings.research_network,
            "search_provider": _search_provider(s),
        },
        "active_job_id": active.id if active else None,
    }


@router.get("/projects/{project_id}/research/history")
async def research_history(
    project_id: str,
    s: State,
    kind: Annotated[str | None, Query(max_length=40)] = None,
    subject_id: Annotated[str | None, Query(max_length=80, pattern=r"^[a-z0-9-]+$")] = None,
    after_seq: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=RS.HISTORY_PAGE_MAX)] = 50,
) -> dict:
    """The append-only review history, read only. ``chain_ok`` is the engine's own integrity
    check (no ``history_tampered`` item) at ``revision``."""
    if kind is not None and kind not in HISTORY_KINDS:
        raise ApiError(422, "validation_error", f"kind must be one of {', '.join(HISTORY_KINDS)}")
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    report, report_error = await _report(s, root)
    try:
        page = RS.history_page(
            root, kind=kind, subject_id=subject_id, after_seq=after_seq, limit=limit
        )
    except RS.ResearchReadError as exc:
        raise ApiError(exc.status, exc.code, exc.message) from None
    items = (report or {}).get("items") or []
    return {
        **page,
        "chain_ok": None
        if report is None
        else not any(i.get("code") == "history_tampered" for i in items),
        "revision": report.get("revision") if report else None,
        "report_error": report_error,
    }


# ---------------------------------------------------------------------- failures


def _first_line(message: str) -> str:
    first = message.splitlines()[0].removeprefix("error:").strip() if message else ""
    return first[:MAX_ENGINE_MESSAGE]


def _write_failure(res, what: str) -> ApiError:
    """Map a refused research write (``--json`` error envelope, engine D-118/119/120)."""
    jerr = _engine_json_error(res)
    code = jerr.get("code")
    first = _first_line(redact(str(jerr.get("message") or "")).strip())
    details = jerr.get("details")
    if code == "invalid_patch":
        errors = [
            {
                "loc": str(d.get("loc", ""))[:200],
                "msg": redact(str(d.get("msg", "")))[:500],
                "code": str(d.get("code", ""))[:60] or None,
            }
            for d in (details if isinstance(details, list) else [])
            if isinstance(d, dict)
        ][:50]
        if any(e["code"] == "history_tampered" for e in errors):
            return ApiError(
                409,
                "history_tampered",
                "The review history in research-review.json is not intact, so the engine "
                "refuses every edit. Restore it from a backup or resolve it in the CLI.",
                {"errors": errors},
            )
        return ApiError(
            422, "invalid_edit", first or f"The engine refused to {what}.", {"errors": errors}
        )
    if code == "migration_required":
        return ApiError(
            409,
            "migration_required",
            "The research records use the older review format. Upgrade them first; decisions "
            "are kept and need confirming again.",
        )
    if code == "document_exists":
        safe = {k: v for k, v in (details or {}).items() if k in ("source_id", "snapshot_id")}
        return ApiError(422, "invalid_edit", first or "This document is already imported.", {
            "errors": [{"loc": "text", "msg": first, "code": "document_exists"}], **safe,
        })  # fmt: skip
    if code == "lineage_refused":
        reason = (details or {}).get("reason") if isinstance(details, dict) else None
        status = 409 if reason in INTEGRITY_CODES else 422
        return ApiError(
            status, "lineage_refused", first or "The engine refused.", {"reason": reason}
        )
    if code == "human_edit_conflict":
        return ApiError(
            409,
            "human_edit_conflict",
            "The engine refused to overwrite hand edits. Resolve them in the CLI first.",
        )
    if code == "invalid_input":
        return ApiError(422, "invalid_edit", f"The engine refused to {what}: {first}", {
            "errors": [{"loc": "", "msg": first, "code": "invalid_input"}],
        })  # fmt: skip
    return _research_failure(res, what)


def _ok_json(res) -> dict:
    if res.timed_out:
        raise ApiError(
            504,
            "engine_timeout",
            "The engine did not finish in time. Reload the research to see whether the change "
            "was recorded before trying again.",
        )
    try:
        data = json.loads(res.stdout)
    except ValueError:
        data = None
    if not isinstance(data, dict) or data.get("ok") is not True:
        raise ApiError(502, "engine_bad_json", "The engine returned an unrecognised result.")
    return data


async def _engine_write(s: AppState, row: ProjectRow, what: str, call) -> dict:
    """Run one short engine write while holding the project; map refusals."""
    with s.jobs.exclusive(row.id):
        try:
            res = await call()
        except commands.ArgumentError as exc:
            raise ApiError(422, "validation_error", str(exc)) from None
        except ApiError:
            raise
        except Exception as exc:
            pe = to_public(exc, operation=what)
            raise ApiError(pe.status, pe.code, pe.message) from None
        finally:
            s.engine.invalidate(row.id)
            s.projects.touch(row.id)
        if res.exit_code != 0 and not res.timed_out:
            raise _write_failure(res, what)
        return _ok_json(res)


def _revision_or_none(value: object) -> str | None:
    return value if engine_revision({"revision": value}) else None


# ---------------------------------------------------------------------- research-edit


_EDIT_KEEP = (
    "status",
    "dry_run",
    "previous_revision",
    "revision",
    "changed_files",
    "created",
    "occurrences",
    "check",
    "approval_status",
)


@router.post("/projects/{project_id}/research/edit")
async def research_edit(project_id: str, body: ResearchEditRequest, s: State) -> dict:
    """Apply (or, with ``dry_run``, validate and locate) research edits through
    ``ytagent research-edit``. All operations publish together or not at all. A changed
    research is 409 ``revision_conflict``; nothing is overwritten."""
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    data = await _engine_write(
        s,
        row,
        "edit the research",
        lambda: s.engine.research_edit(
            root, body.patch(), expect_revision=body.expected_revision, dry_run=body.dry_run
        ),
    )
    out: dict[str, Any] = {"result": {k: data.get(k) for k in _EDIT_KEEP}}
    if not body.dry_run:
        out["research"] = await research_view(s, row, root)
    return out


# ---------------------------------------------------------------------- documents


@router.post("/projects/{project_id}/research/documents")
async def research_add_document(project_id: str, body: DocumentImportRequest, s: State) -> dict:
    """Import an offline document as a ``doc-`` source with this edition's provenance. No
    network is used; a declared URL is data only and never fetched."""
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    if body.new_version_of is not None:
        known = {src.get("id") for src in RS.sources(root) if src.get("kind") == "document"}
        if body.new_version_of not in known:
            raise ApiError(
                422,
                "validation_error",
                "new_version_of must name a document source of this project.",
            )
    fields = body.model_dump(
        exclude={"expected_revision", "text", "new_version_of"}, exclude_none=True
    )
    data = await _engine_write(
        s,
        row,
        "import the document",
        lambda: s.engine.add_document(
            root,
            body.text,
            expect_revision=body.expected_revision,
            new_version_of=body.new_version_of,
            **fields,
        ),
    )
    result = {
        "source_id": data.get("source_id"),
        "snapshot_id": data.get("snapshot_id"),
        "supersedes_snapshot_id": data.get("supersedes_snapshot_id"),
        "chars": data.get("chars"),
        "revision": _revision_or_none(data.get("revision")),
    }
    return {"result": result, "research": await research_view(s, row, root)}


# ---------------------------------------------------------------------- narration lineage


async def narration_view(s: AppState, row: ProjectRow, root) -> dict:
    report, report_error = await _report(s, root)
    try:
        lineage = RS.lineage(root)
        lineage_error = None
    except RS.ResearchReadError as exc:
        lineage, lineage_error = None, {"code": exc.code, "message": exc.message}
    items = [i for i in (report or {}).get("items") or [] if i.get("code") in LINEAGE_CODES]
    return {
        "revision": report.get("revision") if report else None,
        "report_error": report_error,
        "lineage": lineage,
        "lineage_error": lineage_error,
        "items": items,
        "needs_init": any(i.get("code") == "narration_provenance_missing" for i in items),
    }


@router.get("/projects/{project_id}/draft/narration")
async def draft_narration(project_id: str, s: State) -> dict:
    """Which narration sentences are still fixture text or unattested rewrites (engine D-120),
    with the engine's blocking items. Read only."""
    row = s.projects.require(project_id)
    return await narration_view(s, row, s.projects.confined_root(row))


@router.post("/projects/{project_id}/draft/narration/attest")
async def draft_narration_attest(project_id: str, body: NarrationAttestRequest, s: State) -> dict:
    """``narration-attest``: a reviewer attests rewritten sentences. The engine refuses
    unchanged or close text and is the only judge."""
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    data = await _engine_write(
        s,
        row,
        "attest the rewrite",
        lambda: s.engine.narration_attest(
            root,
            expect_revision=body.expected_revision,
            reviewer=body.reviewer,
            statement=body.statement,
            segment_ids=list(body.segment_ids),
        ),
    )
    return {"result": _lineage_result(data), "narration": await narration_view(s, row, root)}


@router.post("/projects/{project_id}/draft/narration/provenance-init")
async def draft_provenance_init(project_id: str, body: ProvenanceInitRequest, s: State) -> dict:
    """``narration-provenance-init`` for a fixture project drafted before lineage existed. It
    never marks anything human-written."""
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    data = await _engine_write(
        s,
        row,
        "initialise the narration lineage",
        lambda: s.engine.provenance_init(root, expect_revision=body.expected_revision),
    )
    return {"result": _lineage_result(data), "narration": await narration_view(s, row, root)}


def _lineage_result(data: dict) -> dict:
    return {
        "status": data.get("status"),
        "segments": [x for x in data.get("segments") or [] if isinstance(x, str)][:500],
        "remaining": data.get("remaining"),
        "recovered": data.get("recovered"),
        "revision": _revision_or_none(data.get("revision")),
    }
