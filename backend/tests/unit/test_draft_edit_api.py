"""Draft editing through ``draft-edit`` (fake engine mirroring engine D-117 @ 573ebdd).

The UI never writes a draft file: it sends a patch on the engine's stdin with the revision the
editor loaded, and reports the engine's result."""

from __future__ import annotations

import json
import sys

import pytest

from app.engine.runner import EngineCLI
from tests.conftest import PROJECT, Client, wait_for

API = "/api/v1/projects/hcm-demo"
TITLE = "Hành trình tìm đường cứu nước (bản sửa)"
NARRATION = "Năm 1911, người thanh niên rời bến Nhà Rồng.\n\nÔng đi qua nhiều nước."


@pytest.fixture(autouse=True)
def revision_engine(fake_cli):
    fake_cli.env["FAKE_REVISION"] = "1"
    return fake_cli


def _root(settings):
    return settings.projects_root_real / "hcm-demo"


def _drafted(client) -> dict:
    assert client.post("/api/v1/projects", json=PROJECT).status_code == 201
    job_id = client.post(f"{API}/draft-jobs", json={"provider": "fixture"}).json()["job_id"]
    wait_for(lambda: client.get(f"/api/v1/jobs/{job_id}").json()["status"] == "succeeded")
    return client.get(f"{API}/draft/editable").json()


def _edit(client, revision, **body):
    return client.post(f"{API}/draft/edit", json={"expected_revision": revision, **body})


def _calls(settings) -> list[dict]:
    log = _root(settings) / "edit-calls.jsonl"
    if not log.exists():
        return []
    return [json.loads(ln) for ln in log.read_text(encoding="utf-8").splitlines()]


def _saves(settings) -> list[dict]:
    """Engine edit calls other than the editability probe (a dry run)."""
    return [c for c in _calls(settings) if "--dry-run" not in c["argv"]]


def _files(settings) -> dict[str, bytes]:
    root = _root(settings)
    names = ("outline.json", "outline.md", "script.json", "script.md", "storyboard.draft.json")
    return {n: (root / n).read_bytes() for n in names}


def test_editable_reports_engine_revision_and_permission(client):
    d = _drafted(client)
    ed = d["editing"]
    assert ed["supported"] is True and ed["can_edit"] is True and ed["reason"] is None
    assert ed["revision"] == d["draft_check"]["revision"] == d["review_token"]
    assert ed["limits"]["narration"] == 50_000
    assert d["outline"]["data"]["sections"] and d["script"]["data"]["sections"]


def test_editable_before_drafting_says_why(client):
    assert client.post("/api/v1/projects", json=PROJECT).status_code == 201
    ed = client.get(f"{API}/draft/editable").json()["editing"]
    assert ed["can_edit"] is False and ed["reason_code"] == "no_draft"


def test_engine_without_revision_cannot_edit(client, revision_engine):
    revision_engine.env["FAKE_REVISION"] = "0"
    ed = _drafted(client)["editing"]
    assert ed["supported"] is False and ed["can_edit"] is False
    assert ed["reason_code"] == "engine_unsupported"


