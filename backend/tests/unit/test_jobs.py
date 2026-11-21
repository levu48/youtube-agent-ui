import json
import time

from app.db import Database, utcnow
from app.main import create_app
from tests.conftest import PROJECT, Client, wait_for

FIXTURE_JOB = {"provider": "fixture", "from_stage": "outline"}


def _project(client):
    assert client.post("/api/v1/projects", json=PROJECT).status_code == 201


def _start(client, body=FIXTURE_JOB):
    r = client.post("/api/v1/projects/hcm-demo/draft-jobs", json=body)
    assert r.status_code == 202, r.text
    return r.json()["job_id"]


def _job(client, job_id):
    return client.get(f"/api/v1/jobs/{job_id}").json()


def _terminal(client, job_id):
    j = _job(client, job_id)
    return j if j["status"] in ("succeeded", "failed", "cancelled", "interrupted") else None


def test_fixture_draft_job_succeeds(client, settings):
    _project(client)
    job_id = _start(client)
    job = wait_for(lambda: _terminal(client, job_id))
    assert job["status"] == "succeeded" and job["exit_code"] == 0
    assert job["provider"] == "fixture"
    types = [e["type"] for e in job["events"]]
    assert types[0] == "status" and types[-1] == "completed"
    logs = [e["data"]["message"] for e in job["events"] if e["type"] == "log"]
    assert logs == ["starting draft", "draft published"]
    ids = [e["id"] for e in job["events"]]
    assert ids == sorted(ids)
    argv = json.loads((settings.projects_root_real / "hcm-demo" / "draft-argv.json").read_text())
    assert "--provider=fixture" in argv and "--force" not in argv
    log_file = settings.logs_dir / f"{job_id}.log"
    assert "draft published" in log_file.read_text()
    assert client.get("/api/v1/projects/hcm-demo/draft-available").json()["available"]


def test_requests_not_blocked_while_job_runs(client, fake_cli):
    _project(client)
    fake_cli.env["FAKE_MODE"] = "slow"
    job_id = _start(client)
    wait_for(lambda: _job(client, job_id)["status"] == "running")
    t0 = time.monotonic()
    assert client.get("/api/v1/health").status_code == 200
    assert time.monotonic() - t0 < 1.0
    client.post(f"/api/v1/jobs/{job_id}/cancel")
    wait_for(lambda: _terminal(client, job_id))


def test_duplicate_start_conflicts(client, fake_cli):
    _project(client)
    fake_cli.env["FAKE_MODE"] = "slow"
    job_id = _start(client)
    r = client.post("/api/v1/projects/hcm-demo/draft-jobs", json=FIXTURE_JOB)
    assert r.status_code == 409
    assert r.json()["error"]["details"]["job_id"] == job_id
    client.post(f"/api/v1/jobs/{job_id}/cancel")
    wait_for(lambda: _terminal(client, job_id))


def test_global_limit_queues_second_project(client, fake_cli):
    _project(client)
    assert client.post("/api/v1/projects", json={**PROJECT, "slug": "second"}).status_code == 201
    fake_cli.env["FAKE_MODE"] = "slow"
    first = _start(client)
    wait_for(lambda: _job(client, first)["status"] == "running")
    r = client.post("/api/v1/projects/second/draft-jobs", json=FIXTURE_JOB)
    second = r.json()["job_id"]
    time.sleep(0.3)
    assert _job(client, second)["status"] == "queued"
    # Cancel a queued job: immediate, never started.
    assert client.post(f"/api/v1/jobs/{second}/cancel").json()["status"] == "cancelled"
    client.post(f"/api/v1/jobs/{first}/cancel")
    assert wait_for(lambda: _terminal(client, first))["status"] == "cancelled"


def test_cancel_running_job(client, fake_cli):
    _project(client)
    fake_cli.env["FAKE_MODE"] = "slow"
    job_id = _start(client)
    wait_for(lambda: any(e["type"] == "log" for e in _job(client, job_id)["events"]))
    r = client.post(f"/api/v1/jobs/{job_id}/cancel")
    assert r.status_code == 202 and r.json()["cancel_requested"]
    job = wait_for(lambda: _terminal(client, job_id))
    assert job["status"] == "cancelled" and job["exit_code"] == 130
    assert any(e["type"] == "cancel_requested" for e in job["events"])
    assert client.post(f"/api/v1/jobs/{job_id}/cancel").status_code == 409
    # A new job may be started after the cancelled one (safe retry).
    fake_cli.env["FAKE_MODE"] = "ok"
    retry = _start(client)
    assert wait_for(lambda: _terminal(client, retry))["status"] == "succeeded"


