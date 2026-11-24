"""Application container wiring services together (one per process)."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request

from app.approvals import ApprovalChecks
from app.config import Settings
from app.db import Database
from app.engine.runner import EngineCLI
from app.engine.service import EngineService
from app.jobs import JobManager
from app.projects import ProjectService
from app.visuals import Snapshots


@dataclass
class AppState:
    settings: Settings
    db: Database
    cli: EngineCLI
    engine: EngineService
    projects: ProjectService
    jobs: JobManager
    csrf_token: str
    approvals: ApprovalChecks
    visuals: Snapshots


def build_state(settings: Settings, csrf_token: str, cli: EngineCLI | None = None) -> AppState:
    settings.prepare_dirs()
    db = Database(settings.db_path)
    cli = cli or EngineCLI.from_settings(settings)
    engine = EngineService(cli, read_timeout=settings.read_timeout_seconds)
    projects = ProjectService(settings, db, engine)
    visuals = Snapshots(engine)
    jobs = JobManager(
        db,
        cli,
        logs_dir=settings.logs_dir,
        cancel_grace=settings.cancel_grace_seconds,
        on_finished=lambda pid: (
            engine.invalidate(pid),
            visuals.invalidate(pid),
            projects.touch(pid),
        ),
    )
    return AppState(
        settings, db, cli, engine, projects, jobs, csrf_token, ApprovalChecks(db), visuals
    )


def get_state(request: Request) -> AppState:
    return request.app.state.ctx