def test_save_outline_and_script_in_one_engine_edit(client, settings):
    d = _drafted(client)
    rev = d["editing"]["revision"]
    sec = d["outline"]["data"]["sections"][1]["id"]
    r = _edit(
        client,
        rev,
        outline={"title": TITLE, "sections": [{"id": sec, "key_points": ["Điểm một", "Điểm hai"]}]},
        script={"sections": [{"outline_section_id": sec, "narration": NARRATION}]},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    [call] = _saves(settings)
    argv = call["argv"]
    assert argv[0] == "draft-edit" and f"--expect-revision={rev}" in argv and "--json" in argv
    assert "--dry-run" not in argv and not any(a.startswith("--force") for a in argv)
    # The patch travels on stdin, never on the command line, with exactly the client's fields.
    sent = json.loads(call["stdin"])
    assert sent == {
        "outline": {
            "title": TITLE,
            "sections": [{"id": sec, "key_points": ["Điểm một", "Điểm hai"]}],
        },
        "script": {"sections": [{"outline_section_id": sec, "narration": NARRATION}]},
    }
    assert not any(TITLE in a for a in argv)
    res = out["result"]
    assert res["status"] == "published" and res["previous_revision"] == rev
    assert res["revision"] != rev and "outline.json" in res["changed_files"]
    assert "project_root" not in res  # no absolute paths in responses
    draft = out["draft"]
    assert draft["editing"]["revision"] == res["revision"]
    assert draft["outline"]["data"]["title"] == TITLE
    s = next(x for x in draft["script"]["data"]["sections"] if x["outline_section_id"] == sec)
    assert s["narration"] == NARRATION
    assert TITLE in draft["outline"]["markdown"]


def test_edit_makes_an_approval_stale(client, settings):
    d = _drafted(client)
    ok = client.post(
        f"{API}/draft/approve",
        json={"reviewer": "Nguyễn Văn A", "confirm": True, "review_token": d["review_token"]},
    )
    assert ok.status_code == 200, ok.text
    approved = client.get(f"{API}/draft/editable").json()
    assert approved["draft_check"]["approval_status"] == "approved"
    r = _edit(client, approved["editing"]["revision"], outline={"title": TITLE})
    after = r.json()["draft"]
    assert after["draft_check"]["approval_status"] == "stale"
    assert "outline.json" in after["draft_check"]["approval_changed"]
    assert r.json()["result"]["approval_status"] == "stale"
    old = client.post(
        f"{API}/draft/approve",
        json={"reviewer": "Nguyễn Văn A", "confirm": True, "review_token": d["review_token"]},
    )
    assert old.status_code == 409 and old.json()["error"]["code"] == "draft_changed"


def test_stale_revision_is_a_conflict_and_nothing_is_written(client, settings):
    d = _drafted(client)
    rev = d["editing"]["revision"]
    assert _edit(client, rev, outline={"title": TITLE}).status_code == 200
    before = _files(settings)
    r = _edit(client, rev, outline={"title": "Một tiêu đề khác"})
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "revision_conflict"
    assert (
        err["details"]["current_revision"]
        == client.get(f"{API}/draft/editable").json()["editing"]["revision"]
    )
    assert _files(settings) == before


def test_change_racing_into_the_engine_is_refused(client, settings, revision_engine):
    d = _drafted(client)
    revision_engine.env["FAKE_MODE"] = "edit_race"
    r = _edit(client, d["editing"]["revision"], outline={"title": TITLE})
    assert r.status_code == 409 and r.json()["error"]["code"] == "revision_conflict"
    assert json.loads((_root(settings) / "outline.json").read_text())["title"] != TITLE


def test_dry_run_validates_without_writing(client, settings):
    d = _drafted(client)
    before = _files(settings)
    r = _edit(client, d["editing"]["revision"], dry_run=True, outline={"title": TITLE})
    assert r.status_code == 200, r.text
    assert r.json()["result"]["status"] == "would_publish" and "draft" not in r.json()
    assert _saves(settings) == [] and "--dry-run" in _calls(settings)[-1]["argv"]
    assert _files(settings) == before


def test_unknown_section_id_is_rejected_by_the_engine(client, settings):
    d = _drafted(client)
    before = _files(settings)
    r = _edit(
        client, d["editing"]["revision"], outline={"sections": [{"id": "sec-99", "heading": "X"}]}
    )
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "invalid_edit"
    assert err["details"]["errors"][0]["loc"] == "outline.sections.0.id"
    assert _files(settings) == before


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"outline": None},
        {"outline": {"title": None}},
        {"outline": {"title": ""}},
        {"outline": {"title": "x" * 301}},
        {"outline": {"bogus": 1}},
        {"outline": {"sections": [{"id": "../etc", "heading": "x"}]}},
        {"outline": {"sections": [{"id": "sec-01", "key_points": []}]}},
        {"outline": {"sections": [{"id": "sec-01", "key_points": ["x"] * 51}]}},
        {"script": {"sections": []}},
        {"script": {"sections": [{"outline_section_id": "sec-01", "narration": "a\x00b"}]}},
        {"script": {"sections": [{"outline_section_id": "sec-01", "narration": "x" * 50_001}]}},
        {"script": {"sections": [{"outline_section_id": "sec-01", "summary": 5}]}},
        {"dry_run": "yes", "outline": {"title": "x"}},
        {"expected_revision": "nope", "outline": {"title": "x"}},
        {"project_root": "/etc", "outline": {"title": "x"}},
    ],
)
def test_malformed_edits_never_reach_the_engine(client, settings, body):
    d = _drafted(client)
    calls = len(_calls(settings))
    before = _files(settings)
    payload = {"expected_revision": d["editing"]["revision"], **body}
    r = client.post(f"{API}/draft/edit", json=payload)
    assert r.status_code == 422, r.text
    assert len(_calls(settings)) == calls  # the engine was never run
    assert _files(settings) == before