def test_cancel_escalates_for_stubborn_process(client, fake_cli):
    _project(client)
    fake_cli.env["FAKE_MODE"] = "stubborn"
    job_id = _start(client)
    wait_for(lambda: any(e["type"] == "log" for e in _job(client, job_id)["events"]))
    client.post(f"/api/v1/jobs/{job_id}/cancel")
    job = wait_for(lambda: _terminal(client, job_id), timeout=15)
    assert job["status"] == "cancelled" and job["exit_code"] < 0


def test_failure_and_gate_classification(client, fake_cli):
    _project(client)
    fake_cli.env["FAKE_MODE"] = "fail"
    j1 = _start(client)
    job = wait_for(lambda: _terminal(client, j1))
    assert job["status"] == "failed" and job["exit_code"] == 10
    assert job["error_code"] == "llm_failure"
    assert job["error_message"] == "LLM request failed: model crashed"
    fake_cli.env["FAKE_MODE"] = "gate"
    j2 = _start(client)
    job = wait_for(lambda: _terminal(client, j2))
    assert job["status"] == "succeeded" and job["error_code"] == "human_gate"


def test_log_redaction(client, fake_cli, settings):
    _project(client)
    fake_cli.env["FAKE_MODE"] = "secret"
    job_id = _start(client)
    job = wait_for(lambda: _terminal(client, job_id))
    text = json.dumps(job["events"]) + (settings.logs_dir / f"{job_id}.log").read_text()
    assert "sk-abcdef" not in text and "Bearer abcdef" not in text
    assert "[REDACTED]" in text


