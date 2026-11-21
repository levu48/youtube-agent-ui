"""Application container wiring services together (one per process)."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request

from app.config import Settings
from app.db import Database
from app.engine.runner import EngineCLI
from app.engine.service import EngineService
from app.jobs import JobManager
from app.projects import ProjectService


@dataclass
class AppState:
    settings: Settings
    db: Database
    cli: EngineCLI
    engine: EngineService
    projects: ProjectService
    jobs: JobManager
    csrf_token: str


def build_state(settings: Settings, csrf_token: str, cli: EngineCLI | None = None) -> AppState:
    settings.prepare_dirs()
    db = Database(settings.db_path)
    cli = cli or EngineCLI.from_settings(settings)
    engine = EngineService(cli, read_timeout=settings.read_timeout_seconds)
    projects = ProjectService(settings, db, engine)
    jobs = JobManager(
        db,
        cli,
        logs_dir=settings.logs_dir,
        cancel_grace=settings.cancel_grace_seconds,
        on_finished=lambda pid: (engine.invalidate(pid), projects.touch(pid)),
    )
    return AppState(settings, db, cli, engine, projects, jobs, csrf_token)


def get_state(request: Request) -> AppState:
    return request.app.state.ctx
