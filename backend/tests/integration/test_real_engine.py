"""Integration tests against the real youtube-agent CLI using the offline fixture provider.

No Ollama, network or paid services. Skipped (with a reason) if the engine checkout or its
virtualenv is not available. Set YTA_TEST_ENGINE_REPO to point elsewhere.
"""

from __future__ import annotations

import json
import os
import subprocess

import pytest

from app.main import create_app
from tests.conftest import PROJECT, Client, engine_repo, wait_for

REPO = engine_repo()
# In CI the engine is checked out on purpose: YTA_REQUIRE_ENGINE=1 turns a skip into a failure.
REQUIRED = os.environ.get("YTA_REQUIRE_ENGINE") == "1"
pytestmark = [
    pytest.mark.engine,
    pytest.mark.skipif(
        not REQUIRED and (not (REPO / "pyproject.toml").is_file() or not (REPO / ".venv").is_dir()),
        reason=f"engine checkout with .venv not found at {REPO}",
    ),
]


@pytest.fixture
def real_client(settings):
    app = create_app(settings)  # real EngineCLI: uv run --no-sync ytagent
    with Client(app) as c:
        yield c


def test_engine_version(real_client):
    info = real_client.get("/api/v1/system/engine").json()
    assert info["available"], info
    assert info["version"]


def test_create_draft_view_and_cli_interop(real_client, settings):
    r = real_client.post("/api/v1/projects", json=PROJECT)
    assert r.status_code == 201, r.text

    status = real_client.get("/api/v1/projects/hcm-demo/status").json()
    assert status["available"]
    assert [s["stage"] for s in status["stages"]][:2] == ["intake", "draft"]
    assert status["current_stage"]["stage"] == "draft"

    job_id = real_client.post(
        "/api/v1/projects/hcm-demo/draft-jobs", json={"provider": "fixture"}
    ).json()["job_id"]
    job = wait_for(
        lambda: (
            (j := real_client.get(f"/api/v1/jobs/{job_id}").json())["status"]
            in ("succeeded", "failed")
            and j
        ),
        timeout=60,
    )
    assert job["status"] == "succeeded", job
    logs = " ".join(e["data"]["message"] for e in job["events"] if e["type"] == "log")
    assert "draft published" in logs

    draft = real_client.get("/api/v1/projects/hcm-demo/draft").json()
    assert draft["available"]
    assert draft["outline"]["data"]["sections"]
    assert draft["script"]["data"]["sections"][0]["narration"]
    assert draft["draft_check"]["ok"] is True
    assert draft["draft_check"]["approval_status"] == "not_approved"

    status = real_client.get("/api/v1/projects/hcm-demo/status").json()
    assert status["current_stage"]["status"] == "needs_review"

    # The same project works from the original CLI, independently of the UI.
    root = settings.projects_root_real / "hcm-demo"
    out = subprocess.run(
        [
            "uv",
            "run",
            "--no-sync",
            "ytagent",
            "production-status",
            f"--project-root={root}",
            "--json",
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    )
    assert json.loads(out.stdout)["stages"][1]["status"] == "needs_review"


def test_engine_rejects_existing_project_dir_via_ui(real_client):
    assert real_client.post("/api/v1/projects", json=PROJECT).status_code == 201
    assert real_client.post("/api/v1/projects", json=PROJECT).status_code == 409
