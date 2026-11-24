"""Visuals API (M4 UI-A): the engine's visuals snapshot, hash-addressed images, the plan job,
the preview-bound image search and the image import.

Every mutation is one allowlisted engine command under the visuals revision the page loaded
(``--expect-revision``), refused first by the backend when the current snapshot reports a
pending publication (``recovery_required``) or another revision. The engine is the authority
and checks again under its lock. The UI never writes, moves or deletes an engine file.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response
from pydantic import ValidationError
from python_multipart.multipart import MultipartParser, parse_options_header

from app import visuals as V
from app.api.routes import _engine_json_error
from app.artifacts import engine_revision
from app.engine import commands
from app.engine.errors import redact
from app.engine.public_errors import MAX_ENGINE_MESSAGE, to_public
from app.errors import ApiError
from app.projects import ProjectRow
from app.schemas import (
    AcquirePreviewRequest,
    AcquireRequest,
    JobCreated,
    VisualsImportFields,
    VisualsPlanRequest,
)
from app.state import AppState, get_state

router = APIRouter(prefix="/api/v1")
State = Annotated[AppState, Depends(get_state)]

_IMAGE_READS = asyncio.Semaphore(4)  # bounds concurrent large image reads
_IMAGE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": "inline",
    "Cache-Control": "private, max-age=31536000, immutable",
}
EDITING = {
    "supported": False,
    "reason": "Choosing images and recording rights clearances need the engine's "
    "visuals-edit command (M4 V2), which this engine does not have yet.",
}


# ---------------------------------------------------------------------- snapshot and view


def _provider(s: AppState) -> str:
    if s.settings.visuals_search_provider == "fixture" and s.settings.allow_fixture_provider:
        return "fixture"
    return "wikimedia"


async def _snapshot(s: AppState, row: ProjectRow, root, *, fresh: bool) -> dict:
    try:
        if fresh:
            return await s.visuals.fresh(row.id, root)
        return await s.visuals.current(row.id, root)
    except Exception as exc:
        pe = to_public(exc, operation="visuals-state")
        if pe.code == "engine_unsupported":
            raise ApiError(502, pe.code, pe.message) from None
        raise ApiError(
            503,
            "state_unavailable",
            f"The engine's visuals state could not be read. {pe.message}",
        ) from None


def _view(s: AppState, row: ProjectRow, root, snap: dict) -> dict:
    active = s.jobs.active_for(row.id)
    out = {k: v for k, v in snap.items() if k != "ok"}
    out["narration"] = V.scene_narrations(snap, root)
    out["network"] = {"enabled": s.settings.visuals_network, "search_provider": _provider(s)}
    out["editing"] = EDITING
    out["active_job_id"] = active.id if active else None
    return out


@router.get("/projects/{project_id}/visuals")
async def project_visuals(project_id: str, s: State) -> dict:
    """The visuals workspace: one engine ``visuals-state`` run (every fact, G1 and G3
    included, from that one snapshot), plus the UI's own settings. Nothing is written."""
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    return _view(s, row, root, await _snapshot(s, row, root, fresh=True))


async def _precheck(s: AppState, row: ProjectRow, root, expected_revision: str) -> dict:
    """Refuse before any engine command when the current snapshot (re-validated against the
    files) has a pending publication, or is not at the reviewer's revision."""
    snap = await _snapshot(s, row, root, fresh=False)
    if snap.get("recovery_required"):
        raise ApiError(
            409,
            "recovery_required",
            "An interrupted engine publication must be recovered in the CLI first. Nothing was "
            "done.",
            {"checked_by": "backend", "journals": _journals(snap.get("pending_journals"))},
        )
    if snap.get("revision") != expected_revision:
        raise ApiError(
            409,
            "revision_conflict",
            "The visuals changed since you loaded them (another action, the CLI or a job). "
            "Nothing was done. Reload, then try again.",
            {"current_revision": snap.get("revision")},
        )
    return snap


