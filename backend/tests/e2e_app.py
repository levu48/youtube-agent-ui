"""Backend app wired to the fake engine, for Playwright E2E without the engine checkout.

Run: ``uv run uvicorn --factory tests.e2e_app:factory``. Settings come from YTA_* env vars;
the fake engine (tests/fake_engine.py) replays output captured from the real youtube-agent
fixture provider. Test use only, never used by scripts/dev.sh.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from app.config import Settings
from app.engine.runner import EngineCLI
from app.main import create_app

FAKE_ENGINE = Path(__file__).resolve().parent / "fake_engine.py"


def factory():
    logging.basicConfig(level=logging.INFO)
    settings = Settings()
    env = {
        "PATH": "/usr/bin:/bin",
        "PYTHONUNBUFFERED": "1",
        "FAKE_MODE": os.environ.get("FAKE_MODE", "ok"),
    }
    settings.prepare_dirs()
    cli = EngineCLI([sys.executable, str(FAKE_ENGINE)], settings.projects_root_real, env)
    return create_app(settings, cli=cli)
