"""Regression tests (review P2): draft endpoints report engine failures consistently,
with stable codes and sanitized messages; raw exception text never reaches the client."""

from __future__ import annotations

import json
import sys

import pytest

from app.engine.runner import EngineCLI, EngineUnavailable
from app.engine.service import EngineReadError
from tests.conftest import PROJECT

SECRET = "/Users/someone/private/path token=hunter2 Traceback"


def _project(client):
    assert client.post("/api/v1/projects", json=PROJECT).status_code == 201


def _both(client):
    check = client.get("/api/v1/projects/hcm-demo/draft-check")
    draft = client.get("/api/v1/projects/hcm-demo/draft")
    assert draft.status_code == 200
    return check, draft.json()


def _assert_consistent(check, draft, status, code):
    assert check.status_code == status
    err = check.json()["error"]
    assert err["code"] == code
    assert err["details"] == {}  # no diagnostics in the public response
    assert draft["draft_check"] is None
    assert draft["draft_check_error"] == {"code": code, "message": err["message"]}
    blob = json.dumps(check.json()) + json.dumps(draft)
    for leak in ("hunter2", "/Users/someone", "Traceback", "RuntimeError"):
        assert leak not in blob


def _raise(exc):
    async def f(*_a, **_k):
        raise exc

    return f


@pytest.mark.parametrize(
    ("exc", "status", "code"),
    [
        (EngineUnavailable(f"cannot start engine: {SECRET}"), 503, "engine_unavailable"),
        (EngineReadError("engine_timeout", "timeout", SECRET), 504, "engine_timeout"),
        (EngineReadError("engine_bad_json", "bad", SECRET), 502, "engine_bad_json"),
        (RuntimeError(SECRET), 500, "internal_error"),
    ],
)
def test_draft_and_draft_check_report_same_sanitized_error(client, monkeypatch, exc, status, code):
    _project(client)
    monkeypatch.setattr(client.app.state.ctx.engine, "draft_check", _raise(exc))
    check, draft = _both(client)
    _assert_consistent(check, draft, status, code)


def test_engine_reported_error_keeps_redacted_engine_message(client, monkeypatch):
    _project(client)
    exc = EngineReadError("engine_invalid_input", "protected edits in /Users/someone/x", SECRET)
    monkeypatch.setattr(client.app.state.ctx.engine, "draft_check", _raise(exc))
    check, draft = _both(client)
    assert check.status_code == 502
    msg = check.json()["error"]["message"]
    assert msg.startswith("The engine reported an error: protected edits")
    assert draft["draft_check_error"] == {"code": "engine_invalid_input", "message": msg}


def test_real_subprocess_failures_are_normalized(client, fake_cli, tmp_root):
    """End to end through the runner: missing engine, malformed output, timeout."""
    _project(client)
    fake_cli.cwd = tmp_root / "missing-engine"
    check, draft = _both(client)
    _assert_consistent(check, draft, 503, "engine_unavailable")
    status = client.get("/api/v1/projects/hcm-demo/status").json()
    assert status["error_code"] == "engine_unavailable" and "missing-engine" not in status["error"]

    fake_cli.cwd = tmp_root
    fake_cli.env["FAKE_MODE"] = "bad_json"
    check, draft = _both(client)
    _assert_consistent(check, draft, 502, "engine_bad_json")


def test_timeout_is_normalized(client, tmp_root):
    _project(client)
    engine = client.app.state.ctx.engine
    engine.cli = EngineCLI([sys.executable, "-c", "import time; time.sleep(10)"], tmp_root, {})
    engine.read_timeout = 0.3
    check, draft = _both(client)
    _assert_consistent(check, draft, 504, "engine_timeout")