def _journals(items: object) -> list[dict]:
    out = []
    for f in items if isinstance(items, list) else []:
        if isinstance(f, dict):
            out.append({
                k: (redact(str(f.get(k)))[:500] if f.get(k) is not None else None)
                for k in ("stage", "code", "detail", "next_action")
            })  # fmt: skip
    return out[:10]


def _network_allowed(s: AppState) -> None:
    if not s.settings.visuals_network:
        raise ApiError(
            403,
            "network_disabled",
            "Network visuals actions are turned off (YTA_VISUALS_NETWORK=false).",
        )


# ---------------------------------------------------------------------- engine failures


_PATH_SAFE = re.compile(r"^(?:render/visuals|assets/images)/[A-Za-z0-9._-]{1,120}$")
_JOURNAL = re.compile(r"^render/(?:llm|research|production)/manifest\.json$")


def _ids(value: object, pattern: re.Pattern[str]) -> list[str]:
    if not isinstance(value, list):
        return []
    return [v for v in value if isinstance(v, str) and pattern.fullmatch(v)][:50]


def _visuals_failure(res, what: str) -> ApiError:
    """Map a refused visuals command (``--json`` error envelope, engine D-122)."""
    jerr = _engine_json_error(res)
    code = jerr.get("code")
    message = redact(str(jerr.get("message") or "")).strip()
    first = message.splitlines()[0].removeprefix("error:").strip()[:MAX_ENGINE_MESSAGE]
    details = jerr.get("details") if isinstance(jerr.get("details"), dict) else {}
    if code == "revision_mismatch":
        current = jerr.get("current_revision") or details.get("current_revision")
        return ApiError(
            409,
            "revision_conflict",
            "The visuals changed since you loaded them (another action, the CLI or a job). "
            "Nothing was done. Reload, then try again.",
            {"current_revision": current if engine_revision({"revision": current}) else None},
        )
    if code == "recovery_required":
        return ApiError(
            409,
            "recovery_required",
            "An interrupted engine publication must be recovered in the CLI first. Nothing was "
            "done.",
            {"checked_by": "engine", "journals": _ids(details.get("journals"), _JOURNAL)},
        )
    if code == "preview_mismatch":
        sha = details.get("preview_sha256")
        hosts = details.get("hosts")
        return ApiError(
            409,
            "preview_mismatch",
            "What this search would contact changed since you confirmed it. Nothing was "
            "contacted. Check again and confirm the new list.",
            {
                "checked_by": "engine",
                "preview_sha256": sha if engine_revision({"revision": sha}) else None,
                "hosts": [h for h in hosts if isinstance(h, str)][:50]
                if isinstance(hosts, list)
                else [],
            },
        )
    if code == "catalog_untrusted":
        return ApiError(
            409,
            "catalog_untrusted",
            "The candidate catalogue was changed outside the engine, so nothing in it is "
            "trusted. A new search rebuilds it.",
        )
    if code == "image_integrity":
        return ApiError(
            409,
            "image_integrity",
            first or "An image file does not match its recorded hash.",
            {
                "candidate_ids": _ids(details.get("candidate_ids"), commands.CANDIDATE_ID_RE),
                "asset_ids": _ids(details.get("asset_ids"), commands.ASSET_ID_RE),
                "paths": _ids(details.get("paths"), _PATH_SAFE),
            },
        )
    if code in ("g1_not_current", "not_ready", "human_edit_conflict"):
        return ApiError(409, code, first or f"The engine refused to {what}.")
    if code == "invalid_input":
        return ApiError(422, "visuals_refused", f"The engine refused to {what}: {first}")
    if code == "error" and res.exit_code == 3:  # e.g. undecodable import bytes
        return ApiError(422, "visuals_refused", f"The engine refused to {what}: {first}")
    if res.exit_code == 9:
        return ApiError(409, "engine_conflict", "Another engine run is using this project.")
    return ApiError(502, res.classification.code, first or res.classification.summary)


