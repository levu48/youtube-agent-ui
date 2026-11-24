"""M4 UI-A: the visuals workspace API on the fake engine (mirrors engine D-122 at 65c5f52).

Reads come from one engine ``visuals-state`` snapshot; images are served by engine ID and
expected hash from a snapshot re-validated against the files; every mutation carries the
loaded revision and is refused first while a publication is pending; network use needs the
engine's preview and an exact host confirmation, checked by the backend and the engine."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import struct
import zlib
from pathlib import Path

import pytest

from app import visuals as V
from app.api import visuals_routes as VR
from app.config import Settings
from app.engine import commands
from app.engine.runner import EngineResult
from app.jobs import _json_error_code
from tests.conftest import PROJECT, engine_repo, wait_for
from tests.fake_visuals import png, sha256_json

API = "/api/v1/projects/hcm-demo"
FIXTURE_HOSTS = ["commons.fixture.invalid", "upload.fixture.invalid"]


@pytest.fixture
def settings(tmp_root: Path) -> Settings:
    return Settings(
        _env_file=None,
        engine_repo=engine_repo(),
        projects_root=tmp_root / "projects",
        data_dir=tmp_root / "data",
        allow_fixture_provider=True,
        visuals_search_provider="fixture",
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


def _calls(settings) -> list[str]:
    p = _root(settings) / "visuals-calls.jsonl"
    if not p.exists():
        return []
    return [json.loads(line)["argv"][0] for line in p.read_text().splitlines()]


def _writes(settings) -> list[str]:
    return [c for c in _calls(settings) if c != "visuals-state"]


@pytest.fixture
def drafted(client, settings) -> None:
    assert client.post("/api/v1/projects", json=PROJECT).status_code == 201
    _job(client, client.post(f"{API}/draft-jobs", json={"provider": "fixture"}))
    (_root(settings) / "review.json").write_text("{}")  # G1, as far as the fake is concerned


def _view(client) -> dict:
    r = client.get(f"{API}/visuals")
    assert r.status_code == 200, r.text
    return r.json()


def _rev(client) -> str:
    return _view(client)["revision"]


@pytest.fixture
def planned(client, drafted) -> None:
    job = _job(client, client.post(f"{API}/visuals/plan", json={"expected_revision": _rev(client)}))
    assert job["message"] == "Visual plan written"


def _preview(client, **params) -> dict:
    r = client.post(
        f"{API}/visuals/acquire/preview", json={"expected_revision": _rev(client), **params}
    )
    assert r.status_code == 200, r.text
    return r.json()


def _acquire(client, p: dict, **extra):
    return client.post(
        f"{API}/visuals/acquire",
        json={
            "expected_revision": p["preview"]["revision"],
            "network": True,
            "preview_sha256": p["preview_sha256"],
            "allow_hosts": p["preview"]["hosts"],
            **extra,
        },
    )


@pytest.fixture
def acquired(client, planned) -> None:
    _job(client, _acquire(client, _preview(client)))


def _candidate(client) -> dict:
    v = _view(client)
    return next(c for items in v["candidates"].values() for c in items)


def _pending(settings, rel: str = "render/llm/manifest.json") -> None:
    p = _root(settings) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"schema_version": "x", "pending": {"run_id": "r1"}}))


# --------------------------------------------------------------------------- argv


def test_acquire_argv_is_search_only_and_bound_to_the_preview():
    rev, pv = "a" * 64, "b" * 64
    dry = commands.visuals_acquire_args(
        Path("/p"),
        expect_revision=rev,
        search_provider="wikimedia",
        scene_ids=["scene-001", "scene-001"],
        max_candidates_per_scene=4,
        dry_run=True,
    )
    assert dry == [
        "visuals-acquire",
        "--project-root=/p",
        "--search-provider=wikimedia",
        "--image-provider=none",
        "--scene=scene-001",
        "--max-candidates-per-scene=4",
        "--dry-run",
        f"--expect-revision={rev}",
        "--json",
    ]
    run = commands.visuals_acquire_args(
        Path("/p"),
        expect_revision=rev,
        search_provider="wikimedia",
        scene_ids=[],
        max_candidates_per_scene=4,
        expect_preview=pv,
        allow_hosts=["upload.wikimedia.org", "commons.wikimedia.org"],
    )
    assert f"--expect-preview={pv}" in run
    assert [a for a in run if a.startswith("--allow-host")] == [
        "--allow-host=upload.wikimedia.org",
        "--allow-host=commons.wikimedia.org",
    ]
    for argv in (dry, run):
        commands.assert_allowlisted(argv)
        assert not any(a.startswith(("--force", "--allow-paid", "--replace")) for a in argv)


@pytest.mark.parametrize(
    "kw",
    [
        {"search_provider": "openai"},
        {"scene_ids": ["--force"]},
        {"scene_ids": ["a b"]},
        {"max_candidates_per_scene": 0},
        {"max_candidates_per_scene": 21},
        {"max_candidates_per_scene": True},
        {"expect_preview": None},
        {"expect_preview": "x"},
        {"allow_hosts": []},
        {"allow_hosts": ["127.0.0.1"]},
        {"allow_hosts": ["localhost"]},
        {"expect_revision": "x"},
    ],
)
def test_acquire_argv_rejects_bad_values(kw):
    base = dict(
        expect_revision="a" * 64,
        search_provider="wikimedia",
        scene_ids=[],
        max_candidates_per_scene=4,
        expect_preview="b" * 64,
        allow_hosts=["commons.wikimedia.org"],
    )
    with pytest.raises(commands.ArgumentError):
        commands.visuals_acquire_args(Path("/p"), **{**base, **kw})


def test_import_argv_puts_bytes_on_stdin_and_each_field_in_one_element():
    argv = commands.visuals_import_args(
        Path("/p"),
        expect_revision="a" * 64,
        scene_id="scene-002",
        kind="archival",
        title="Harbour, 1902",
        provenance="Scanned from my own print, bought in 2019.",
        source_url="https://example.org/harbour",
        creator="--force",
    )
    assert argv[:5] == [
        "visuals-import",
        "--project-root=/p",
        "--scene=scene-002",
        "--stdin",
        "--kind=archival",
    ]
    assert "--creator=--force" in argv  # one element: a value, never a flag
    assert not any(a.startswith("--file") for a in argv)
    commands.assert_allowlisted(argv)
    for bad in (
        {"kind": "photo"},
        {"scene_id": "-x"},
        {"provenance": "short"},
        {"title": "two\nlines"},
        {"source_url": "file:///etc/passwd"},
        {"license_url": "http://example.org"},
        {"path": "/etc/passwd"},
    ):
        kw = dict(scene_id="scene-002", kind="archival", title="t", provenance="0123456789ab")
        with pytest.raises(commands.ArgumentError):
            commands.visuals_import_args(Path("/p"), expect_revision="a" * 64, **{**kw, **bad})


@pytest.mark.parametrize(
    "argv",
    [
        ["visuals-apply", "--project-root=/p", "--replace-assets"],
        ["visuals-acquire", "--project-root=/p", "--allow-paid"],
        ["visuals-acquire", "--project-root=/p", "--image-provider=openai"],
        ["visuals-acquire", "--project-root=/p", "--force"],
        ["visuals-import", "--project-root=/p", "--file=/etc/passwd"],
        ["visuals-plan", "--project-root=/p", "--replace-plan"],
        ["visuals-check", "--project-root=/p"],
    ],
)
def test_the_allowlist_refuses_force_replace_paid_and_paths(argv):
    with pytest.raises(commands.ArgumentError):
        commands.assert_allowlisted(argv)


# --------------------------------------------------------------------------- view and plan


def test_the_view_is_one_engine_snapshot_and_writes_nothing(client, drafted, settings):
    before = sorted(p.name for p in _root(settings).iterdir())
    v = _view(client)
    assert v["scheme"] == "m4-visuals-state-1" and len(v["revision"]) == 64
    assert v["gates"]["g1"]["status"] == "approved" and v["gates"]["g3"]["status"] == "pending"
    assert v["recovery_required"] is False and v["plan"] is None
    assert v["network"] == {"enabled": True, "search_provider": "fixture"}
    assert v["editing"]["supported"] is False and "visuals-edit" in v["editing"]["reason"]
    assert v["narration"]["scene-001"]  # the storyboard bytes the snapshot was built from
    assert "ok" not in v
    after = sorted(p.name for p in _root(settings).iterdir() if p.name != "visuals-calls.jsonl")
    assert after == before
    assert _writes(settings) == []


def test_narration_is_omitted_when_the_storyboard_is_not_the_snapshots(drafted, settings):
    snap = {"inputs": {"storyboard.draft.json": "0" * 64}}
    assert V.scene_narrations(snap, _root(settings)) == {}


def test_plan_is_a_job_under_the_loaded_revision(client, drafted, settings):
    rev = _rev(client)
    job = _job(client, client.post(f"{API}/visuals/plan", json={"expected_revision": rev}))
    assert job["type"] == "visuals-plan" and job["message"] == "Visual plan written"
    v = _view(client)
    assert v["plan"]["scenes"] and v["revision"] != rev
    assert v["gates"]["g3"]["status"] == "needs_review"
    stale = client.post(f"{API}/visuals/plan", json={"expected_revision": rev})
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "revision_conflict"
    assert stale.json()["error"]["details"]["current_revision"] == v["revision"]
    assert _writes(settings).count("visuals-plan") == 1


def test_plan_without_g1_fails_with_the_engines_code(client, drafted, settings):
    (_root(settings) / "review.json").unlink()
    job = _job(
        client,
        client.post(f"{API}/visuals/plan", json={"expected_revision": _rev(client)}),
        "failed",
    )
    assert job["error_code"] == "g1_not_current"
    assert "G1" in job["message"]


# --------------------------------------------------------------------------- acquire


def test_preview_contacts_nothing_and_names_the_exact_hosts(client, planned, settings):
    p = _preview(client, max_candidates_per_scene=3)
    assert p["preview"]["hosts"] == FIXTURE_HOSTS
    assert p["preview"]["max_candidates_per_scene"] == 3
    assert p["preview"]["image_provider"] == "none" and p["preview"]["force"] is False
    assert p["preview_sha256"] == sha256_json(p["preview"])
    assert not (_root(settings) / "render/visuals/candidates.json").exists()


def test_a_confirmed_search_runs_bound_to_the_preview(client, planned, settings):
    p = _preview(client)
    job = _job(client, _acquire(client, p))
    assert job["type"] == "visuals-acquire" and job["message"] == "Image search finished"
    argv = [
        json.loads(x)["argv"]
        for x in (_root(settings) / "visuals-calls.jsonl").read_text().splitlines()
        if json.loads(x)["argv"][0] == "visuals-acquire" and "--dry-run" not in x
    ][-1]
    assert f"--expect-preview={p['preview_sha256']}" in argv
    assert sorted(a for a in argv if a.startswith("--allow-host")) == [
        f"--allow-host={h}" for h in FIXTURE_HOSTS
    ]
    assert "--image-provider=none" in argv
    v = _view(client)
    assert v["catalog_trusted"] is True and sum(len(c) for c in v["candidates"].values()) > 0
    detail = client.get(f"/api/v1/jobs/{job['id']}").json()
    assert any("search scene-001" in e["data"].get("message", "") for e in detail["events"])


@pytest.mark.parametrize(
    "change",
    [
        {"preview_sha256": "0" * 64},
        {"allow_hosts": ["commons.fixture.invalid"]},
        {"allow_hosts": [*FIXTURE_HOSTS, "evil.example.com"]},
        {"max_candidates_per_scene": 5},
        {"scene_ids": ["scene-001"]},
    ],
)
def test_the_backend_refuses_anything_but_the_confirmed_preview(client, planned, settings, change):
    p = _preview(client)
    r = _acquire(client, p, **change)
    assert r.status_code == 409, r.text
    err = r.json()["error"]
    assert err["code"] == "preview_mismatch" and err["details"]["checked_by"] == "backend"
    assert err["details"]["preview"]["hosts"]  # what would run now, to confirm again
    assert all("--dry-run" in line for line in _acquire_lines(settings))  # no run started
    assert client.get("/api/v1/jobs?project_id=hcm-demo").json()[0]["type"] == "visuals-plan"


def _acquire_lines(settings) -> list[str]:
    lines = (_root(settings) / "visuals-calls.jsonl").read_text().splitlines()
    return [x for x in lines if '"visuals-acquire"' in x]


def test_the_engine_refuses_a_preview_that_changed_after_the_backend_check(
    client, planned, fake_cli
):
    p = _preview(client)
    fake_cli.env["FAKE_MODE"] = "visuals_preview_drift"
    job = _job(client, _acquire(client, p), "failed")
    assert job["error_code"] == "preview_mismatch" and job["exit_code"] == 9
    assert "Nothing was contacted" in job["message"]


def test_a_change_during_the_network_phase_records_nothing(client, planned, fake_cli, settings):
    p = _preview(client)
    fake_cli.env["FAKE_MODE"] = "visuals_race"
    job = _job(client, _acquire(client, p), "failed")
    assert job["error_code"] == "revision_mismatch"
    assert not (_root(settings) / "render/visuals/candidates.json").exists()


def test_a_partial_search_failure_is_reported_as_such(client, planned, fake_cli):
    p = _preview(client)
    fake_cli.env["FAKE_MODE"] = "visuals_partial"
    job = _job(client, _acquire(client, p), "failed")
    assert job["exit_code"] == 13 and job["error_code"] == "partial_acquire_failure"
    assert sum(len(c) for c in _view(client)["candidates"].values()) > 0


def test_a_slow_search_can_be_cancelled(client, planned, fake_cli):
    p = _preview(client)
    fake_cli.env["FAKE_MODE"] = "visuals_slow"
    r = _acquire(client, p)
    job_id = r.json()["job_id"]
    wait_for(lambda: client.get(f"/api/v1/jobs/{job_id}").json()["status"] == "running")
    wait_for(
        lambda: any(
            "slow" in e["data"].get("message", "")
            for e in client.get(f"/api/v1/jobs/{job_id}").json()["events"]
        )
    )
    client.post(f"/api/v1/jobs/{job_id}/cancel")
    done = wait_for(
        lambda: (j := client.get(f"/api/v1/jobs/{job_id}").json())["status"] == "cancelled" and j
    )
    assert done["error_code"] == "cancelled"


def test_network_disabled_refuses_preview_and_search_without_an_engine_run(
    client, planned, settings, app
):
    rev = _rev(client)
    app.state.ctx.settings.visuals_network = False
    before = _calls(settings)
    for path, body in (
        ("acquire/preview", {"expected_revision": rev}),
        (
            "acquire",
            {
                "expected_revision": rev,
                "network": True,
                "preview_sha256": "0" * 64,
                "allow_hosts": FIXTURE_HOSTS,
            },
        ),
    ):
        r = client.post(f"{API}/visuals/{path}", json=body)
        assert r.status_code == 403 and r.json()["error"]["code"] == "network_disabled"
    assert _calls(settings) == before
    assert client.get("/api/v1/system/config").json()["visuals_network"] is False
    assert _view(client)["network"]["enabled"] is False


def test_the_search_request_needs_an_explicit_network_confirmation(client, planned):
    p = _preview(client)
    for change in ({"network": False}, {"allow_hosts": []}, {"preview_sha256": "x"}):
        r = _acquire(client, p, **change)
        assert r.status_code == 422, r.text


# --------------------------------------------------------------------------- pending recovery


def test_pending_recovery_refuses_every_write_before_any_engine_command(client, planned, settings):
    rev = _rev(client)
    p = _preview(client)
    _pending(settings)
    v = _view(client)
    assert v["recovery_required"] is True
    assert v["pending_journals"][0]["code"] == "recovery_required"
    before = _writes(settings)
    for path, body in (
        ("plan", {"expected_revision": v["revision"]}),
        ("acquire/preview", {"expected_revision": v["revision"]}),
        (
            "acquire",
            {
                "expected_revision": v["revision"],
                "network": True,
                "preview_sha256": p["preview_sha256"],
                "allow_hosts": FIXTURE_HOSTS,
            },
        ),
    ):
        r = client.post(f"{API}/visuals/{path}", json=body)
        assert r.status_code == 409, r.text
        err = r.json()["error"]
        assert err["code"] == "recovery_required" and err["details"]["checked_by"] == "backend"
        assert "recovery_required" in err["details"]["journals"][0]["code"]
    r = _upload(client, v["revision"], png(8, 8, (1, 2, 3)))
    assert r.status_code == 409 and r.json()["error"]["code"] == "recovery_required"
    assert _writes(settings) == before
    assert rev != v["revision"]  # the journal manifest is an input: the revision changed
    # Reads continue.
    assert client.get(f"{API}/visuals").status_code == 200


def test_a_cli_recovery_lifts_the_refusal_on_the_next_request(client, planned, settings):
    _pending(settings)
    rev = _rev(client)
    assert client.post(f"{API}/visuals/plan", json={"expected_revision": rev}).status_code == 409
    (_root(settings) / "render/llm/manifest.json").write_text('{"pending": null}')
    r = client.post(f"{API}/visuals/acquire/preview", json={"expected_revision": rev})
    assert r.status_code == 409 and r.json()["error"]["code"] == "revision_conflict"
    rev = r.json()["error"]["details"]["current_revision"]
    r = client.post(f"{API}/visuals/acquire/preview", json={"expected_revision": rev})
    assert r.status_code == 200, r.text


def test_a_pending_production_package_journal_alone_refuses_nothing(client, planned, settings):
    _pending(settings, "render/production/manifest.json")
    v = _view(client)
    assert v["recovery_required"] is False and len(v["pending_journals"]) == 1
    assert v["pending_journals"][0]["stage"] == "package"
    r = client.post(f"{API}/visuals/acquire/preview", json={"expected_revision": v["revision"]})
    assert r.status_code == 200, r.text


def _res(code: str, exit_code: int, **details) -> EngineResult:
    body = {"ok": False, "error": {"code": code, "exit_code": exit_code, "message": "m",
                                   "details": details}}  # fmt: skip
    return EngineResult(["visuals-plan"], exit_code, json.dumps(body), "error: m", 0.1)


def test_engine_refusals_map_to_the_contracts_codes():
    m = VR._visuals_failure
    e = m(_res("recovery_required", 9, journals=["render/llm/manifest.json", "/etc/x"]), "x")
    assert (e.status, e.code, e.details) == (
        409,
        "recovery_required",
        {"checked_by": "engine", "journals": ["render/llm/manifest.json"]},
    )
    e = m(_res("preview_mismatch", 9, preview_sha256="a" * 64, hosts=["h.example"]), "x")
    assert e.code == "preview_mismatch" and e.details["checked_by"] == "engine"
    assert e.details["hosts"] == ["h.example"]
    e = m(_res("revision_mismatch", 9, current_revision="b" * 64), "x")
    assert e.code == "revision_conflict" and e.details["current_revision"] == "b" * 64
    assert m(_res("catalog_untrusted", 2), "x").code == "catalog_untrusted"
    e = m(_res("image_integrity", 2, candidate_ids=["scene-001-cm-0123456789", "../x"]), "x")
    assert e.status == 409 and e.details["candidate_ids"] == ["scene-001-cm-0123456789"]
    assert m(_res("g1_not_current", 12), "x").status == 409
    assert m(_res("not_ready", 2), "x").code == "not_ready"
    assert m(_res("invalid_input", 2), "x").status == 422
    assert m(_res("error", 3), "import the image").code == "visuals_refused"
    assert m(_res("concurrency", 9), "x").code == "engine_conflict"


def test_job_outcomes_use_the_engines_json_error_code():
    lines = ["noise", "{", '  "ok": false,', '  "error": {"code": "preview_mismatch"}', "}"]
    assert _json_error_code(lines) == "preview_mismatch"
    assert _json_error_code(['{"ok": true}']) is None
    assert _json_error_code(["not json"]) is None


# --------------------------------------------------------------------------- images


def _img(client, c: dict, sha: str | None = None, *, kind: str = "candidates", ident=None):
    ident = ident or c["id"]
    q = "" if sha == "" else f"?sha256={sha or c['sha256']}"
    return client.get(f"{API}/visuals/{kind}/{ident}/image{q}")


def test_a_candidate_image_is_served_verified_and_immutable(client, acquired, settings):
    c = _candidate(client)
    r = _img(client, c)
    assert r.status_code == 200, r.text
    assert hashlib.sha256(r.content).hexdigest() == c["sha256"]
    h = r.headers
    assert h["content-type"] == "image/png"
    assert h["x-content-type-options"] == "nosniff"
    assert h["content-security-policy"] == "default-src 'none'; sandbox"
    assert h["content-disposition"] == "inline"
    assert h["cache-control"] == "private, max-age=31536000, immutable"
    assert h["etag"] == f'"{c["sha256"]}"'


@pytest.mark.parametrize("sha", ["", "ABC", "g" * 64, "a" * 63])
def test_an_image_request_needs_a_well_formed_hash(client, acquired, sha):
    r = _img(client, _candidate(client), sha)
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_input"
    assert r.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("ident", ["..%2F..%2Finput.json", "scene-001-cm-zz", "x"])
def test_an_image_request_needs_a_well_formed_id(client, acquired, ident):
    r = _img(client, _candidate(client), ident=ident)
    assert r.status_code in (400, 404)
    assert r.headers["cache-control"] == "no-store"


def test_unknown_ids_and_contact_sheets_are_not_served(client, acquired, settings):
    c = _candidate(client)
    r = _img(client, c, ident="scene-001-cm-0000000000")
    assert r.status_code == 404
    sheet = _root(settings) / "render/visuals/previews/scene-001.png"
    sheet.parent.mkdir(parents=True, exist_ok=True)
    sheet.write_bytes(png(4, 4, (0, 0, 0)))
    for path in ("previews/scene-001/image", "previews/scene-001.png"):
        assert client.get(f"{API}/visuals/{path}?sha256={c['sha256']}").status_code == 404


def test_an_outdated_url_gets_image_changed_never_old_bytes(client, acquired, settings):
    c = _candidate(client)
    r = _img(client, c, "f" * 64)
    assert r.status_code == 409 and r.json()["error"]["code"] == "image_changed"
    assert r.json()["error"]["details"]["current_sha256"] == c["sha256"]
    assert r.headers["cache-control"] == "no-store"


def _retarget(settings, cid: str, **change) -> None:
    """A CLI change to the catalogue, keeping it trusted (as visuals-acquire would)."""
    root = _root(settings)
    path = root / "render/visuals/candidates.json"
    doc = json.loads(path.read_text())
    for c in doc["candidates"]:
        if c["id"] == cid:
            c.update(change)
    path.write_text(json.dumps(doc))
    man = root / "render/visuals/manifest.json"
    m = json.loads(man.read_text())
    m["files"]["render/visuals/candidates.json"] = hashlib.sha256(path.read_bytes()).hexdigest()
    man.write_text(json.dumps(m))


def test_a_cli_catalogue_change_refreshes_the_snapshot_and_refuses_the_old_image(
    client, acquired, settings, app
):
    c = _candidate(client)
    assert _img(client, c).status_code == 200
    runs = app.state.ctx.visuals.runs
    assert _img(client, c).status_code == 200
    assert app.state.ctx.visuals.runs == runs  # unchanged files: the kept snapshot is used
    other = png(10, 10, (9, 9, 9))
    sha = hashlib.sha256(other).hexdigest()
    rel = f"render/visuals/candidates/{sha}.png"
    (_root(settings) / rel).write_bytes(other)
    _retarget(settings, c["id"], sha256=sha, local_path=rel)
    r = _img(client, c)
    assert app.state.ctx.visuals.runs == runs + 1
    assert r.status_code == 409 and r.json()["error"]["code"] == "image_changed"
    assert _img(client, c, sha).status_code == 200


def test_a_hand_edited_catalogue_serves_nothing(client, acquired, settings):
    c = _candidate(client)
    p = _root(settings) / "render/visuals/candidates.json"
    p.write_text(p.read_text() + " ")
    r = _img(client, c)
    assert r.status_code == 409 and r.json()["error"]["code"] == "catalog_untrusted"


def test_a_failed_refresh_serves_nothing(client, acquired, settings, fake_cli):
    c = _candidate(client)
    p = _root(settings) / "render/visuals/candidates.json"
    p.write_text(p.read_text() + " ")
    fake_cli.env["FAKE_MODE"] = "visuals_state_fail"
    r = _img(client, c)
    assert r.status_code == 503 and r.json()["error"]["code"] == "state_unavailable"
    assert r.headers["cache-control"] == "no-store"


def test_corrupted_missing_and_symlinked_images_are_refused(client, acquired, settings, tmp_path):
    c = _candidate(client)
    f = _root(settings) / c["local_path"]
    good = f.read_bytes()
    f.write_bytes(good[:-4] + b"\x00\x00\x00\x00")
    r = _img(client, c)
    assert r.status_code == 409 and r.json()["error"]["code"] == "image_integrity"
    f.unlink()
    r = _img(client, c)
    assert r.status_code == 409 and r.json()["error"]["code"] == "image_integrity"
    outside = tmp_path / "outside.png"
    outside.write_bytes(good)
    f.symlink_to(outside)
    r = _img(client, c)
    assert r.status_code == 409 and r.json()["error"]["code"] == "image_integrity"
    f.unlink()
    # A symlinked directory anywhere in the path.
    cdir = f.parent
    moved = tmp_path / "cands"
    cdir.rename(moved)
    (moved / f.name).write_bytes(good)
    cdir.symlink_to(moved)
    r = _img(client, c)
    assert r.status_code == 409 and r.json()["error"]["code"] == "image_integrity"


def _jpeg(w: int, h: int) -> bytes:
    sof = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, h, w, 1) + b"\x01\x11\x00"
    return (
        b"\xff\xd8\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x00" * 9 + sof + b"\xff\xd9"
    )


def _big_png(w: int, h: int) -> bytes:
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    body = b"IHDR" + ihdr
    return (
        V.PNG_MAGIC
        + struct.pack(">I", 13)
        + body
        + struct.pack(">I", zlib.crc32(body))
        + b"\x00" * 16
    )


@pytest.mark.parametrize(
    ("data", "ext"),
    [
        (png(4, 4, (1, 1, 1)), "jpg"),  # a PNG named .jpg
        (_jpeg(4, 4), "png"),  # a JPEG named .png
        (b"<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>", "png"),
        (b"<!doctype html><script>alert(1)</script>", "jpg"),
        (_big_png(8000, 6000), "png"),  # 48 megapixels
        (_jpeg(9000, 9000), "jpg"),
    ],
)
def test_disguised_or_oversized_images_are_refused(client, acquired, settings, data, ext):
    c = _candidate(client)
    sha = hashlib.sha256(data).hexdigest()
    rel = f"render/visuals/candidates/{sha}.{ext}"
    (_root(settings) / rel).write_bytes(data)
    _retarget(settings, c["id"], sha256=sha, local_path=rel, format=ext)
    r = _img(client, c, sha)
    assert r.status_code == 409 and r.json()["error"]["code"] == "image_integrity", r.text


def test_a_jpeg_is_served_as_jpeg(client, acquired, settings):
    c = _candidate(client)
    data = _jpeg(20, 10)
    sha = hashlib.sha256(data).hexdigest()
    rel = f"render/visuals/candidates/{sha}.jpg"
    (_root(settings) / rel).write_bytes(data)
    _retarget(settings, c["id"], sha256=sha, local_path=rel, format="jpg")
    r = _img(client, c, sha)
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"


def test_an_oversized_file_is_never_read(acquired, settings, tmp_path):
    f = tmp_path / "x"
    f.mkdir()
    big = f / ("a" * 64 + ".png")
    with open(big, "wb") as fh:
        fh.truncate(V.MAX_IMAGE_BYTES + 1)
    with pytest.raises(V.VisualsError) as exc:
        V.read_verified(
            tmp_path, f"x/{'a' * 64}.png", "a" * 64, V.re.compile(r"^x/([0-9a-f]{64})\.(png)$")
        )
    assert exc.value.code == "image_integrity"


def _apply(settings, *, intact: bool = True) -> tuple[str, str]:
    """An applied asset, as visuals-apply would leave it (the fake reads these files)."""
    root = _root(settings)
    data = png(16, 9, (5, 6, 7))
    sha = hashlib.sha256(data).hexdigest()
    rel = f"assets/images/{sha}.png"
    (root / "assets/images").mkdir(parents=True, exist_ok=True)
    (root / rel).write_bytes(data)
    aid = f"img-{sha[:16]}"
    rec = {"local_path": rel, "rights_verified": True}
    (root / "assets.json").write_text(json.dumps({"assets": {aid: rec}}))
    applied = {"assets": {aid: sha256_json(rec) if intact else "0" * 64},
               "asset_candidates": {aid: ["scene-001-cm-0123456789"]}}  # fmt: skip
    (root / "render/visuals").mkdir(parents=True, exist_ok=True)
    (root / "render/visuals/applied.json").write_text(json.dumps(applied))
    sb = root / "storyboard.draft.json"
    doc = json.loads(sb.read_text())
    doc["scenes"][0]["shots"] = [{"asset_id": aid}]
    sb.write_text(json.dumps(doc))
    return aid, sha


def test_an_applied_asset_image_is_served_through_the_apply_chain(client, drafted, settings):
    aid, sha = _apply(settings)
    v = _view(client)
    fact = v["assets"][0]
    assert fact["asset_id"] == aid and fact["record_intact"] and fact["candidate_ids"]
    r = client.get(f"{API}/visuals/assets/{aid}/image?sha256={sha}")
    assert r.status_code == 200 and hashlib.sha256(r.content).hexdigest() == sha
    assert r.headers["cache-control"] == "private, max-age=31536000, immutable"
    assert v["scenes"][0]["apply_state"] == "existing_shots"
    r = client.get(f"{API}/visuals/assets/{aid}/image?sha256={'e' * 64}")
    assert r.status_code == 409 and r.json()["error"]["code"] == "image_changed"


def test_an_asset_whose_record_changed_is_not_served(client, drafted, settings):
    aid, sha = _apply(settings, intact=False)
    r = client.get(f"{API}/visuals/assets/{aid}/image?sha256={sha}")
    assert r.status_code == 409 and r.json()["error"]["code"] == "image_integrity"
    r = client.get(f"{API}/visuals/assets/img-0000000000000000/image?sha256={sha}")
    assert r.status_code == 404


def test_an_evidence_document_change_invalidates_the_snapshot(client, drafted, settings, app):
    root = _root(settings)
    (root / "permission.txt").write_text("permission granted")
    sel = {
        "scenes": [],
        "rights_clearances": [
            {"candidate_id": "c", "evidence": "permission.txt"},
            {"candidate_id": "d", "evidence": "https://x.org/a"},
        ],
    }
    (root / "visual-selection.json").write_text(json.dumps(sel))
    v = _view(client)
    assert list(v["evidence_inputs"]) == ["permission.txt"]
    ctx = app.state.ctx
    asyncio.run(ctx.visuals.current("hcm-demo", root))
    runs = ctx.visuals.runs
    asyncio.run(ctx.visuals.current("hcm-demo", root))
    assert ctx.visuals.runs == runs
    (root / "permission.txt").write_text("permission withdrawn")
    asyncio.run(ctx.visuals.current("hcm-demo", root))
    assert ctx.visuals.runs == runs + 1


def test_evidence_is_never_read_outside_the_project_or_through_a_symlink(tmp_path):
    root = tmp_path / "p"
    root.mkdir()
    (tmp_path / "secret.txt").write_text("s")
    (root / "doc.txt").write_text("d")
    os.symlink(tmp_path / "secret.txt", root / "link.txt")
    cache = V._StatCache()
    assert V.evidence_sha(cache, root, "doc.txt") == hashlib.sha256(b"d").hexdigest()
    for ref in ("../secret.txt", "/etc/hosts", "link.txt", "https://example.org/x", "a/../doc.txt"):
        assert V.evidence_sha(cache, root, ref) is None


def test_concurrent_reads_share_one_engine_run(tmp_path):
    class Engine:
        def __init__(self):
            self.calls = 0

        async def visuals_state(self, root):
            self.calls += 1
            await asyncio.sleep(0.05)
            return {"inputs": {"a.json": None}, "evidence_inputs": {}, "revision": "r"}

    async def go():
        snaps = V.Snapshots(Engine())
        await asyncio.gather(*(snaps.current("p", tmp_path) for _ in range(5)))
        return snaps.engine.calls

    assert asyncio.run(go()) == 1


# --------------------------------------------------------------------------- import


def _upload(client, rev: str, data: bytes, *, name: str = "harbour.png", **fields):
    form = {
        "expected_revision": rev,
        "scene_id": "scene-002",
        "kind": "archival",
        "provenance": "Scanned from my own print, bought in 2019.",
        "creator": "Jane Doe",
        **fields,
    }
    return client.post(
        f"{API}/visuals/import",
        data=form,
        files={"file": (name, data, "application/octet-stream")},
    )


def test_an_imported_image_becomes_a_manual_review_candidate(client, planned, settings):
    data = png(30, 20, (10, 200, 30))
    r = _upload(client, _rev(client), data)
    assert r.status_code == 200, r.text
    res = r.json()["result"]
    assert res["rights_status"] == "manual_review" and res["scene_id"] == "scene-002"
    assert res["candidate_id"].startswith("scene-002-imp-")
    assert (_root(settings) / "visuals-import-stdin.bin").read_bytes() == data  # stdin, no path
    argv = [
        json.loads(x)["argv"]
        for x in (_root(settings) / "visuals-calls.jsonl").read_text().splitlines()
        if json.loads(x)["argv"][0] == "visuals-import"
    ][-1]
    assert "--stdin" in argv and "--title=harbour.png" in argv and "--creator=Jane Doe" in argv
    v = r.json()["visuals"]
    imp = next(c for c in v["candidates"]["scene-002"] if c["id"] == res["candidate_id"])
    assert imp["rights"]["status"] == "manual_review"
    assert _img(client, imp).status_code == 200


def test_a_stale_revision_is_refused_before_the_file_is_read(client, planned, settings):
    r = _upload(client, "0" * 64, png(30, 20, (1, 2, 3)))
    assert r.status_code == 409 and r.json()["error"]["code"] == "revision_conflict"
    assert "visuals-import" not in _calls(settings)
    assert not (_root(settings) / "visuals-import-stdin.bin").exists()


def test_import_fields_are_validated_before_the_file(client, planned, settings):
    rev = _rev(client)
    for bad in (
        {"kind": "photo"},
        {"provenance": "short"},
        {"source_url": "http://example.org/x"},
        {"scene_id": "--force"},
        {"title": "a\nb"},
        {"unknown": "x"},
    ):
        r = _upload(client, rev, png(4, 4, (0, 0, 0)), **bad)
        assert r.status_code == 422, (bad, r.text)
    assert "visuals-import" not in _calls(settings)


@pytest.mark.parametrize(
    "data",
    [b"", b"<svg xmlns='http://www.w3.org/2000/svg'/>", b"GIF89a....", b"%PDF-1.7"],
)
def test_only_still_images_are_sent_to_the_engine(client, planned, settings, data):
    r = _upload(client, _rev(client), data)
    assert r.status_code == 422, r.text
    assert "visuals-import" not in _calls(settings)


def test_webp_and_tiff_reach_the_engine(client, planned):
    for data in (b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 20, b"II*\x00" + b"\x00" * 20):
        r = _upload(client, _rev(client), data, name="x.bin")
        assert r.status_code == 200, r.text


def test_an_oversized_upload_is_refused(client, planned, settings):
    r = _upload(client, _rev(client), b"\x89PNG\r\n\x1a\n" + b"\x00" * (V.MAX_IMAGE_BYTES + 10))
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"
    assert "visuals-import" not in _calls(settings)


def test_the_file_must_be_the_last_part(client, planned, settings):
    boundary = "b0undary"
    rev = _rev(client)
    parts = [
        ("expected_revision", rev),
        ("scene_id", "scene-002"),
        ("kind", "archival"),
        ("provenance", "Scanned from my own print."),
    ]
    body = b""
    for k, val in parts:
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{val}\r\n'.encode()
        )
    body += (
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n'
            "Content-Type: image/png\r\n\r\n"
        ).encode()
        + png(4, 4, (0, 0, 0))
        + b"\r\n"
    )
    body += f'--{boundary}\r\nContent-Disposition: form-data; name="creator"\r\n\r\nX\r\n'.encode()
    body += f"--{boundary}--\r\n".encode()
    r = client.post(
        f"{API}/visuals/import",
        content=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    assert r.status_code == 422 and "last part" in r.json()["error"]["message"]
    assert "visuals-import" not in _calls(settings)


def test_import_needs_multipart(client, planned):
    r = client.post(f"{API}/visuals/import", json={"x": 1})
    assert r.status_code == 415


def test_import_holds_the_project(client, planned, fake_cli):
    p = _preview(client)
    fake_cli.env["FAKE_MODE"] = "visuals_slow"
    job_id = _acquire(client, p).json()["job_id"]
    r = _upload(client, _rev(client), png(4, 4, (0, 0, 0)))
    assert r.status_code == 409 and r.json()["error"]["code"] in (
        "job_conflict",
        "revision_conflict",
    )
    client.post(f"/api/v1/jobs/{job_id}/cancel")
    wait_for(lambda: client.get(f"/api/v1/jobs/{job_id}").json()["status"] == "cancelled")
