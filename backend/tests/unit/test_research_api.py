"""M3 UI-A: the research workspace API on the fake engine (mirrors engine D-118).

Reads are read-only; every mutation is an engine job with the revision the page loaded;
network use needs the engine's fetch-plan preview and an exact host confirmation."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from app.config import Settings
from app.engine import commands
from tests.conftest import PROJECT, engine_repo, wait_for

API = "/api/v1/projects/hcm-demo"
SEARCH, RESULT = "search.fixture.invalid", "archive.fixture.invalid"


@pytest.fixture
def settings(tmp_root: Path) -> Settings:
    return Settings(
        _env_file=None,
        engine_repo=engine_repo(),
        projects_root=tmp_root / "projects",
        data_dir=tmp_root / "data",
        allow_fixture_provider=True,
        research_search_provider="fixture",
        cancel_grace_seconds=1.0,
        ollama_base_url="http://127.0.0.1:9",
    )


def _root(settings) -> Path:
    return settings.projects_root_real / "hcm-demo"


def _job(client, resp, status: str = "succeeded") -> dict:
    assert resp.status_code == 202, resp.text
    job_id = resp.json()["job_id"]
    return wait_for(
        lambda: (j := client.get(f"/api/v1/jobs/{job_id}").json())["status"] == status and j
    )


@pytest.fixture
def drafted(client, settings) -> None:
    assert client.post("/api/v1/projects", json=PROJECT).status_code == 201
    _job(client, client.post(f"{API}/draft-jobs", json={"provider": "fixture"}))
    (_root(settings) / "review.json").write_text("{}")  # G1, as far as the fake is concerned


def _rev(client) -> str:
    return client.get(f"{API}/research").json()["revision"]


@pytest.fixture
def planned(client, drafted) -> None:
    job = _job(
        client, client.post(f"{API}/research/plan", json={"expected_revision": _rev(client)})
    )
    assert job["message"] == "Claim inventory prepared"


def _preview(client, **params) -> dict:
    r = client.post(
        f"{API}/research/collect/preview", json={"expected_revision": _rev(client), **params}
    )
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- argv


def test_collect_argv_carries_no_free_text_and_one_allow_host_per_host():
    argv = commands.research_collect_args(
        Path("/p"),
        expect_revision="a" * 64,
        search_provider="wikipedia",
        languages=["vi"],
        claim_ids=["clm-abc-1"],
        max_queries=3,
        max_results_per_query=2,
        max_pages=4,
        allow_hosts=["vi.wikipedia.org", "vi.wikipedia.org"],
    )
    assert argv == [
        "research-collect",
        "--project-root=/p",
        "--search-provider=wikipedia",
        "--fetch=auto",
        "--languages=vi",
        "--claim=clm-abc-1",
        "--max-queries=3",
        "--max-results-per-query=2",
        "--max-pages=4",
        "--allow-host=vi.wikipedia.org",
        f"--expect-revision={'a' * 64}",
        "--json",
    ]
    commands.assert_allowlisted(argv)
    both = commands.research_collect_args(
        Path("/p"),
        expect_revision="a" * 64,
        search_provider="wikipedia",
        languages=["vi", "en"],
        claim_ids=[],
        max_queries=8,
        max_results_per_query=5,
        max_pages=15,
        dry_run=True,
    )
    assert not any(a.startswith("--languages") for a in both) and both[-1] == "--dry-run"


@pytest.mark.parametrize(
    "kw",
    [
        {"search_provider": "google"},
        {"languages": ["fr"]},
        {"claim_ids": ["--force"]},
        {"max_pages": 101},
        {"allow_hosts": ["127.0.0.1"]},
        {"allow_hosts": ["localhost"]},
        {"expect_revision": "x"},
    ],
)
def test_collect_argv_rejects_bad_values(kw):
    base = dict(
        expect_revision="a" * 64,
        search_provider="wikipedia",
        languages=["vi"],
        claim_ids=[],
        max_queries=1,
        max_results_per_query=1,
        max_pages=1,
    )
    with pytest.raises(commands.ArgumentError):
        commands.research_collect_args(Path("/p"), **{**base, **kw})


@pytest.mark.parametrize(
    "url",
    [
        "http://a.example/x",
        "https://user:pw@a.example/",
        "https://a.example/x y",
        "https://127.0.0.1/",
    ],
)
def test_add_url_argv_accepts_only_https_hosts(url):
    with pytest.raises(commands.ArgumentError):
        commands.research_add_url_args(
            Path("/p"), expect_revision="a" * 64, url=url, claim_ids=[], fetch="queue"
        )


def test_a_live_fetch_must_confirm_exactly_the_urls_host():
    kw = dict(expect_revision="a" * 64, url="https://vi.wikipedia.org/wiki/X", claim_ids=[])
    with pytest.raises(commands.ArgumentError):
        commands.research_add_url_args(
            Path("/p"), fetch="live", allow_host="en.wikipedia.org", **kw
        )
    argv = commands.research_add_url_args(
        Path("/p"), fetch="live", allow_host="vi.wikipedia.org", **kw
    )
    assert "--allow-host=vi.wikipedia.org" in argv


# --------------------------------------------------------------------------- reads


def test_the_view_before_research_reports_the_revision_and_the_network_policy(client, drafted):
    view = client.get(f"{API}/research").json()
    assert len(view["revision"]) == 64 and view["started"] is False
    assert view["report"]["items"][0]["code"] == "plan_missing"
    assert view["network"] == {"enabled": True, "search_provider": "fixture"}
    assert view["sources"] == [] and view["active_job_id"] is None


def test_plan_collect_and_read(client, planned, settings):
    view = client.get(f"{API}/research").json()
    assert view["started"] and view["report"]["claims"]
    preview = _preview(client)
    assert preview["search_hosts"] == [SEARCH] and RESULT in preview["hosts"]
    job = _job(
        client,
        client.post(
            f"{API}/research/collect",
            json={
                "expected_revision": preview["revision"],
                "network": True,
                "plan_sha256": preview["plan_sha256"],
                "allow_hosts": preview["hosts"],
            },
        ),
    )
    assert job["message"] == "Source collection finished"
    view = client.get(f"{API}/research").json()
    assert view["sources"][0]["host"] == RESULT and view["snapshots"][0]["acquisition"] == "fixture"
    snap = view["snapshots"][0]["id"]
    page = client.get(f"{API}/research/snapshots/{snap}").json()
    assert page["text"].startswith("Ngày 2 tháng 9 năm 1945") and page["snapshot"]["id"] == snap


def test_a_collection_runs_only_with_the_confirmed_preview(client, planned):
    preview = _preview(client)
    body = {
        "expected_revision": preview["revision"],
        "network": True,
        "plan_sha256": preview["plan_sha256"],
        "allow_hosts": preview["hosts"],
    }
    r = client.post(f"{API}/research/collect", json={**body, "plan_sha256": "0" * 64})
    assert r.status_code == 422 and r.json()["error"]["code"] == "network_not_confirmed"
    assert r.json()["error"]["details"]["preview"]["hosts"] == preview["hosts"]
    r = client.post(f"{API}/research/collect", json={**body, "allow_hosts": [SEARCH]})
    assert r.status_code == 422 and r.json()["error"]["code"] == "network_not_confirmed"
    r = client.post(f"{API}/research/collect", json={**body, "network": False})
    assert r.status_code == 422  # network must be confirmed explicitly


def test_a_queued_url_joins_the_next_preview(client, planned):
    job = _job(
        client,
        client.post(
            f"{API}/research/sources",
            json={
                "expected_revision": _rev(client),
                "url": "https://elsewhere.example.net/page",
            },
        ),
    )
    assert job["message"] == "Source added"
    source = client.get(f"{API}/research").json()["sources"][0]
    assert source["user_supplied"] and source["state"] == "discovered"
    preview = _preview(client)
    assert "elsewhere.example.net" in preview["hosts"]
    assert any(t["reason"] == "user_supplied" for t in preview["known_targets"])


def test_a_live_fetch_needs_its_host_confirmed(client, planned):
    url = "https://elsewhere.example.net/page"
    body = {"expected_revision": _rev(client), "url": url, "fetch": "live"}
    r = client.post(f"{API}/research/sources", json=body)
    assert r.status_code == 422 and r.json()["error"]["details"] == {
        "host": "elsewhere.example.net"
    }
    r = client.post(
        f"{API}/research/sources",
        json={**body, "network": True, "allow_hosts": ["other.example.net"]},
    )
    assert r.status_code == 422
    _job(
        client,
        client.post(
            f"{API}/research/sources",
            json={**body, "network": True, "allow_hosts": ["elsewhere.example.net"]},
        ),
    )
    assert client.get(f"{API}/research").json()["snapshots"]


def test_network_actions_can_be_turned_off(client, planned, app):
    app.state.ctx.settings.research_network = False
    preview = _preview(client)
    r = client.post(
        f"{API}/research/collect",
        json={
            "expected_revision": preview["revision"],
            "network": True,
            "plan_sha256": preview["plan_sha256"],
            "allow_hosts": preview["hosts"],
        },
    )
    assert r.status_code == 403 and r.json()["error"]["code"] == "network_disabled"
    r = client.post(
        f"{API}/research/sources",
        json={
            "expected_revision": _rev(client),
            "url": "https://a.example.net/x",
            "fetch": "live",
            "network": True,
            "allow_hosts": ["a.example.net"],
        },
    )
    assert r.status_code == 403
    queued = client.post(
        f"{API}/research/sources",
        json={"expected_revision": _rev(client), "url": "https://a.example.net/x"},
    )
    assert queued.status_code == 202  # queueing contacts nothing
    assert client.get("/api/v1/system/config").json()["research_network"] is False


def test_a_stale_revision_is_refused(client, planned):
    r = client.post(f"{API}/research/collect/preview", json={"expected_revision": "0" * 64})
    assert r.status_code == 409 and r.json()["error"]["code"] == "revision_conflict"
    assert r.json()["error"]["details"]["current_revision"] == _rev(client)
    job = _job(
        client, client.post(f"{API}/research/plan", json={"expected_revision": "0" * 64}), "failed"
    )
    assert job["error_code"] == "engine_conflict"


def test_a_change_during_the_network_phase_records_nothing(client, planned, fake_cli):
    preview = _preview(client)
    fake_cli.env["FAKE_MODE"] = "research_race"
    job = _job(
        client,
        client.post(
            f"{API}/research/collect",
            json={
                "expected_revision": preview["revision"],
                "network": True,
                "plan_sha256": preview["plan_sha256"],
                "allow_hosts": preview["hosts"],
            },
        ),
        "failed",
    )
    assert job["error_code"] == "engine_conflict"
    assert client.get(f"{API}/research").json()["sources"] == []


def test_the_snapshot_reader_serves_only_verified_text(client, planned, settings):
    _job(
        client,
        client.post(
            f"{API}/research/sources",
            json={
                "expected_revision": _rev(client),
                "url": "https://a.example.net/x",
                "fetch": "live",
                "network": True,
                "allow_hosts": ["a.example.net"],
            },
        ),
    )
    snap = client.get(f"{API}/research").json()["snapshots"][0]
    assert client.get(f"{API}/research/snapshots/not-a-snapshot").status_code == 422
    assert client.get(f"{API}/research/snapshots/snap-0000000000000000").status_code == 404
    page = _root(settings) / "render/research/pages" / f"{snap['text_sha256']}.txt"
    page.write_text("altered", "utf-8")
    r = client.get(f"{API}/research/snapshots/{snap['id']}")
    assert r.status_code == 409 and r.json()["error"]["code"] == "snapshot_tampered"
    assert hashlib.sha256(b"altered").hexdigest() != snap["text_sha256"]


def test_mutations_need_the_csrf_token(client, planned):
    r = client.post(
        f"{API}/research/plan",
        json={"expected_revision": _rev(client)},
        headers={"X-CSRF-Token": "wrong"},
    )
    assert r.status_code == 403


def test_a_research_job_conflicts_with_a_running_job(client, planned, fake_cli):
    fake_cli.env["FAKE_MODE"] = "research_slow"
    preview = _preview(client)
    body = {
        "expected_revision": preview["revision"],
        "network": True,
        "plan_sha256": preview["plan_sha256"],
        "allow_hosts": preview["hosts"],
    }
    first = client.post(f"{API}/research/collect", json=body)
    assert first.status_code == 202
    r = client.post(f"{API}/research/plan", json={"expected_revision": preview["revision"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "job_conflict"
    client.post(f"/api/v1/jobs/{first.json()['job_id']}/cancel")