def _ok_json(res) -> dict:
    if res.timed_out:
        raise ApiError(
            504,
            "engine_timeout",
            "The engine did not finish in time. Reload the visuals to see whether anything "
            "was recorded before trying again.",
        )
    try:
        data = json.loads(res.stdout)
    except ValueError:
        data = None
    if not isinstance(data, dict) or data.get("ok") is not True:
        raise ApiError(502, "engine_bad_json", "The engine returned an unrecognised result.")
    return data


# ---------------------------------------------------------------------- images


def _image_response(data: bytes, content_type: str, sha: str) -> Response:
    return Response(
        content=data, media_type=content_type, headers={**_IMAGE_HEADERS, "ETag": f'"{sha}"'}
    )


def _sha_param(sha256: str | None) -> str:
    if not isinstance(sha256, str) or not V.SHA_RE.fullmatch(sha256):
        raise ApiError(400, "invalid_input", "sha256 must be 64 lowercase hexadecimal digits.")
    return sha256


async def _read_image(root, rel: str, sha: str, pattern) -> tuple[bytes, str]:
    async with _IMAGE_READS:
        try:
            return await asyncio.to_thread(V.read_verified, root, rel, sha, pattern)
        except V.VisualsError as exc:
            raise ApiError(exc.status, exc.code, exc.message, exc.details) from None


@router.get("/projects/{project_id}/visuals/candidates/{candidate_id}/image")
async def candidate_image(
    project_id: str,
    candidate_id: str,
    s: State,
    sha256: Annotated[str | None, Query()] = None,
) -> Response:
    """A candidate's normalised image, by engine ID and expected hash, from a current
    snapshot's trusted catalogue, verified on the exact bytes served."""
    sha = _sha_param(sha256)
    if not commands.CANDIDATE_ID_RE.fullmatch(candidate_id):
        raise ApiError(400, "invalid_input", "Not a candidate ID.")
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    snap = await _snapshot(s, row, root, fresh=False)
    if not snap.get("catalog_trusted"):
        raise ApiError(
            409, "catalog_untrusted", "The candidate catalogue is not trusted; nothing is served."
        )
    rec = V.candidate_record(snap, candidate_id)
    if rec is None or not rec.get("local_path") or not rec.get("sha256"):
        raise ApiError(404, "not_found", "No such candidate image in this project.")
    if rec["sha256"] != sha:
        raise ApiError(
            409,
            "image_changed",
            "This image URL is outdated: the candidate now has another image. Reload.",
            {"current_sha256": rec["sha256"]},
        )
    data, ctype = await _read_image(root, rec["local_path"], sha, V.CANDIDATE_PATH)
    return _image_response(data, ctype, sha)


@router.get("/projects/{project_id}/visuals/assets/{asset_id}/image")
async def asset_image(
    project_id: str,
    asset_id: str,
    s: State,
    sha256: Annotated[str | None, Query()] = None,
) -> Response:
    """An applied asset's image: its ``assets.json`` record must be the one ``visuals-apply``
    wrote (``record_intact``), and its bytes must match the content address."""
    sha = _sha_param(sha256)
    if not commands.ASSET_ID_RE.fullmatch(asset_id):
        raise ApiError(400, "invalid_input", "Not an asset ID.")
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    snap = await _snapshot(s, row, root, fresh=False)
    rec = V.asset_record(snap, asset_id)
    if rec is None or not rec.get("local_path") or not rec.get("sha256"):
        raise ApiError(404, "not_found", "No such applied image in this project.")
    if rec["sha256"] != sha:
        raise ApiError(
            409,
            "image_changed",
            "This image URL is outdated: the asset now has another image. Reload.",
            {"current_sha256": rec["sha256"]},
        )
    if rec.get("record_intact") is not True:
        raise ApiError(
            409,
            "image_integrity",
            "The asset's record is not the one visuals-apply wrote; nothing is served.",
        )
    data, ctype = await _read_image(root, rec["local_path"], sha, V.ASSET_PATH)
    return _image_response(data, ctype, sha)


# ---------------------------------------------------------------------- plan and acquire


