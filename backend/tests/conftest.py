from __future__ import annotations

import os
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.engine.runner import EngineCLI
from app.main import create_app

FAKE_ENGINE = Path(__file__).parent / "fake_engine.py"
ORIGIN = "http://127.0.0.1:3000"


def engine_repo() -> Path:
    env = os.environ.get("YTA_TEST_ENGINE_REPO")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[3] / "youtube-agent"


@pytest.fixture
def tmp_root(tmp_path_factory) -> Path:
    # Short path outside any repository (macOS tmp dirs are long but fine).
    return tmp_path_factory.mktemp("yta")


@pytest.fixture
def settings(tmp_root: Path) -> Settings:
    return Settings(
        _env_file=None,
        engine_repo=engine_repo(),
        projects_root=tmp_root / "projects",
        data_dir=tmp_root / "data",
        allow_fixture_provider=True,
        cancel_grace_seconds=1.0,
        ollama_base_url="http://127.0.0.1:9",  # nothing listens: Ollama "unavailable"
    )


@pytest.fixture
def fake_cli(tmp_root: Path) -> EngineCLI:
    env = {"PATH": "/usr/bin:/bin", "PYTHONUNBUFFERED": "1", "FAKE_MODE": "ok"}
    return EngineCLI([sys.executable, str(FAKE_ENGINE)], tmp_root, env)


class Client(TestClient):
    """TestClient that behaves like the same-origin UI (Origin + CSRF token)."""

    def __init__(self, app):
        super().__init__(app, base_url="http://127.0.0.1:8000", headers={"Origin": ORIGIN})
        self.token: str | None = None

    def __enter__(self):
        super().__enter__()
        self.token = self.get("/api/v1/session").json()["csrf_token"]
        self.headers["X-CSRF-Token"] = self.token
        return self


@pytest.fixture
def app(settings, fake_cli):
    return create_app(settings, cli=fake_cli)


@pytest.fixture
def client(app) -> Iterator[Client]:
    with Client(app) as c:
        yield c


def wait_for(fn, timeout: float = 10.0, interval: float = 0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(interval)
    raise AssertionError("condition not met in time")


PROJECT = {
    "slug": "hcm-demo",
    "idea": "Hồ Chí Minh: Nationalist or Communist?",
    "language": "vi",
    "duration_seconds": 180,
    "audience": "General Vietnamese audience",
    "tone": "Balanced documentary",
    "guidance": "Distinguish evidence from interpretation",
}
