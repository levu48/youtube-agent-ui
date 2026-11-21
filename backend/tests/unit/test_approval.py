"""G1 approval through ``draft-approve`` (fake engine mirroring the real engine's behaviour).

The UI never writes review.json; it runs the engine and reports the engine's state afterwards.
"""

from __future__ import annotations

import json
import sys

import pytest

from app.engine.runner import EngineCLI
from tests.conftest import PROJECT, Client, wait_for

API = "/api/v1/projects/hcm-demo"
REVIEWER = "Nguyễn Văn A"


def _project(client) -> None:
    assert client.post("/api/v1/projects", json=PROJECT).status_code == 201


def _drafted(client) -> dict:
    _project(client)
    job_id = client.post(f"{API}/draft-jobs", json={"provider": "fixture"}).json()["job_id"]
    wait_for(lambda: client.get(f"/api/v1/jobs/{job_id}").json()["status"] == "succeeded")
    return client.get(f"{API}/draft").json()


def _approve(client, token: str | None, **kw):
    body = {"reviewer": REVIEWER, "confirm": True, "review_token": token, **kw}
    return client.post(f"{API}/draft/approve", json=body)


def _root(settings):
    return settings.projects_root_real / "hcm-demo"


def test_draft_reports_review_token_and_no_approval(client):
    draft = _drafted(client)
    assert len(draft["review_token"]) == 64
    assert draft["approval"] is None
    assert draft["active_job_id"] is None
    assert draft["draft_check"]["approval_status"] == "not_approved"
    # Same files, same token: validating again does not invalidate the reviewer's view.
    assert client.get(f"{API}/draft").json()["review_token"] == draft["review_token"]


def test_approve_runs_engine_with_explicit_reviewer_and_reports_engine_state(client, settings):
    draft = _drafted(client)
    r = _approve(client, draft["review_token"], comment="Đã xem kỹ.\nOK")
    assert r.status_code == 200, r.text
    out = r.json()
    argv = json.loads((_root(settings) / "approve-argv.json").read_text())
    assert argv[0] == "draft-approve"
    assert f"--reviewer={REVIEWER}" in argv and "--comment=Đã xem kỹ.\nOK" in argv
    assert not any(a.startswith("--force") for a in argv)
    assert out["already_approved"] is False
    assert out["approved_version_matches"] is True
    assert out["draft_check"]["approval_status"] == "approved"
    assert out["approval"]["reviewer"] == REVIEWER
    assert out["approval"]["unresolved_blockers"]  # blockers are recorded, not hidden
    assert out["status"]["available"] is True
    # Engine state persists independently of the UI response.
    again = client.get(f"{API}/draft").json()
    assert again["draft_check"]["approval_status"] == "approved"
    assert again["approval"]["reviewer"] == REVIEWER


def test_repeat_approval_reports_already_approved(client):
    draft = _drafted(client)
    assert _approve(client, draft["review_token"]).status_code == 200
    out = _approve(client, draft["review_token"], reviewer="Someone else").json()
    assert out["already_approved"] is True
    assert out["approval"]["reviewer"] == REVIEWER


