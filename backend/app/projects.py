"""Project registry: safe roots, creation through the engine, discovery under the root."""

from __future__ import annotations

import asyncio
import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import Settings, home_relative
from app.db import Database, utcnow
from app.engine import commands
from app.engine.runner import EngineUnavailable
from app.engine.service import EngineService
from app.errors import ApiError

MAX_INPUT_BYTES = 256 * 1024


@dataclass(frozen=True)
class ProjectRow:
    id: str
    slug: str
    root_path: str
    display_name: str
    created_at: str
    updated_at: str

    @property
    def root(self) -> Path:
        return Path(self.root_path)


class ProjectService:
    def __init__(self, settings: Settings, db: Database, engine: EngineService) -> None:
        self.settings = settings
        self.db = db
        self.engine = engine
        self._create_lock = asyncio.Lock()

    # ------------------------------------------------------------------ paths

    def root_for(self, slug: str) -> Path:
        """``<canonical projects root>/<slug>`` for a validated slug."""
        commands.check_slug(slug)
        base = self.settings.projects_root_real
        root = base / slug
        if root.parent != base:
            raise ApiError(422, "invalid_slug", "Invalid project slug.")
        return root

    def confined_root(self, row: ProjectRow) -> Path:
        """Re-validate a registered project's directory immediately before use."""
        base = self.settings.projects_root_real
        root = Path(row.root_path)
        try:
            st = os.lstat(root)
        except FileNotFoundError:
            raise ApiError(
                409, "project_missing", "The project directory no longer exists."
            ) from None
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            raise ApiError(409, "project_unsafe", "The project path is not a plain directory.")
        if root.resolve(strict=True).parent != base:
            raise ApiError(409, "project_unsafe", "The project directory is outside the root.")
        return root

    def preview(self, slug: str) -> dict[str, Any]:
        try:
            root = self.root_for(slug)
        except commands.ArgumentError as exc:
            return {"slug": slug, "location": "", "available": False, "reason": str(exc)}
        reason = None
        if self.get(slug) is not None:
            reason = "A project with this slug is already registered."
        elif os.path.lexists(root):
            reason = "A folder with this name already exists in the projects folder."
        return {
            "slug": slug,
            "location": home_relative(root),
            "available": reason is None,
            "reason": reason,
        }

    # ------------------------------------------------------------------ registry

    def get(self, project_id: str) -> ProjectRow | None:
        row = self.db.query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
        return ProjectRow(**dict(row)) if row else None

    def require(self, project_id: str) -> ProjectRow:
        if not commands.SLUG_RE.fullmatch(project_id):
            raise ApiError(404, "project_not_found", "Unknown project.")
        row = self.get(project_id)
        if row is None:
            raise ApiError(404, "project_not_found", "Unknown project.")
        return row

    def list(self) -> list[ProjectRow]:
        rows = self.db.query("SELECT * FROM projects ORDER BY updated_at DESC")
        return [ProjectRow(**dict(r)) for r in rows]

    def _insert(self, slug: str, root: Path, display_name: str) -> ProjectRow:
        now = utcnow()
        with self.db.tx() as c:
            if c.execute("SELECT 1 FROM projects WHERE id = ?", (slug,)).fetchone():
                raise ApiError(409, "project_exists", "A project with this slug already exists.")
            c.execute(
                "INSERT INTO projects(id, slug, root_path, display_name, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (slug, slug, str(root), display_name, now, now),
            )
        return self.require(slug)

    def touch(self, project_id: str) -> None:
        with self.db.tx() as c:
            c.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (utcnow(), project_id))

    # ------------------------------------------------------------------ create

    async def create(self, spec: commands.CreateSpec, slug: str) -> ProjectRow:
        root = self.root_for(slug)
        # One create at a time: prevents two requests racing on the same directory.
        async with self._create_lock:
            if self.get(slug) is not None:
                raise ApiError(409, "project_exists", "A project with this slug already exists.")
            # The engine accepts an existing empty directory, so the UI enforces
            # "must not exist" itself, immediately before invoking the engine.
            if os.path.lexists(root):
                raise ApiError(
                    409,
                    "path_exists",
                    "A folder with this name already exists in the projects folder. "
                    "Choose another slug, or register the existing project.",
                )
            try:
                res = await self.engine.create(root, spec)
            except EngineUnavailable as exc:
                raise ApiError(503, "engine_unavailable", str(exc)) from None
            if not res.ok:
                status = 422 if res.exit_code == 2 else 502
                raise ApiError(
                    status,
                    res.classification.code if not res.timed_out else "engine_timeout",
                    f"The engine could not create the project: {res.message}",
                    {"exit_code": res.exit_code, "diagnostic": res.diagnostic()},
                )
            self._check_engine_project(root)
            display = spec.idea if len(spec.idea) <= 120 else spec.idea[:117] + "…"
            return self._insert(slug, root, display)

    def _check_engine_project(self, root: Path) -> None:
        base = self.settings.projects_root_real
        if os.path.islink(root) or not root.is_dir() or root.resolve().parent != base:
            raise ApiError(502, "project_unsafe", "The engine did not create a plain directory.")
        if not (root / "input.json").is_file():
            raise ApiError(502, "engine_unexpected", "The engine did not write input.json.")

    # ------------------------------------------------------------------ discovery

    def discover(self) -> list[dict[str, str]]:
        """Unregistered engine projects directly under the projects root."""
        base = self.settings.projects_root_real
        registered = {p.slug for p in self.list()}
        found = []
        with os.scandir(base) as it:
            for entry in it:
                if entry.name in registered or not commands.SLUG_RE.fullmatch(entry.name):
                    continue
                if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                    continue
                if _is_engine_project(Path(entry.path)):
                    found.append({"slug": entry.name, "location": home_relative(entry.path)})
        return sorted(found, key=lambda d: d["slug"])

    def register(self, slug: str) -> ProjectRow:
        root = self.root_for(slug)
        if os.path.islink(root) or not root.is_dir() or not _is_engine_project(root):
            raise ApiError(404, "not_an_engine_project", "No engine project with this name.")
        meta, _ = read_input(root)
        idea = (meta or {}).get("idea") or slug
        display = idea if len(idea) <= 120 else idea[:117] + "…"
        return self._insert(slug, root, display)


def _is_engine_project(root: Path) -> bool:
    for name in ("input.json", "state.json"):
        p = root / name
        if p.is_symlink() or not p.is_file():
            return False
    return True


def read_input(root: Path) -> tuple[dict[str, Any] | None, str | None]:
    """Engine ``input.json`` (read-only, bounded). Returns ``(data, error)``."""
    p = root / "input.json"
    try:
        st = os.lstat(p)
        if not stat.S_ISREG(st.st_mode):
            return None, "input.json is not a regular file"
        if st.st_size > MAX_INPUT_BYTES:
            return None, "input.json is too large"
        data = json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, "input.json is missing"
    except (UnicodeDecodeError, ValueError):
        return None, "input.json is malformed"
    except OSError as exc:
        return None, f"input.json cannot be read ({exc.strerror})"
    if not isinstance(data, dict):
        return None, "input.json is malformed"
    return data, None