@router.post("/projects/{project_id}/visuals/plan", response_model=JobCreated, status_code=202)
async def visuals_plan_job(project_id: str, body: VisualsPlanRequest, s: State) -> JobCreated:
    """``visuals-plan`` as a job (no network, no LLM). Never ``--replace-plan``."""
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    await _precheck(s, row, root, body.expected_revision)
    args = commands.visuals_plan_args(root, expect_revision=body.expected_revision)
    job = s.jobs.submit(project_id, "visuals-plan", args, {})
    s.visuals.invalidate(row.id)
    s.projects.touch(project_id)
    return JobCreated(job_id=job.id, project_id=project_id, status=job.status)


def _acquire_params(s: AppState, body: AcquirePreviewRequest) -> dict[str, Any]:
    return {
        "expect_revision": body.expected_revision,
        "search_provider": _provider(s),
        "scene_ids": list(body.scene_ids),
        "max_candidates_per_scene": body.max_candidates_per_scene,
    }


async def _preview(s: AppState, root, body: AcquirePreviewRequest) -> dict:
    try:
        res = await s.engine.acquire_preview(root, **_acquire_params(s, body))
    except commands.ArgumentError as exc:
        raise ApiError(422, "validation_error", str(exc)) from None
    except Exception as exc:
        pe = to_public(exc, operation="visuals-acquire --dry-run")
        raise ApiError(pe.status, pe.code, pe.message) from None
    if res.exit_code != 0 and not res.timed_out:
        raise _visuals_failure(res, "preview the image search")
    data = _ok_json(res)
    preview, digest = data.get("preview"), data.get("preview_sha256")
    if (
        not isinstance(preview, dict)
        or not engine_revision({"revision": digest})
        or preview.get("scheme") != "m4-acquire-preview-1"
        or not isinstance(preview.get("hosts"), list)
    ):
        raise ApiError(502, "engine_bad_json", "The engine returned an unrecognised preview.")
    return {"preview": preview, "preview_sha256": digest}


@router.post("/projects/{project_id}/visuals/acquire/preview")
async def visuals_acquire_preview(project_id: str, body: AcquirePreviewRequest, s: State) -> dict:
    """The engine's canonical acquisition preview (``visuals-acquire --dry-run``): the exact
    scenes, queries and hosts a search with these parameters may contact. Nothing is
    contacted or written."""
    _network_allowed(s)
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    await _precheck(s, row, root, body.expected_revision)
    return await _preview(s, root, body)


@router.post("/projects/{project_id}/visuals/acquire", response_model=JobCreated, status_code=202)
async def visuals_acquire_job(project_id: str, body: AcquireRequest, s: State) -> JobCreated:
    """Run the image search the reviewer confirmed. The preview is computed again
    immediately before the job is queued; the job starts only if its hash and hosts are
    exactly what was confirmed (``preview_mismatch``, checked by the backend). The engine
    recomputes it before any request (``--expect-preview``), enforces the hosts on every
    request and redirect, and checks the revision again before recording anything."""
    _network_allowed(s)
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    await _precheck(s, row, root, body.expected_revision)
    current = await _preview(s, root, body)
    confirmed = sorted(set(body.allow_hosts))
    hosts = sorted(set(current["preview"]["hosts"]))
    if current["preview_sha256"] != body.preview_sha256 or hosts != confirmed:
        raise ApiError(
            409,
            "preview_mismatch",
            "What this search would contact changed since you confirmed it. Nothing was "
            "contacted. Check the new list and confirm it again.",
            {"checked_by": "backend", **current},
        )
    if not confirmed:
        raise ApiError(422, "nothing_to_search", "There is nothing to search.")
    try:
        args = commands.visuals_acquire_args(
            root,
            expect_preview=body.preview_sha256,
            allow_hosts=confirmed,
            **_acquire_params(s, body),
        )
    except commands.ArgumentError as exc:
        raise ApiError(422, "validation_error", str(exc)) from None
    job = s.jobs.submit(project_id, "visuals-acquire", args, {"hosts": confirmed})
    s.visuals.invalidate(row.id)
    s.projects.touch(project_id)
    return JobCreated(job_id=job.id, project_id=project_id, status=job.status)


