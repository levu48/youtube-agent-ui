"""FastAPI application factory (run via scripts/dev.sh)."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.routes import router
from app.config import Settings
from app.engine.runner import EngineCLI
from app.errors import install_handlers
from app.security import LocalGuardMiddleware, new_token
from app.state import build_state


def create_app(settings: Settings | None = None, *, cli: EngineCLI | None = None) -> FastAPI:
    settings = settings or Settings()
    token = new_token()
    ctx = build_state(settings, token, cli)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await ctx.jobs.start()
        try:
            yield
        finally:
            await ctx.jobs.stop()
            ctx.db.close()

    app = FastAPI(
        title="youtube-agent-ui",
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    app.state.ctx = ctx
    install_handlers(app)
    app.add_middleware(
        LocalGuardMiddleware,
        allowed_hosts=settings.allowed_hosts,
        origins=settings.ui_origins,
        token=token,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.ui_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-CSRF-Token", "Last-Event-ID"],
        allow_credentials=False,
    )
    app.include_router(router)
    return app


def factory() -> FastAPI:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    return create_app()