def test_ollama_unavailable_503(client):
    _project(client)
    r = client.post("/api/v1/projects/hcm-demo/draft-jobs", json={"provider": "ollama"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "ollama_unavailable"


def test_fixture_provider_disabled_by_default(settings, fake_cli):
    settings.allow_fixture_provider = False
    with Client(create_app(settings, cli=fake_cli)) as c:
        _project(c)
        r = c.post("/api/v1/projects/hcm-demo/draft-jobs", json=FIXTURE_JOB)
        assert r.status_code == 422 and r.json()["error"]["code"] == "provider_disabled"


def test_draft_job_validation(client):
    _project(client)
    for body in (
        {"provider": "openai"},
        {"provider": "ollama", "model": "x; rm -rf /"},
        {"provider": "fixture", "from_stage": "render"},
        {"provider": "fixture", "force": True},
    ):
        r = client.post("/api/v1/projects/hcm-demo/draft-jobs", json=body)
        assert r.status_code == 422, body


def test_sse_stream_and_replay(client):
    _project(client)
    job_id = _start(client)
    wait_for(lambda: _terminal(client, job_id))

    def read(headers=None):
        events = []
        with client.stream("GET", f"/api/v1/jobs/{job_id}/events", headers=headers) as r:
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("text/event-stream")
            current = {}
            for line in r.iter_lines():
                if line.startswith("id:"):
                    current["id"] = int(line[3:].strip())
                elif line.startswith("event:"):
                    current["event"] = line[6:].strip()
                elif line.startswith("data:"):
                    current["data"] = json.loads(line[5:].strip())
                elif not line and current:
                    events.append(current)
                    current = {}
        return events

    all_events = read()
    assert all_events[-1]["event"] == "completed"
    assert all_events[-1]["data"]["status"] == "succeeded"
    ids = [e["id"] for e in all_events]
    assert ids == sorted(ids) and len(set(ids)) == len(ids)
    replay = read({"Last-Event-ID": str(ids[1])})
    assert [e["id"] for e in replay] == ids[2:]


def test_sse_live_events(client, fake_cli):
    _project(client)
    fake_cli.env["FAKE_MODE"] = "slow"
    job_id = _start(client)
    got = []
    with client.stream("GET", f"/api/v1/jobs/{job_id}/events") as r:
        for line in r.iter_lines():
            if line.startswith("event: log"):
                got.append(line)
            if len(got) >= 3:
                break
    assert len(got) == 3
    client.post(f"/api/v1/jobs/{job_id}/cancel")
    wait_for(lambda: _terminal(client, job_id))


def test_unknown_job(client):
    assert client.get("/api/v1/jobs/not-a-uuid").status_code == 404
    assert client.get("/api/v1/jobs/00000000-0000-0000-0000-000000000000").status_code == 404


def test_restart_reconciles_orphans(settings, fake_cli):
    with Client(create_app(settings, cli=fake_cli)) as c:
        _project(c)
    db = Database(settings.db_path)
    now = utcnow()
    with db.tx() as conn:
        for jid, status, pid in (
            ("11111111-1111-1111-1111-111111111111", "running", 999999),
            ("22222222-2222-2222-2222-222222222222", "queued", None),
        ):
            conn.execute(
                "INSERT INTO jobs(id, project_id, job_type, status, command_args_json, pid,"
                " process_started, created_at, started_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    jid,
                    "hcm-demo",
                    "draft",
                    status,
                    json.dumps({"args": []}),
                    pid,
                    "Mon Jan  1 00:00:00 2001",
                    now,
                    now if pid else None,
                ),
            )
    db.close()
    with Client(create_app(settings, cli=fake_cli)) as c:
        for jid in ("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"):
            job = _job(c, jid)
            assert job["status"] == "interrupted"
            assert "restarted" in job["message"]
            assert job["exit_code"] is None
            assert job["events"][-1]["type"] == "completed"
        # History survives restart.
        assert len(c.get("/api/v1/jobs", params={"project_id": "hcm-demo"}).json()) == 2


def test_event_page_cursor_has_no_gaps(client, settings, fake_cli):
    """Review P2: polling must recover >1,000 missed events in order, without duplicates."""
    _project(client)
    job_id = _start(client)
    wait_for(lambda: _terminal(client, job_id))
    app_jobs = client.app.state.ctx.jobs
    for i in range(2500):
        app_jobs._emit(job_id, "log", {"sequence": 1000 + i, "message": f"extra {i}"})
    expected = [e.id for e in app_jobs.events_after(job_id, 0, 10_000)]
    assert len(expected) > 2500

    seen, after, pages = [], 0, 0
    while True:
        page = client.get(
            f"/api/v1/jobs/{job_id}/events/page", params={"after": after, "limit": 1000}
        ).json()
        seen += [e["id"] for e in page["events"]]
        after = page["next_after"]
        pages += 1
        if not page["has_more"]:
            break
    assert seen == expected  # complete, ordered, no duplicates
    assert pages == 3
    # Resuming from a mid-stream cursor returns exactly the remainder.
    mid = expected[1234]
    rest = client.get(f"/api/v1/jobs/{job_id}/events/page", params={"after": mid}).json()
    assert [e["id"] for e in rest["events"]] == expected[1235 : 1235 + 500]
    empty = client.get(f"/api/v1/jobs/{job_id}/events/page", params={"after": expected[-1]}).json()
    assert empty["events"] == [] and empty["has_more"] is False
    assert empty["next_after"] == expected[-1]


def test_sse_replay_after_long_disconnect_is_complete(client, fake_cli):
    """Review P2: an SSE reconnect with Last-Event-ID replays >1,000 events without gaps."""
    _project(client)
    fake_cli.env["FAKE_MODE"] = "slow"
    job_id = _start(client)
    wait_for(lambda: _job(client, job_id)["status"] == "running")
    jobs = client.app.state.ctx.jobs
    cursor = jobs.events_after(job_id, 0, 1)[0].id  # the client saw only the first event
    for i in range(2200):  # ...then "disconnected" while many events were persisted
        jobs._emit(job_id, "log", {"sequence": 90_000 + i, "message": f"missed {i}"})
    target = jobs.events_after(job_id, 0, 100_000)[-1].id
    expected = [e.id for e in jobs.events_after(job_id, cursor, 100_000) if e.id <= target]
    assert len(expected) > 2200

    ids = []
    with client.stream(
        "GET", f"/api/v1/jobs/{job_id}/events", headers={"Last-Event-ID": str(cursor)}
    ) as r:
        for line in r.iter_lines():
            if line.startswith("id:"):
                ids.append(int(line[3:].strip()))
                if ids[-1] >= target:
                    break
    assert ids[: len(expected)] == expected  # in order, nothing skipped
    assert len(ids) == len(set(ids))  # nothing duplicated
    client.post(f"/api/v1/jobs/{job_id}/cancel")
    wait_for(lambda: _terminal(client, job_id))