# ---------------------------------------------------------------------- import


MAX_FIELD_BYTES = 8 * 1024
MAX_BODY = V.MAX_IMAGE_BYTES + 256 * 1024
FILE_FIELD = "file"
_TITLE_SAFE = re.compile(r"[^A-Za-z0-9 ._()-]+")


class _Upload:
    """A streaming multipart reader: text fields first, then one ``file`` part, kept in
    memory only. ``ready`` turns true once the file part's headers are parsed, so the caller
    validates the fields before reading the rest of the body."""

    def __init__(self, boundary: bytes) -> None:
        self.fields: dict[str, str] = {}
        self.filename: str | None = None
        self.file = bytearray()
        self.ready = False
        self.error: str | None = None
        self._headers: dict[str, str] = {}
        self._hf = bytearray()
        self._hv = bytearray()
        self._name: str | None = None
        self._buf = bytearray()
        self.parser = MultipartParser(
            boundary,
            {
                "on_part_begin": self._begin,
                "on_header_field": lambda d, a, b: self._hf.extend(d[a:b]),
                "on_header_value": lambda d, a, b: self._hv.extend(d[a:b]),
                "on_header_end": self._header_end,
                "on_headers_finished": self._headers_done,
                "on_part_data": self._data,
                "on_part_end": self._end,
            },
            max_size=MAX_BODY,
        )

    def _fail(self, msg: str) -> None:
        self.error = self.error or msg

    def _begin(self) -> None:
        self._headers, self._name, self._buf = {}, None, bytearray()

    def _header_end(self) -> None:
        self._headers[self._hf.decode("latin-1").lower()] = self._hv.decode("latin-1")
        self._hf.clear()
        self._hv.clear()

    def _headers_done(self) -> None:
        disp, opts = parse_options_header(self._headers.get("content-disposition", ""))
        name = opts.get(b"name", b"").decode("utf-8", "replace")
        if disp != b"form-data" or not name:
            return self._fail("every part needs a form-data name")
        if self.ready:
            return self._fail("the file must be the last part")
        if name == FILE_FIELD:
            self.filename = opts.get(b"filename", b"").decode("utf-8", "replace")
            self.ready = True
        elif name in self.fields:
            return self._fail(f"{name} was sent twice")
        self._name = name

    def _data(self, d: bytes, a: int, b: int) -> None:
        if self._name == FILE_FIELD:
            self.file.extend(d[a:b])
            if len(self.file) > V.MAX_IMAGE_BYTES:
                self._fail("the image is larger than 20 MB")
        elif self._name is not None:
            self._buf.extend(d[a:b])
            if len(self._buf) > MAX_FIELD_BYTES:
                self._fail(f"{self._name} is too long")

    def _end(self) -> None:
        if self._name and self._name != FILE_FIELD:
            try:
                self.fields[self._name] = self._buf.decode("utf-8")
            except UnicodeDecodeError:
                self._fail(f"{self._name} is not UTF-8")


def _title(upload: _Upload, fields: VisualsImportFields) -> str:
    if fields.title:
        return fields.title
    name = (upload.filename or "").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    name = " ".join(_TITLE_SAFE.sub(" ", name).split())[:200]
    return name or "Imported image"


