import json
import os

import pytest

from app.main import create_app
from tests.conftest import PROJECT, Client


def test_create_and_list(client, settings):
    r = client.post("/api/v1/projects", json=PROJECT)
    assert r.status_code == 201, r.text
    assert r.json() == {"id": "hcm-demo", "status": "created", "next_action": "generate_draft"}
    root = settings.projects_root_real / "hcm-demo"
    argv = json.loads((root / "argv.json").read_text())
    assert "--draft-provider=none" in argv
    assert f"--idea={PROJECT['idea']}" in argv

    projects = client.get("/api/v1/projects").json()
    assert len(projects) == 1
    p = projects[0]
    assert p["language"] == "vi" and p["duration_seconds"] == 180
    assert p["idea"] == PROJECT["idea"]
    assert p["status"]["available"] is True
    assert p["status"]["current_stage"]["stage"] == "draft"
    assert p["location"].endswith("/projects/hcm-demo")

    detail = client.get("/api/v1/projects/hcm-demo").json()
    assert detail["guidance"] == PROJECT["guidance"]


def test_duplicate_slug_conflict(client):
    assert client.post("/api/v1/projects", json=PROJECT).status_code == 201
    r = client.post("/api/v1/projects", json=PROJECT)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "project_exists"


def test_existing_directory_is_never_reused(client, settings):
    (settings.projects_root_real / "hcm-demo").mkdir()
    r = client.post("/api/v1/projects", json=PROJECT)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "path_exists"
    assert client.get("/api/v1/projects").json() == []


def test_symlink_slug_rejected(client, settings, tmp_root):
    outside = tmp_root / "outside"
    outside.mkdir()
    os.symlink(outside, settings.projects_root_real / "hcm-demo")
    r = client.post("/api/v1/projects", json=PROJECT)
    assert r.status_code == 409
    assert not (outside / "input.json").exists()


@pytest.mark.parametrize(
    "patch",
    [
        {"slug": "../evil"},
        {"slug": "Evil"},
        {"slug": "-x"},
        {"slug": "a" * 64},
        {"idea": "   "},
        {"idea": "abc"},
        {"language": "fr"},
        {"duration_seconds": 30},
        {"duration_seconds": 4000},
        {"duration_seconds": "180"},
        {"guidance": "x" * 5000},
        {"extra": "field"},
        {"idea": "bad\x00idea here"},
    ],
)
def test_validation(client, patch):
    r = client.post("/api/v1/projects", json={**PROJECT, **patch})
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "validation_error"


def test_engine_failure_registers_nothing(client, fake_cli):
    fake_cli.env["FAKE_MODE"] = "create_fail"
    r = client.post("/api/v1/projects", json=PROJECT)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "engine_invalid_input"
    assert "invalid project input" in r.json()["error"]["message"]
    assert client.get("/api/v1/projects").json() == []


def test_engine_unavailable_returns_503(client, fake_cli, tmp_root):
    fake_cli.cwd = tmp_root / "no-such-engine"
    r = client.post("/api/v1/projects", json=PROJECT)
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "engine_unavailable"
    assert client.get("/api/v1/system/engine").json()["available"] is False


def test_location_preview(client):
    ok = client.get("/api/v1/projects/location-preview", params={"slug": "new-one"}).json()
    assert ok["available"] and ok["location"].endswith("/projects/new-one")
    bad = client.get("/api/v1/projects/location-preview", params={"slug": "../x"}).json()
    assert bad["available"] is False and bad["location"] == ""
    client.post("/api/v1/projects", json=PROJECT)
    taken = client.get("/api/v1/projects/location-preview", params={"slug": "hcm-demo"}).json()
    assert taken["available"] is False


def test_unknown_project_404(client):
    assert client.get("/api/v1/projects/nope").status_code == 404
    assert client.get("/api/v1/projects/..%2Fetc").status_code == 404


def test_persistence_after_restart(settings, fake_cli):
    with Client(create_app(settings, cli=fake_cli)) as c:
        assert c.post("/api/v1/projects", json=PROJECT).status_code == 201
    with Client(create_app(settings, cli=fake_cli)) as c:
        assert [p["id"] for p in c.get("/api/v1/projects").json()] == ["hcm-demo"]


def test_discovery_and_register(client, settings, tmp_root):
    base = settings.projects_root_real
    (base / "old-one").mkdir()
    (base / "old-one" / "input.json").write_text('{"idea": "Old project idea"}')
    (base / "old-one" / "state.json").write_text("{}")
    (base / "not-a-project").mkdir()
    outside = tmp_root / "elsewhere"
    outside.mkdir()
    (outside / "input.json").write_text("{}")
    (outside / "state.json").write_text("{}")
    os.symlink(outside, base / "linked")

    found = client.get("/api/v1/projects/discoverable").json()
    assert [d["slug"] for d in found] == ["old-one"]
    r = client.post("/api/v1/projects/register", json={"slug": "old-one"})
    assert r.status_code == 201 and r.json()["display_name"] == "Old project idea"
    assert client.post("/api/v1/projects/register", json={"slug": "linked"}).status_code == 404
    assert client.get("/api/v1/projects/discoverable").json() == []


def test_status_bad_json_reported(client, fake_cli):
    client.post("/api/v1/projects", json=PROJECT)
    fake_cli.env["FAKE_MODE"] = "bad_json"
    st = client.get("/api/v1/projects/hcm-demo/status").json()
    assert st["available"] is False and st["error_code"] == "engine_bad_json"
    r = client.get("/api/v1/projects/hcm-demo/draft-check")
    assert r.status_code == 502 and r.json()["error"]["code"] == "engine_bad_json"


def test_project_dir_removed_is_reported(client, settings):
    client.post("/api/v1/projects", json=PROJECT)
    import shutil

    shutil.rmtree(settings.projects_root_real / "hcm-demo")
    st = client.get("/api/v1/projects/hcm-demo/status").json()
    assert st["available"] is False
    assert client.get("/api/v1/projects/hcm-demo/draft").status_code == 409