def test_oversized_edit_is_rejected_before_the_engine(client, settings):
    d = _drafted(client)
    calls = len(_calls(settings))
    sections = [
        {"outline_section_id": x["outline_section_id"], "narration": "Lời bình. " * 4000}
        for x in d["script"]["data"]["sections"]
    ] * 1
    big = [dict(x, outline_section_id=f"sec-{n:02d}") for n, x in enumerate(sections * 10)]
    r = _edit(client, d["editing"]["revision"], script={"sections": big})
    assert r.status_code == 422 and "larger than" in r.json()["error"]["message"]
    assert len(_calls(settings)) == calls


def test_downstream_work_blocks_editing(client, settings):
    d = _drafted(client)
    (_root(settings) / "research-plan.json").write_text("{}", encoding="utf-8")
    ed = client.get(f"{API}/draft/editable").json()["editing"]
    assert ed["can_edit"] is False and ed["reason_code"] == "downstream_artifacts"
    assert ed["paths"] == ["research-plan.json"]
    r = _edit(client, d["editing"]["revision"], outline={"title": TITLE})
    assert r.status_code == 409 and r.json()["error"]["code"] == "downstream_artifacts"
    assert r.json()["error"]["details"]["paths"] == ["research-plan.json"]


def test_no_edit_while_a_job_is_active(client, revision_engine):
    d = _drafted(client)
    revision_engine.env["FAKE_MODE"] = "slow"
    job_id = client.post(f"{API}/draft-jobs", json={"provider": "fixture"}).json()["job_id"]
    wait_for(lambda: client.get(f"/api/v1/jobs/{job_id}").json()["status"] == "running")
    ed = client.get(f"{API}/draft/editable").json()["editing"]
    assert ed["can_edit"] is False and ed["reason_code"] == "job_conflict"
    r = _edit(client, d["editing"]["revision"], outline={"title": TITLE})
    assert r.status_code == 409 and r.json()["error"]["code"] == "job_conflict"
    client.post(f"/api/v1/jobs/{job_id}/cancel")
    wait_for(lambda: client.get(f"/api/v1/jobs/{job_id}").json()["status"] == "cancelled")


def test_no_job_can_start_during_an_edit(client):
    _drafted(client)
    with client.app.state.ctx.jobs.exclusive("hcm-demo"):
        r = client.post(f"{API}/draft-jobs", json={"provider": "fixture"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "project_busy"


def test_engine_lock_conflict_is_409(client, revision_engine):
    d = _drafted(client)
    revision_engine.env["FAKE_MODE"] = "edit_conflict"
    r = _edit(client, d["editing"]["revision"], outline={"title": TITLE})
    assert r.status_code == 409 and r.json()["error"]["code"] == "engine_conflict"


def test_csrf_and_origin_are_required(app, client, settings):
    d = _drafted(client)
    body = {"expected_revision": d["editing"]["revision"], "outline": {"title": TITLE}}
    bad = client.post(f"{API}/draft/edit", json=body, headers={"X-CSRF-Token": "nope"})
    assert bad.status_code == 403
    other = Client(app)
    other.headers["Origin"] = "http://evil.example"
    assert other.post(f"{API}/draft/edit", json=body).status_code == 403
    assert json.loads((_root(settings) / "outline.json").read_text())["title"] != TITLE


def test_engine_unavailable_is_503(client, fake_cli, tmp_root):
    d = _drafted(client)
    fake_cli.cwd = tmp_root / "no-such-engine"
    r = _edit(client, d["editing"]["revision"], outline={"title": TITLE})
    assert r.status_code == 503 and str(tmp_root) not in r.text


def test_timeout_is_504_and_the_project_is_released(client, tmp_root):
    d = _drafted(client)
    engine = client.app.state.ctx.engine
    engine.cli = EngineCLI([sys.executable, "-c", "import time; time.sleep(10)"], tmp_root, {})
    engine.read_timeout = 0.3
    r = _edit(client, d["editing"]["revision"], outline={"title": TITLE})
    assert r.status_code == 504 and r.json()["error"]["code"] == "engine_timeout"
    assert client.app.state.ctx.jobs._reserved == set()


def test_unknown_project_is_404(client):
    body = {"expected_revision": "0" * 64, "outline": {"title": TITLE}}
    assert client.post("/api/v1/projects/nope/draft/edit", json=body).status_code == 404
    assert client.get("/api/v1/projects/nope/draft/editable").status_code == 404