async def _read_upload(request: Request, on_ready) -> tuple[_Upload, VisualsImportFields]:
    ctype, opts = parse_options_header(request.headers.get("content-type", ""))
    boundary = opts.get(b"boundary")
    if ctype != b"multipart/form-data" or not boundary:
        raise ApiError(415, "unsupported_media_type", "Send the image as multipart/form-data.")
    try:
        declared = int(request.headers.get("content-length", "0"))
    except ValueError:
        declared = 0
    if declared > MAX_BODY:
        raise ApiError(413, "too_large", "The image is larger than 20 MB.")
    up = _Upload(boundary)
    fields: VisualsImportFields | None = None
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BODY:
            raise ApiError(413, "too_large", "The image is larger than 20 MB.")
        try:
            up.parser.write(chunk)
        except Exception:
            raise ApiError(400, "bad_request", "The upload is not valid multipart data.") from None
        if up.error:
            status = 413 if "20 MB" in up.error else 422
            raise ApiError(status, "too_large" if status == 413 else "validation_error", up.error)
        if up.ready and fields is None:
            # The file part has started: everything else is known. Validate it and check the
            # revision now, before reading the image itself.
            fields = _fields(up.fields)
            await on_ready(fields)
    if fields is None:
        raise ApiError(422, "validation_error", "No image file was sent (field 'file').")
    try:
        up.parser.finalize()
    except Exception:
        raise ApiError(400, "bad_request", "The upload is not valid multipart data.") from None
    if up.error:
        raise ApiError(422, "validation_error", up.error)
    return up, fields


def _fields(raw: dict[str, str]) -> VisualsImportFields:
    try:
        return VisualsImportFields.model_validate(raw)
    except ValidationError as exc:
        errs: dict[str, str] = {}
        for e in exc.errors():
            loc = ".".join(str(p) for p in e.get("loc", ())) or "request"
            errs[loc] = str(e.get("msg", "invalid")).removeprefix("Value error, ")
        raise ApiError(
            422, "validation_error", "Some fields are invalid.", {"fields": errs}
        ) from None


@router.post("/projects/{project_id}/visuals/import")
async def visuals_import(project_id: str, request: Request, s: State) -> dict:
    """Add an image the reviewer owns or has cleared (``visuals-import --stdin``). The text
    fields come first; they are validated and the revision is checked against the current
    snapshot before the file part is read. The bytes stay in memory and go to the engine on
    stdin; the engine checks the revision again under its lock and is authoritative."""
    row = s.projects.require(project_id)
    root = s.projects.confined_root(row)
    with s.jobs.exclusive(row.id):

        async def on_ready(fields: VisualsImportFields) -> None:
            await _precheck(s, row, root, fields.expected_revision)

        up, fields = await _read_upload(request, on_ready)
        data = bytes(up.file)
        if not data:
            raise ApiError(422, "validation_error", "The image file is empty.")
        if V.sniff(data) is None:
            raise ApiError(
                422,
                "invalid_input",
                "The file is not a JPEG, PNG, WebP or TIFF image (checked by its first bytes).",
            )
        try:
            res = await s.engine.visuals_import(
                root,
                data,
                expect_revision=fields.expected_revision,
                scene_id=fields.scene_id,
                kind=fields.kind,
                title=_title(up, fields),
                provenance=fields.provenance,
                source_url=fields.source_url,
                creator=fields.creator,
                license_name=fields.license_name,
                license_url=fields.license_url,
                attribution=fields.attribution,
            )
        except commands.ArgumentError as exc:
            raise ApiError(422, "validation_error", str(exc)) from None
        except Exception as exc:
            pe = to_public(exc, operation="visuals-import")
            raise ApiError(pe.status, pe.code, pe.message) from None
        finally:
            s.visuals.invalidate(row.id)
            s.engine.invalidate(row.id)
            s.projects.touch(row.id)
        if res.exit_code != 0 and not res.timed_out:
            raise _visuals_failure(res, "import the image")
        out = _ok_json(res)
    result = {
        "candidate_id": out.get("candidate_id"),
        "scene_id": out.get("scene_id"),
        "sha256": out.get("sha256"),
        "width": out.get("width"),
        "height": out.get("height"),
        "rights_status": out.get("rights_status"),
        "warnings": [redact(str(w))[:500] for w in out.get("warnings") or []][:20],
        "revision": out.get("revision") if engine_revision(out) else None,
    }
    snap = await _snapshot(s, row, root, fresh=True)
    return {"result": result, "visuals": _view(s, row, root, snap)}