def test_change_after_validation_is_refused_and_approval_goes_stale(client, settings):
    draft = _drafted(client)
    assert _approve(client, draft["review_token"]).status_code == 200
    # A bound file changes outside the UI (e.g. edited in the CLI or an editor).
    outline = _root(settings) / "outline.json"
    outline.write_text(outline.read_text(encoding="utf-8") + "\n", encoding="utf-8")

    after = client.get(f"{API}/draft").json()
    assert after["draft_check"]["approval_status"] == "stale"
    assert "outline.json" in after["draft_check"]["approval_changed"]
    assert after["approval"]["reviewer"] == REVIEWER  # the old record is still shown, as stale
    assert after["review_token"] != draft["review_token"]

    r = _approve(client, draft["review_token"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "draft_changed"
    assert client.get(f"{API}/draft").json()["draft_check"]["approval_status"] == "stale"

    ok = _approve(client, after["review_token"])
    assert ok.status_code == 200 and ok.json()["draft_check"]["approval_status"] == "approved"


@pytest.mark.parametrize(
    "patch",
    [
        {"reviewer": ""},
        {"reviewer": "   "},
        {"reviewer": "two\nlines"},
        {"reviewer": "x" * 201},
        {"reviewer": "bad\x07bell"},
        {"comment": "x" * 2001},
        {"confirm": False},
        {"review_token": "not-a-token"},
        {"extra": "field"},
    ],
)
def test_invalid_approval_requests_are_rejected(client, settings, patch):
    draft = _drafted(client)
    r = _approve(client, draft["review_token"], **patch)
    assert r.status_code == 422, r.text
    assert not (_root(settings) / "approve-argv.json").exists()  # engine never invoked


def test_missing_confirm_is_rejected(client):
    draft = _drafted(client)
    body = {"reviewer": REVIEWER, "review_token": draft["review_token"]}
    assert client.post(f"{API}/draft/approve", json=body).status_code == 422


def test_csrf_and_origin_are_required(app, client):
    draft = _drafted(client)
    body = {"reviewer": REVIEWER, "confirm": True, "review_token": draft["review_token"]}
    no_csrf = client.post(f"{API}/draft/approve", json=body, headers={"X-CSRF-Token": "nope"})
    assert no_csrf.status_code == 403
    other = Client(app)
    other.headers["Origin"] = "http://evil.example"
    assert other.post(f"{API}/draft/approve", json=body).status_code == 403
    assert client.get(f"{API}/draft").json()["draft_check"]["approval_status"] == "not_approved"


def test_engine_refusal_returns_errors(client, settings):
    _project(client)
    token = client.get(f"{API}/draft").json()["review_token"]
    r = _approve(client, token)
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "approval_refused"
    assert "cannot approve" in err["message"]
    assert err["details"]["errors"] and all(not e.startswith("-") for e in err["details"]["errors"])
    assert not (_root(settings) / "review.json").exists()


def test_refused_while_a_job_is_active(client, fake_cli):
    draft = _drafted(client)
    fake_cli.env["FAKE_MODE"] = "slow"
    job_id = client.post(f"{API}/draft-jobs", json={"provider": "fixture"}).json()["job_id"]
    wait_for(lambda: client.get(f"/api/v1/jobs/{job_id}").json()["status"] == "running")
    assert client.get(f"{API}/draft").json()["active_job_id"] == job_id
    r = _approve(client, draft["review_token"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "job_conflict"
    client.post(f"/api/v1/jobs/{job_id}/cancel")
    wait_for(lambda: client.get(f"/api/v1/jobs/{job_id}").json()["status"] == "cancelled")


def test_no_job_can_start_while_approval_holds_the_project(client):
    _drafted(client)
    jobs = client.app.state.ctx.jobs
    with jobs.exclusive("hcm-demo"):
        r = client.post(f"{API}/draft-jobs", json={"provider": "fixture"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "project_busy"
    r = client.post(f"{API}/draft-jobs", json={"provider": "fixture"})
    assert r.status_code == 202


def test_engine_lock_conflict_is_409(client, fake_cli):
    draft = _drafted(client)
    fake_cli.env["FAKE_MODE"] = "approve_conflict"
    r = _approve(client, draft["review_token"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "engine_conflict"


def test_change_racing_into_engine_snapshot_is_reported(client, fake_cli):
    draft = _drafted(client)
    fake_cli.env["FAKE_MODE"] = "approve_race"
    out = _approve(client, draft["review_token"]).json()
    # The engine approved what it saw; the UI says plainly that it differs from what was checked.
    assert out["approved_version_matches"] is False
    assert out["draft_check"]["approval_status"] == "approved"


def test_engine_unavailable_is_503(client, fake_cli, tmp_root):
    draft = _drafted(client)
    fake_cli.cwd = tmp_root / "no-such-engine"
    r = _approve(client, draft["review_token"])
    assert r.status_code == 503 and r.json()["error"]["code"] == "engine_unavailable"
    assert str(tmp_root) not in r.text


def test_timeout_is_504_and_process_is_stopped(client, tmp_root):
    draft = _drafted(client)
    engine = client.app.state.ctx.engine
    engine.cli = EngineCLI([sys.executable, "-c", "import time; time.sleep(10)"], tmp_root, {})
    engine.read_timeout = 0.3
    r = _approve(client, draft["review_token"])
    assert r.status_code == 504 and r.json()["error"]["code"] == "engine_timeout"
    # The project is released afterwards.
    assert client.app.state.ctx.jobs._reserved == set()


def test_unknown_project_is_404(client):
    body = {"reviewer": REVIEWER, "confirm": True, "review_token": "0" * 64}
    assert client.post("/api/v1/projects/nope/draft/approve", json=body).status_code == 404
