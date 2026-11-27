"""Typed engine operations used by the API (read-only commands + create)."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

from app.config import home_relative
from app.engine import commands
from app.engine.public_errors import FIXED, to_public
from app.engine.runner import EngineCLI, EngineResult, EngineUnavailable
from app.schemas import EngineInfo, StageOut, StatusSummary

CAPABILITIES = [
    "create",
    "draft",
    "production-status",
    "draft-check",
    "draft-approve",
    "draft-edit",
    "research-check",
    "research-plan",
    "research-collect",
    "research-add-url",
    "research-edit",
    "research-add-document",
    "narration-attest",
    "narration-provenance-init",
    "research-approve",
    "research-apply",
    "research-export",
    "visuals-state",
    "visuals-plan",
    "visuals-acquire",
    "visuals-import",
]
MAX_PATCH_BYTES = 1024 * 1024  # the engine's own limit for a draft-edit/research-edit patch
MAX_DOCUMENT_BYTES = 400_000 * 4  # the engine reads at most 400k characters of UTF-8
MAX_IMAGE_BYTES = 20 * 1024 * 1024  # the engine's ImageLimits.max_bytes (visuals import)
_STATUS_TTL = 20.0


class EngineService:
    def __init__(self, cli: EngineCLI, *, read_timeout: float = 60.0) -> None:
        self.cli = cli
        self.read_timeout = read_timeout
        self._status_cache: dict[str, tuple[float, StatusSummary]] = {}
        self._sem = asyncio.Semaphore(4)

    async def info(self) -> EngineInfo:
        repo = home_relative(self.cli.cwd)
        try:
            res = await self.cli.run(commands.version_args(), timeout=self.read_timeout)
        except EngineUnavailable as exc:
            return EngineInfo(available=False, repo=repo, reason=str(exc))
        if not res.ok:
            return EngineInfo(
                available=False,
                repo=repo,
                reason=f"`ytagent --version` failed: {res.message}. {res.diagnostic()[:500]}",
            )
        version = res.stdout.strip().removeprefix("ytagent").strip() or res.stdout.strip()
        return EngineInfo(available=True, version=version, repo=repo, capabilities=CAPABILITIES)

    async def create(self, root: Path, spec: commands.CreateSpec) -> EngineResult:
        return await self.cli.run(commands.create_args(root, spec), timeout=self.read_timeout)

    async def _json(self, args: list[str], ok_codes: tuple[int, ...] = (0,)) -> Any:
        async with self._sem:
            res = await self.cli.run(args, timeout=self.read_timeout)
        if res.timed_out:
            raise EngineReadError("engine_timeout", "The engine did not answer in time.")
        if res.exit_code not in ok_codes:
            raise EngineReadError(res.classification.code, res.message, res.diagnostic())
        try:
            return res.json()
        except ValueError:
            raise EngineReadError(
                "engine_bad_json", "The engine returned malformed JSON.", res.diagnostic()
            ) from None

    async def production_status(self, project_id: str, root: Path) -> StatusSummary:
        try:
            data = await self._json(commands.production_status_args(root))
            stages = [StageOut.model_validate(s) for s in data.get("stages", [])]
        except (AttributeError, TypeError, ValueError):
            summary = StatusSummary(
                available=False, error=FIXED["engine_bad_json"][1], error_code="engine_bad_json"
            )
        except Exception as exc:  # normalized; diagnostics are logged, not returned
            pe = to_public(exc, operation="production-status")
            summary = StatusSummary(available=False, error=pe.message, error_code=pe.code)
        else:
            summary = StatusSummary(available=True, stages=stages, current_stage=_current(stages))
        self._status_cache[project_id] = (time.monotonic(), summary)
        return summary

    async def cached_status(self, project_id: str, root: Path) -> StatusSummary:
        hit = self._status_cache.get(project_id)
        if hit and time.monotonic() - hit[0] < _STATUS_TTL:
            return hit[1]
        return await self.production_status(project_id, root)

    def invalidate(self, project_id: str) -> None:
        self._status_cache.pop(project_id, None)

    async def draft_check(self, root: Path) -> dict[str, Any]:
        # draft-check exits 2 when the report is not ok; the JSON is still the report.
        data = await self._json(commands.draft_check_args(root), ok_codes=(0, 2))
        if not isinstance(data, dict) or "ok" not in data:
            raise EngineReadError("engine_bad_json", "Unrecognised draft-check report.")
        return data

    async def draft_approve(
        self,
        root: Path,
        *,
        reviewer: str,
        comment: str | None,
        expect_revision: str | None = None,
    ) -> EngineResult:
        """Run ``draft-approve`` (a short, lock-protected engine write). Callers interpret the
        exit code; afterwards the engine's draft-check is the source of truth."""
        args = commands.draft_approve_args(
            root, reviewer=reviewer, comment=comment, expect_revision=expect_revision
        )
        async with self._sem:
            return await self.cli.run(args, timeout=self.read_timeout)

    async def draft_edit(
        self, root: Path, patch: dict[str, Any], *, expect_revision: str, dry_run: bool = False
    ) -> EngineResult:
        """Run ``draft-edit --json`` with the patch on stdin (engine D-117). The engine checks
        the revision, validates and publishes under its lock; callers interpret its JSON."""
        args = commands.draft_edit_args(root, expect_revision=expect_revision, dry_run=dry_run)
        data = json.dumps(patch, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(data) > MAX_PATCH_BYTES:
            raise commands.ArgumentError(f"the edit is larger than {MAX_PATCH_BYTES} bytes")
        async with self._sem:
            return await self.cli.run(args, timeout=self.read_timeout, stdin=data)

    # ------------------------------------------------------------------ research (M3)

    async def research_check(self, root: Path) -> dict[str, Any]:
        """The engine's research report plus its revision (D-118). Exit 14 (not approvable)
        still prints the report."""
        data = await self._json(commands.research_check_args(root), ok_codes=(0, 14))
        if not isinstance(data, dict) or not isinstance(data.get("revision"), str):
            raise EngineReadError(
                "engine_unsupported",
                "This engine does not report a research revision: it predates the research "
                "CLI contract (engine D-118). Update youtube-agent to the pinned ENGINE_REF.",
            )
        return data

    async def collect_preview(self, root: Path, **params: Any) -> EngineResult:
        """``research-collect --dry-run``: the fetch plan, contacting nothing."""
        args = commands.research_collect_args(root, dry_run=True, **params)
        async with self._sem:
            return await self.cli.run(args, timeout=self.read_timeout)

    async def research_edit(
        self, root: Path, patch: dict[str, Any], *, expect_revision: str, dry_run: bool = False
    ) -> EngineResult:
        """``research-edit --json`` with the patch on stdin (engine D-119). The engine checks
        the revision, applies every operation and publishes atomically, or writes nothing."""
        args = commands.research_edit_args(root, expect_revision=expect_revision, dry_run=dry_run)
        data = json.dumps(patch, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(data) > MAX_PATCH_BYTES:
            raise commands.ArgumentError(f"the edit is larger than {MAX_PATCH_BYTES} bytes")
        async with self._sem:
            return await self.cli.run(args, timeout=self.read_timeout, stdin=data)

    async def add_document(
        self, root: Path, text: str, *, expect_revision: str, **fields: Any
    ) -> EngineResult:
        """``research-add-document --json`` with the plain text on stdin (engine D-120)."""
        args = commands.research_add_document_args(root, expect_revision=expect_revision, **fields)
        data = text.encode("utf-8")
        if len(data) > MAX_DOCUMENT_BYTES:
            raise commands.ArgumentError("the document is too large")
        async with self._sem:
            return await self.cli.run(args, timeout=self.read_timeout, stdin=data)

    async def narration_attest(self, root: Path, **kw: Any) -> EngineResult:
        async with self._sem:
            return await self.cli.run(
                commands.narration_attest_args(root, **kw), timeout=self.read_timeout
            )

    async def provenance_init(self, root: Path, *, expect_revision: str) -> EngineResult:
        """Offline regeneration may take longer than a read: allow it twice the read time."""
        args = commands.narration_provenance_init_args(root, expect_revision=expect_revision)
        async with self._sem:
            return await self.cli.run(args, timeout=self.read_timeout * 2)

    async def research_approve(self, root: Path, **kw: Any) -> EngineResult:
        async with self._sem:
            return await self.cli.run(
                commands.research_approve_args(root, **kw), timeout=self.read_timeout
            )

    async def research_apply(self, root: Path, *, expect_revision: str) -> EngineResult:
        args = commands.research_apply_args(root, expect_revision=expect_revision)
        async with self._sem:
            return await self.cli.run(args, timeout=self.read_timeout)

    async def research_export(self, root: Path, *, expect_revision: str) -> EngineResult:
        args = commands.research_export_args(root, expect_revision=expect_revision)
        async with self._sem:
            return await self.cli.run(args, timeout=self.read_timeout)

    # ------------------------------------------------------------------ visuals (M4)

    async def visuals_state(self, root: Path) -> dict[str, Any]:
        """``visuals-state --json``: the engine's one consistent read-only snapshot (D-122)."""
        data = await self._json(commands.visuals_state_args(root))
        if (
            not isinstance(data, dict)
            or data.get("scheme") != "m4-visuals-state-1"
            or not isinstance(data.get("revision"), str)
            or not isinstance(data.get("inputs"), dict)
        ):
            raise EngineReadError(
                "engine_unsupported",
                "This engine has no visuals-state snapshot: it predates the visuals CLI "
                "contract (engine D-122). Update youtube-agent to the pinned ENGINE_REF.",
            )
        return data

    async def acquire_preview(self, root: Path, **params: Any) -> EngineResult:
        """``visuals-acquire --dry-run``: the canonical acquisition preview, contacting
        nothing and writing nothing."""
        args = commands.visuals_acquire_args(root, dry_run=True, **params)
        async with self._sem:
            return await self.cli.run(args, timeout=self.read_timeout)

    async def visuals_import(
        self, root: Path, data: bytes, *, expect_revision: str, **fields: Any
    ) -> EngineResult:
        """``visuals-import --stdin``: the image bytes on stdin, never a path."""
        args = commands.visuals_import_args(root, expect_revision=expect_revision, **fields)
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise commands.ArgumentError("the image is empty or larger than 20 MB")
        async with self._sem:
            return await self.cli.run(args, timeout=self.read_timeout * 2, stdin=data)

    async def visuals_edit(
        self, root: Path, patch: dict[str, Any], *, expect_revision: str, dry_run: bool = False
    ) -> EngineResult:
        """``visuals-edit --json`` with the patch on stdin (engine D-123). The engine checks the
        revision, verifies every image it selects or clears under its lock, and publishes all
        operations atomically, or writes nothing. A dry run writes nothing at all."""
        args = commands.visuals_edit_args(root, expect_revision=expect_revision, dry_run=dry_run)
        data = json.dumps(patch, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(data) > MAX_PATCH_BYTES:
            raise commands.ArgumentError(f"the edit is larger than {MAX_PATCH_BYTES} bytes")
        async with self._sem:
            return await self.cli.run(args, timeout=self.read_timeout, stdin=data)

    async def visuals_apply(
        self, root: Path, *, expect_revision: str, reviewer: str
    ) -> EngineResult:
        """``visuals-apply --json``: re-hashes each candidate under the lock and installs the
        content-addressed images; may take longer than a read."""
        args = commands.visuals_apply_args(root, expect_revision=expect_revision, reviewer=reviewer)
        async with self._sem:
            return await self.cli.run(args, timeout=self.read_timeout * 2)


class EngineReadError(RuntimeError):
    def __init__(self, code: str, message: str, diagnostic: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.diagnostic = diagnostic


def _current(stages: list[StageOut]) -> StageOut | None:
    """The first stage that is not completed, as reported by the engine."""
    for s in stages:
        if s.status != "completed":
            return s
    return stages[-1] if stages else None
