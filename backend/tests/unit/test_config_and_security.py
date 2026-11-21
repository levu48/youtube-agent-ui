from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings
from tests.conftest import ORIGIN, Client


def test_health(client):
    body = client.get("/api/v1/health").json()
    assert body["status"] == "ok" and body["schema_version"] == 1


def test_config_requires_absolute_paths(tmp_root):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, engine_repo=Path("relative"), data_dir=tmp_root)


def test_projects_root_outside_engine_repo(tmp_root):
    with pytest.raises(ValidationError, match="outside source repositories"):
        Settings(_env_file=None, engine_repo=tmp_root, projects_root=tmp_root / "projects")


@pytest.mark.parametrize(
    "url", ["http://example.com:11434", "ftp://127.0.0.1", "http://u:p@127.0.0.1"]
)
def test_ollama_must_be_loopback(url, tmp_root):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, ollama_base_url=url)


def test_ui_origins_must_be_loopback():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, ui_origins=["http://evil.example:3000"])


def test_bad_host_rejected(client):
    r = client.get("/api/v1/health", headers={"Host": "evil.example"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "bad_host"


def test_foreign_origin_rejected(client):
    r = client.get("/api/v1/health", headers={"Origin": "http://evil.example"})
    assert r.status_code == 403


def test_mutation_requires_csrf(app):
    with Client(app) as c:
        del c.headers["X-CSRF-Token"]
        r = c.post("/api/v1/projects", json={})
        assert r.status_code == 403
        assert r.json()["error"]["code"] == "csrf_failed"
        r = c.post("/api/v1/projects", json={}, headers={"X-CSRF-Token": "wrong"})
        assert r.status_code == 403


def test_cors_preflight_only_for_ui_origin(client):
    ok = client.options(
        "/api/v1/projects",
        headers={"Origin": ORIGIN, "Access-Control-Request-Method": "POST"},
    )
    assert ok.headers.get("access-control-allow-origin") == ORIGIN
    bad = client.options(
        "/api/v1/projects",
        headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "POST"},
    )
    assert bad.headers.get("access-control-allow-origin") is None


def test_error_envelope_for_unknown_route(client):
    r = client.get("/api/v1/nope")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


def test_engine_info_and_config(client):
    assert client.get("/api/v1/system/engine").json()["version"] == "0.1.0+fake"
    cfg = client.get("/api/v1/system/config").json()
    assert cfg["providers"] == ["ollama", "fixture"]
    ollama = client.get("/api/v1/system/ollama").json()
    assert ollama["available"] is False and "not reachable" in ollama["reason"]
