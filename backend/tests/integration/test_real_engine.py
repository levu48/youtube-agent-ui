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


def test_g1_approval_and_staleness_with_real_engine(real_client, settings):
    """Validate → approve via `draft-approve` → change a bound file → the engine reports stale."""
    assert real_client.post("/api/v1/projects", json=PROJECT).status_code == 201
    api = "/api/v1/projects/hcm-demo"

    early = real_client.get(f"{api}/draft").json()
    assert early["review_token"] is None  # never issued for a draft that fails the check
    # Engines with a draft revision (D-117) check it first, so use the engine's current one.
    early_token = early["draft_check"].get("revision") or "0" * 64
    refused = real_client.post(
        f"{api}/draft/approve",
        json={"reviewer": "Nguyễn Văn A", "confirm": True, "review_token": early_token},
    )
    assert refused.status_code == 422, refused.text
    assert refused.json()["error"]["code"] == "approval_refused"
    assert any("missing" in e for e in refused.json()["error"]["details"]["errors"])

    job_id = real_client.post(f"{api}/draft-jobs", json={"provider": "fixture"}).json()["job_id"]
    wait_for(
        lambda: real_client.get(f"/api/v1/jobs/{job_id}").json()["status"] == "succeeded",
        timeout=60,
    )
    draft = real_client.get(f"{api}/draft").json()
    assert draft["draft_check"]["approval_status"] == "not_approved"
    assert draft["review_token"]
    # Engine-authoritative revision when the installed engine reports one; else the UI token.
    if draft["draft_check"].get("revision"):
        assert draft["review_mode"] == "engine"
        assert draft["review_token"] == draft["draft_check"]["revision"]
    else:
        assert draft["review_mode"] == "ui"

    r = real_client.post(
        f"{api}/draft/approve",
        json={
            "reviewer": "Nguyễn Văn A",
            "comment": "Chấp nhận bản nháp",
            "confirm": True,
            "review_token": draft["review_token"],
        },
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["approved_version_matches"] is True and out["approval_confirmed"] is True
    assert out["draft_check"]["approval_status"] == "approved"
    assert out["approval"]["reviewer"] == "Nguyễn Văn A"
    draft_stage = next(s for s in out["status"]["stages"] if s["stage"] == "draft")
    assert draft_stage["status"] == "completed"

    # The CLI sees the same engine-recorded approval.
    root = settings.projects_root_real / "hcm-demo"
    cli = subprocess.run(
        ["uv", "run", "--no-sync", "ytagent", "draft-check", f"--project-root={root}", "--json"],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    )
    assert json.loads(cli.stdout)["approval_status"] == "approved"

    # A later change to a bound file makes the approval stale (engine rule), and the old
    # review token can no longer be used to approve.
    approved_record = (root / "review.json").read_bytes()
    board = root / "storyboard.draft.json"
    board.write_text(board.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    after = real_client.get(f"{api}/draft").json()
    assert after["draft_check"]["ok"] is True
    assert after["draft_check"]["approval_status"] == "stale"
    assert "storyboard.draft.json" in after["draft_check"]["approval_changed"]
    assert after["approval_confirmed"] is None and after["review_token"] != draft["review_token"]
    again = real_client.post(
        f"{api}/draft/approve",
        json={"reviewer": "Nguyễn Văn A", "confirm": True, "review_token": draft["review_token"]},
    )
    assert again.status_code == 409 and again.json()["error"]["code"] == "draft_changed"

    # Editing the outline also breaks the script's hash link: the draft now has errors, and
    # the engine itself refuses any approval (or, with a revision, the stale revision).
    outline = root / "outline.json"
    data = json.loads(outline.read_text(encoding="utf-8"))
    data["title"] += " (sửa)"
    outline.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    broken = real_client.get(f"{api}/draft").json()
    assert broken["draft_check"]["ok"] is False and broken["review_token"] is None
    assert "outline.json" in broken["draft_check"]["approval_changed"]
    refused = real_client.post(
        f"{api}/draft/approve",
        json={"reviewer": "Nguyễn Văn A", "confirm": True, "review_token": after["review_token"]},
    )
    code = refused.json()["error"]["code"]
    assert (refused.status_code, code) in {(422, "approval_refused"), (409, "draft_changed")}
    assert (root / "review.json").read_bytes() == approved_record  # nothing new was approved


def _cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["uv", "run", "--no-sync", "ytagent", *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
    )


def test_browser_edit_with_real_engine(real_client, settings):
    """M2 editing: Vietnamese outline + script edit via draft-edit, stale revision, unknown
    section, approval invalidation, regeneration protection and CLI interop."""
    api = "/api/v1/projects/hcm-demo"
    assert real_client.post("/api/v1/projects", json=PROJECT).status_code == 201
    job_id = real_client.post(f"{api}/draft-jobs", json={"provider": "fixture"}).json()["job_id"]
    wait_for(
        lambda: real_client.get(f"/api/v1/jobs/{job_id}").json()["status"] == "succeeded",
        timeout=60,
    )
    d = real_client.get(f"{api}/draft/editable").json()
    ed = d["editing"]
    if not ed["supported"]:
        assert not REQUIRED, "the pinned engine must support draft-edit (ENGINE_REF)"
        pytest.skip("engine without draft-edit (D-117)")
    assert ed["can_edit"] is True, ed
    rev = ed["revision"]

    # Approve first, so the edit must make the approval stale.
    ok = real_client.post(
        f"{api}/draft/approve",
        json={"reviewer": "Nguyễn Văn A", "confirm": True, "review_token": d["review_token"]},
    )
    assert ok.status_code == 200, ok.text
    rev = real_client.get(f"{api}/draft/editable").json()["editing"]["revision"]

    sec = d["script"]["data"]["sections"][1]["outline_section_id"]
    narration = "Năm 1911, người thanh niên rời bến Nhà Rồng.\n\nÔng đi qua nhiều nước."
    r = real_client.post(
        f"{api}/draft/edit",
        json={
            "expected_revision": rev,
            "outline": {
                "title": "Hành trình (bản sửa)",
                "sections": [{"id": sec, "purpose": "Mục đích mới."}],
            },
            "script": {"sections": [{"outline_section_id": sec, "narration": narration}]},
        },
    )
    assert r.status_code == 200, r.text
    res, draft = r.json()["result"], r.json()["draft"]
    assert res["status"] == "published" and res["previous_revision"] == rev
    assert {"outline.json", "script.json", "script.md"} <= set(res["changed_files"])
    assert set(res["human_edited"]) == {"outline.json", "script.json"}
    assert sec in res["storyboard"]["resplit_sections"]
    assert draft["editing"]["revision"] == res["revision"]
    assert draft["draft_check"]["ok"] is True
    assert draft["draft_check"]["approval_status"] == "stale"
    s = next(x for x in draft["script"]["data"]["sections"] if x["outline_section_id"] == sec)
    assert s["narration"] == narration  # NFC Vietnamese round trip
    assert "Năm 1911" in draft["script"]["markdown"]
    assert draft["outline"]["data"]["title"] == "Hành trình (bản sửa)"

    # The CLI sees the same draft and revision.
    root = settings.projects_root_real / "hcm-demo"
    cli = _cli("draft-check", f"--project-root={root}", "--json")
    report = json.loads(cli.stdout)
    assert report["revision"] == res["revision"] and report["approval_status"] == "stale"

    # The old revision is refused; nothing is written.
    before = (root / "outline.json").read_bytes()
    stale = real_client.post(
        f"{api}/draft/edit", json={"expected_revision": rev, "outline": {"title": "Khác"}}
    )
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "revision_conflict"
    assert stale.json()["error"]["details"]["current_revision"] == res["revision"]
    assert (root / "outline.json").read_bytes() == before

    # Unknown section: rejected by the engine with a location.
    bad = real_client.post(
        f"{api}/draft/edit",
        json={
            "expected_revision": res["revision"],
            "outline": {"sections": [{"id": "sec-99", "heading": "X"}]},
        },
    )
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_edit"
    assert bad.json()["error"]["details"]["errors"][0]["loc"] == "outline.sections.0.id"

    # Dry run: validated, nothing written.
    dry = real_client.post(
        f"{api}/draft/edit",
        json={"expected_revision": res["revision"], "dry_run": True, "outline": {"title": "Thử"}},
    )
    assert dry.status_code == 200 and dry.json()["result"]["status"] == "would_publish"
    assert (root / "outline.json").read_bytes() == before

    # Regeneration protection: a draft job refuses to overwrite the human edits.
    job_id = real_client.post(f"{api}/draft-jobs", json={"provider": "fixture"}).json()["job_id"]
    job = wait_for(
        lambda: (
            (j := real_client.get(f"/api/v1/jobs/{job_id}").json())["status"]
            in ("succeeded", "failed")
            and j
        ),
        timeout=60,
    )
    assert job["status"] == "failed" and job["exit_code"] == 2, job
    assert (root / "outline.json").read_bytes() == before

    # Re-approve the edited version through the engine revision.
    again = real_client.get(f"{api}/draft/editable").json()
    ok = real_client.post(
        f"{api}/draft/approve",
        json={"reviewer": "Nguyễn Văn A", "confirm": True, "review_token": again["review_token"]},
    )
    assert ok.status_code == 200 and ok.json()["draft_check"]["approval_status"] == "approved"

    # Downstream work blocks in-place editing.
    (root / "research-plan.json").write_text("{}", encoding="utf-8")
    ed = real_client.get(f"{api}/draft/editable").json()["editing"]
    assert ed["can_edit"] is False and ed["reason_code"] == "downstream_artifacts"
    assert ed["paths"] == ["research-plan.json"]


def test_research_workspace_with_real_engine(settings):
    """M3 UI-A on the real engine (D-118, fixture search provider, offline): plan, fetch-plan
    preview, a confirmed collection, a queued URL, verified snapshot text, and the same
    revision from the CLI."""
    settings.research_search_provider = "fixture"
    api = "/api/v1/projects/hcm-demo"
    with Client(create_app(settings)) as c:
        assert c.post("/api/v1/projects", json=PROJECT).status_code == 201
        job_id = c.post(f"{api}/draft-jobs", json={"provider": "fixture"}).json()["job_id"]
        wait_for(
            lambda: c.get(f"/api/v1/jobs/{job_id}").json()["status"] == "succeeded", timeout=60
        )
        draft = c.get(f"{api}/draft").json()
        r = c.post(
            f"{api}/draft/approve",
            json={
                "reviewer": "Nguyễn Văn A",
                "confirm": True,
                "review_token": draft["review_token"],
            },
        )
        assert r.status_code == 200, r.text

        def job(resp) -> dict:
            assert resp.status_code == 202, resp.text
            jid = resp.json()["job_id"]
            return wait_for(
                lambda: (
                    (j := c.get(f"/api/v1/jobs/{jid}").json())["status"] in ("succeeded", "failed")
                    and j
                ),
                timeout=90,
            )

        view = c.get(f"{api}/research").json()
        assert view["started"] is False and len(view["revision"]) == 64, view
        done = job(c.post(f"{api}/research/plan", json={"expected_revision": view["revision"]}))
        assert done["status"] == "succeeded", done
        view = c.get(f"{api}/research").json()
        assert view["started"] and view["report"]["claims"]

        rev = view["revision"]
        preview = c.post(f"{api}/research/collect/preview", json={"expected_revision": rev}).json()
        assert preview["search_hosts"] == ["search.fixture.invalid"], preview
        assert preview["hosts"] and preview["revision"] == rev
        done = job(
            c.post(
                f"{api}/research/collect",
                json={
                    "expected_revision": rev,
                    "network": True,
                    "plan_sha256": preview["plan_sha256"],
                    "allow_hosts": preview["hosts"],
                },
            )
        )
        assert done["status"] == "succeeded", done
        logs = " ".join(e["data"].get("message", "") for e in done["events"] if e["type"] == "log")
        assert "search vi" in logs  # engine progress lines reach the job log
        # The placeholder claims match no fixture page, so fetch one the reviewer chose,
        # confined to its own host (the fixture web stands in for the network).
        url = "https://archive.fixture.invalid/tuyen-ngon-1945"
        done = job(
            c.post(
                f"{api}/research/sources",
                json={
                    "expected_revision": c.get(f"{api}/research").json()["revision"],
                    "url": url,
                    "fetch": "live",
                    "network": True,
                    "allow_hosts": ["archive.fixture.invalid"],
                },
            )
        )
        assert done["status"] == "succeeded", done
        view = c.get(f"{api}/research").json()
        assert view["snapshots"] and {s["acquisition"] for s in view["snapshots"]} == {"fixture"}
        page = c.get(f"{api}/research/snapshots/{view['snapshots'][0]['id']}").json()
        assert page["text"]

        done = job(
            c.post(
                f"{api}/research/sources",
                json={
                    "expected_revision": view["revision"],
                    "url": "https://vi.wikipedia.org/wiki/Ba_Đình",
                },
            )
        )
        assert done["status"] == "succeeded", done
        view = c.get(f"{api}/research").json()
        assert any(s["user_supplied"] and s["state"] == "discovered" for s in view["sources"])
        preview = c.post(
            f"{api}/research/collect/preview", json={"expected_revision": view["revision"]}
        ).json()
        assert "vi.wikipedia.org" in preview["hosts"]  # a queued URL is a fetch target too

        stale = c.post(f"{api}/research/collect/preview", json={"expected_revision": rev})
        assert stale.status_code == 409 and stale.json()["error"]["code"] == "revision_conflict"

        # The CLI sees the same research state and revision.
        root = settings.projects_root_real / "hcm-demo"
        out = subprocess.run(
            [
                "uv",
                "run",
                "--no-sync",
                "ytagent",
                "research-check",
                f"--project-root={root}",
                "--json",
            ],
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        assert out.returncode == 14, out.stderr
        assert json.loads(out.stdout)["revision"] == view["revision"]
