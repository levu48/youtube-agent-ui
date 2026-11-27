"""Integration tests against the real youtube-agent CLI using the offline fixture provider.

No Ollama, network or paid services. Skipped (with a reason) if the engine checkout or its
virtualenv is not available. Set YTA_TEST_ENGINE_REPO to point elsewhere.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

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


def test_research_review_with_real_engine(settings):
    """M3 UI-B on the real engine (D-119/D-120, offline): narration lineage (fixture segments
    with their text, a refused and an accepted attestation), an imported document, evidence
    after a dry run, a decision that goes outdated and is confirmed again, history,
    completeness, a primary attestation, and the same revision from the CLI."""
    api = "/api/v1/projects/hcm-demo"
    with Client(create_app(settings)) as c:
        assert c.post("/api/v1/projects", json=PROJECT).status_code == 201
        job_id = c.post(f"{api}/draft-jobs", json={"provider": "fixture"}).json()["job_id"]
        wait_for(
            lambda: c.get(f"/api/v1/jobs/{job_id}").json()["status"] == "succeeded", timeout=60
        )

        # Lineage: every fixture sentence is listed with its text (matched by SHA-256).
        nar = c.get(f"{api}/draft/narration").json()
        segs = nar["lineage"]["segments"]
        assert nar["lineage"]["fixture_project"] is True and segs, nar
        assert {s["origin"] for s in segs} == {"fixture"} and all(s["text"] for s in segs)
        assert any(i["code"] == "fixture_narration" for i in nar["items"])
        r = c.post(
            f"{api}/draft/narration/attest",
            json={
                "expected_revision": nar["revision"],
                "reviewer": "Trần Thị B",
                "statement": "Tôi đã viết lại câu này bằng lời của chính tôi.",
                "segment_ids": [segs[0]["segment_id"]],
            },
        )
        assert r.status_code == 422 and r.json()["error"]["code"] == "lineage_refused", r.text

        # Rewrite one section's narration; the new sentences are fixture_derived until attested.
        d = c.get(f"{api}/draft/editable").json()
        sec = d["script"]["data"]["sections"][0]["outline_section_id"]
        rewritten = "Mùa thu năm ấy, quảng trường rợp cờ hoa khi buổi lễ bắt đầu."
        r = c.post(
            f"{api}/draft/edit",
            json={
                "expected_revision": d["editing"]["revision"],
                "script": {"sections": [{"outline_section_id": sec, "narration": rewritten}]},
            },
        )
        assert r.status_code == 200, r.text
        nar = c.get(f"{api}/draft/narration").json()
        derived = [s for s in nar["lineage"]["segments"] if s["origin"] == "fixture_derived"]
        assert [s["text"] for s in derived] == [rewritten], nar["lineage"]["segments"]
        out = c.post(
            f"{api}/draft/narration/attest",
            json={
                "expected_revision": nar["revision"],
                "reviewer": "Trần Thị B",
                "statement": "Tôi viết lại toàn bộ câu mở đầu của phần này.",
                "segment_ids": [derived[0]["segment_id"]],
            },
        )
        assert out.status_code == 200, out.text
        assert out.json()["result"]["status"] == "attested"
        seg = next(
            s
            for s in out.json()["narration"]["lineage"]["segments"]
            if s["segment_id"] == derived[0]["segment_id"]
        )
        assert seg["origin"] == "human"

        # G1, then the claim inventory.
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
        rev = c.get(f"{api}/research").json()["revision"]
        jid = c.post(f"{api}/research/plan", json={"expected_revision": rev}).json()["job_id"]
        wait_for(lambda: c.get(f"/api/v1/jobs/{jid}").json()["status"] == "succeeded", timeout=90)
        view = c.get(f"{api}/research").json()
        assert view["editing"]["supported"] and view["plan"]["claims"], view["editing"]
        claim = view["plan"]["claims"][0]
        cid = claim["id"]
        assert claim["anchors"][0]["context"]["excerpt"] == claim["anchors"][0]["excerpt"]

        # An imported document (offline), then evidence located by a dry run.
        text = (
            "Ngày 2 tháng 9 năm 1945, tại Quảng trường Ba Đình ở Hà Nội, Chủ tịch Hồ Chí Minh "
            "đọc bản Tuyên ngôn Độc lập, khai sinh nước Việt Nam Dân chủ Cộng hòa."
        )
        r = c.post(
            f"{api}/research/documents",
            json={
                "expected_revision": view["revision"],
                "title": "Tuyên ngôn Độc lập (trích)",
                "language": "vi",
                "citation": "Hồ Chí Minh, Toàn tập, tập 4, NXB Chính trị quốc gia, 2011, tr. 1",
                "imported_by": "Trần Thị B",
                "text": text,
            },
        )
        assert r.status_code == 200, r.text
        doc = r.json()["result"]
        snap = next(s for s in r.json()["research"]["snapshots"] if s["id"] == doc["snapshot_id"])
        assert snap["acquisition"] == "imported" and snap["document_provenance"]["imported_by"]

        def edit(*ops, dry_run=False):
            body = {
                "expected_revision": c.get(f"{api}/research").json()["revision"],
                "operations": list(ops),
                "dry_run": dry_run,
            }
            return c.post(f"{api}/research/edit", json=body)

        link = {
            "op": "evidence.add",
            "claim_id": cid,
            "snapshot_id": doc["snapshot_id"],
            "quote": "Quảng trường Ba Đình",
            "role": "supports",
            "explanation": "Văn bản nêu địa điểm của sự kiện.",
        }
        dry = edit(link, dry_run=True)
        assert dry.status_code == 200, dry.text
        assert dry.json()["result"]["status"] == "would_publish"
        assert dry.json()["result"]["occurrences"][0]["occurrences"][0]["n"] == 1
        r = edit(link)
        assert r.status_code == 200, r.text
        ev = next(x for x in r.json()["research"]["evidence"] if x["claim_id"] == cid)
        assert ev["id"].startswith("ev-") and ev["quote"] == "Quảng trường Ba Đình"

        # A decision; a changed claim makes it outdated; confirming again records history.
        decide = {
            "op": "reviews.set",
            "claim_id": cid,
            "status": "insufficient",
            "reviewer": "Trần Thị B",
            "rationale": "Chỉ có một nguồn được nhập, chưa đủ để xác minh.",
        }
        r = edit(decide)
        assert r.status_code == 200, r.text
        claims = {x["id"]: x for x in r.json()["research"]["report"]["claims"]}
        assert claims[cid]["status"] == "insufficient"
        r = edit({"op": "claims.update", "id": cid, "flags": [*claim["flags"], "named_subject"]})
        assert r.status_code == 200, r.text
        claims = {x["id"]: x for x in r.json()["research"]["report"]["claims"]}
        assert "claim" in claims[cid]["review_outdated"] and claims[cid]["status"] == "unverified"
        assert edit(decide).status_code == 200
        page = c.get(f"{api}/research/history", params={"kind": "claim_review"}).json()
        assert page["chain_ok"] is True and page["entries"][0]["action"] == "replaced", page

        # Refusals carry the engine's operation code.
        r = edit({**decide, "reviewer": "reviewer"})
        assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_edit", r.text
        assert r.json()["error"]["details"]["errors"][0]["code"] == "invalid_reviewer"

        # Completeness and a primary attestation.
        r = edit(
            {
                "op": "completeness.set",
                "reviewer": "Trần Thị B",
                "statement": "Mọi câu có nội dung sự kiện đều đã có claim tương ứng.",
            }
        )
        assert r.status_code == 200, r.text
        assert r.json()["research"]["review"]["completeness"]["reviewer"] == "Trần Thị B"
        r = edit(
            {
                "op": "documents.attest_primary",
                "snapshot_id": doc["snapshot_id"],
                "reviewer": "Trần Thị B",
                "statement": "Đây là bản in của văn kiện gốc.",
            }
        )
        assert r.status_code == 200, r.text
        assert r.json()["research"]["review"]["primary_source_attestations"]

        # The CLI sees the same research revision.
        root = settings.projects_root_real / "hcm-demo"
        cli = _cli("research-check", f"--project-root={root}", "--json")
        assert json.loads(cli.stdout)["revision"] == c.get(f"{api}/research").json()["revision"]


FIXTURES = Path(__file__).parent.parent / "fixtures" / "research"  # see SOURCE.md there
# Shared with the E2E test: human-written narration whose every claim a document supports.
G2 = json.loads((FIXTURES / "g2-journey.json").read_text("utf-8"))


def g2_operations(claims: list[dict], snapshots: dict[str, str]) -> tuple[list, list]:
    """The journey's research edits for these claims: (evidence and primary attestations,
    decisions and completeness). Claims are matched by the start of their assertion."""

    def ids(prefix: str) -> list[str]:
        return [x["id"] for x in claims if x["assertion"].startswith(prefix)]

    vi, en = snapshots["vi"], snapshots["en"]
    q = G2["quotation"]
    evidence = [
        {"op": "evidence.add", "claim_id": cid, "snapshot_id": vi, "quote": e["quote"],
         "role": "supports", "explanation": e["explanation"], "source_type": "primary"}
        for e in G2["evidence"]
        for cid in ids(e["claim_prefix"])
    ]  # fmt: skip
    trace = {"snapshot_id": en, "quote": q["original_quote"], "language": "en",
             "speaker": q["speaker"], "equivalence_note": q["equivalence_note"]}  # fmt: skip
    for cid in (c for p in q["claim_prefixes"] for c in ids(p)):
        evidence += [
            {"op": "evidence.add", "claim_id": cid, "snapshot_id": en, "quote": q["original"],
             "role": "supports", "source_type": "primary",
             "explanation": q["original_explanation"]},
            {"op": "evidence.add", "claim_id": cid, "snapshot_id": vi, "quote": q["translated"],
             "role": "supports", "source_type": "primary", "is_translation": True,
             "translation_of": trace, "original_language": "en",
             "explanation": q["translated_explanation"]},
        ]  # fmt: skip
    evidence += [
        {"op": "documents.attest_primary", "snapshot_id": snapshots[k], "reviewer": G2["reviewer"],
         "statement": d["primary_statement"]}
        for k, d in G2["documents"].items()
    ]  # fmt: skip
    decisions = [
        {"op": "reviews.set", "claim_id": x["id"], "status": "verified", "reviewer": G2["reviewer"],
         "rationale": G2["rationale"]}
        for x in claims
    ]  # fmt: skip
    decisions.append(
        {"op": "completeness.set", "reviewer": G2["reviewer"], "statement": G2["completeness"]}
    )
    return evidence, decisions


def test_g2_success_with_a_genuinely_sourced_document(settings):
    """M3 UI-C, the required G2 success (offline, no fixture evidence): a fixture draft whose
    narration is rewritten and attested, G1, the claim inventory, two public-domain documents
    (tests/fixtures/research/SOURCE.md) with primary attestations, evidence including a
    translated quotation traced to its original, decisions, completeness, then G2, apply, G1
    again and export, all through the UI's API. The CLI then reports G2 approved and applied."""
    project = G2["project"]
    api = f"/api/v1/projects/{project['slug']}"
    texts = {k: (FIXTURES / d["file"]).read_text("utf-8") for k, d in G2["documents"].items()}
    for e in G2["evidence"]:
        assert texts["vi"].count(e["quote"]) == 1, e["quote"]
    assert texts["vi"].count(G2["quotation"]["translated"]) == 1
    assert texts["en"].count(G2["quotation"]["original"]) == 1
    with Client(create_app(settings)) as c:

        def ok(resp) -> dict:
            assert resp.status_code == 200, resp.text
            return resp.json()

        def rev() -> str:
            return c.get(f"{api}/research").json()["revision"]

        def g1() -> None:
            token = c.get(f"{api}/draft").json()["review_token"]
            body = {"reviewer": G2["approver"], "confirm": True, "review_token": token}
            ok(c.post(f"{api}/draft/approve", json=body))

        def edit(ops) -> dict:
            body = {"expected_revision": rev(), "operations": ops}
            return ok(c.post(f"{api}/research/edit", json=body))

        assert c.post("/api/v1/projects", json=project).status_code == 201
        job_id = c.post(f"{api}/draft-jobs", json={"provider": "fixture"}).json()["job_id"]
        wait_for(
            lambda: c.get(f"/api/v1/jobs/{job_id}").json()["status"] == "succeeded", timeout=60
        )

        # Rewrite every scene's narration in our own words, then attest the rewrites.
        d = c.get(f"{api}/draft/editable").json()
        sections = [s["outline_section_id"] for s in d["script"]["data"]["sections"]]
        assert sections == list(G2["narration"]), sections
        script = {"sections": [{"outline_section_id": k, "narration": v}
                               for k, v in G2["narration"].items()]}  # fmt: skip
        body = {"expected_revision": d["editing"]["revision"], "script": script}
        ok(c.post(f"{api}/draft/edit", json=body))
        nar = c.get(f"{api}/draft/narration").json()
        segs = [s["segment_id"] for s in nar["lineage"]["segments"]]
        assert {s["origin"] for s in nar["lineage"]["segments"]} == {"fixture_derived"}
        body = {"expected_revision": nar["revision"], "reviewer": G2["reviewer"],
                "statement": G2["attestation"], "segment_ids": segs}  # fmt: skip
        out = ok(c.post(f"{api}/draft/narration/attest", json=body))
        assert out["result"]["remaining"] == 0, out["result"]

        # G1, then the claim inventory.
        g1()
        jid = c.post(f"{api}/research/plan", json={"expected_revision": rev()}).json()["job_id"]
        wait_for(lambda: c.get(f"/api/v1/jobs/{jid}").json()["status"] == "succeeded", timeout=90)

        # The two documents, imported offline with their provenance.
        snapshots = {}
        for k, meta in G2["documents"].items():
            fields = {f: v for f, v in meta.items() if f not in ("file", "primary_statement")}
            body = {"expected_revision": rev(), "imported_by": G2["reviewer"], "text": texts[k],
                    **fields}  # fmt: skip
            out = ok(c.post(f"{api}/research/documents", json=body))
            snapshots[k] = out["result"]["snapshot_id"]

        claims = c.get(f"{api}/research").json()["report"]["claims"]
        assert len(claims) == 8, [x["assertion"] for x in claims]
        evidence, decisions = g2_operations(claims, snapshots)
        view = edit(evidence)["research"]
        before_decisions = view["revision"]
        traced = [x for x in view["evidence"] if x.get("is_translation")]
        assert len(traced) == 2
        assert all(x["translation_of"]["snapshot_id"] == snapshots["en"] for x in traced)
        view = edit(decisions)["research"]
        report = view["report"]
        assert report["approvable"] is True, report["items"]
        assert not [i for i in report["items"] if i["blocking"]]
        assert view["gates"] == {"g1": "approved", "g2": "needs_review"}

        # G2 with the revision the reviewer validated, apply, G1 again, export. An earlier
        # revision is refused and records nothing.
        body = {"expected_revision": before_decisions, "reviewer": G2["approver"], "confirm": True}
        stale = c.post(f"{api}/research/approve", json=body)
        assert stale.status_code == 409, stale.text
        assert stale.json()["error"]["code"] == "revision_conflict"
        assert c.get(f"{api}/research").json()["report"]["approval_status"] == "not_approved"
        body = {**body, "expected_revision": view["revision"],
                "comment": "Đã đối chiếu từng câu với văn bản."}  # fmt: skip
        out = ok(c.post(f"{api}/research/approve", json=body))
        assert out["result"]["status"] == "approved"
        assert out["research"]["gates"]["g2"] == "approved_not_applied"
        body = {"expected_revision": out["research"]["revision"], "confirm": True}
        out = ok(c.post(f"{api}/research/apply", json=body))
        assert out["result"]["status"] == "published"
        assert out["result"]["scenes_changed"] == [f"scene-00{n}" for n in range(1, 5)]
        assert out["research"]["gates"] == {"g1": "stale_after_apply", "g2": "approved"}
        g1()
        out = ok(c.post(f"{api}/research/export", json={"expected_revision": rev()}))
        assert sorted(out["result"]["written"]) == [
            "output/sources.md",
            "render/research/citation-plan.json",
            "render/research/research-report.json",
            "render/research/research-report.md",
        ]
        assert out["research"]["gates"] == {"g1": "approved", "g2": "approved"}

        # The CLI reports the same: G2 approved and applied, G1 approved.
        root = settings.projects_root_real / project["slug"]
        check = json.loads(_cli("research-check", f"--project-root={root}", "--json").stdout)
        assert check["approval_status"] == "approved" and check["applied"] is True
        assert check["revision"] == rev()
        status = json.loads(_cli("production-status", f"--project-root={root}", "--json").stdout)
        details = {s["stage"]: s["detail"] for s in status["stages"]}
        assert details["draft"] == "G1 editorial: approved"
        assert details["research"] == "G2 research: approved"
        sources = (root / "output/sources.md").read_text("utf-8")
        assert f"Research approval: approved, by {G2['approver']}" in sources

        # A hand-edited export is never overwritten from the UI.
        (root / "output/sources.md").write_text(sources + "\nGhi chú tay.\n", "utf-8")
        r = c.post(f"{api}/research/export", json={"expected_revision": rev()})
        assert r.status_code == 409 and r.json()["error"]["code"] == "human_edit_conflict", r.text
        assert r.json()["error"]["details"]["paths"] == ["output/sources.md"]
        assert (root / "output/sources.md").read_text("utf-8").endswith("Ghi chú tay.\n")


def test_visuals_workspace_with_real_engine(settings):
    """M4 UI-A on the real engine (D-122, fixture search provider, offline): the read-only
    snapshot, the plan job, the engine's acquisition preview, a confirmed search bound to it,
    verified candidate images, an import through stdin, the backend's recovery refusal from
    the engine's own ``recovery_required``, and the same revision from the CLI."""
    from tests.fake_visuals import png

    settings.visuals_search_provider = "fixture"
    api = "/api/v1/projects/hcm-demo"
    root = settings.projects_root_real / "hcm-demo"
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
                timeout=120,
            )

        view = c.get(f"{api}/visuals").json()
        assert view["scheme"] == "m4-visuals-state-1" and view["plan"] is None, view
        assert view["gates"]["g1"]["status"] == "approved"
        assert view["recovery_required"] is False and view["narration"]
        done = job(c.post(f"{api}/visuals/plan", json={"expected_revision": view["revision"]}))
        assert done["status"] == "succeeded", done
        view = c.get(f"{api}/visuals").json()
        assert view["plan"]["scenes"] and view["gates"]["g3"]["status"] == "needs_review"

        rev = view["revision"]
        p = c.post(f"{api}/visuals/acquire/preview", json={"expected_revision": rev}).json()
        assert p["preview"]["hosts"] == ["commons.fixture.invalid", "upload.fixture.invalid"], p
        assert p["preview"]["revision"] == rev and p["preview"]["image_provider"] == "none"
        wrong = c.post(
            f"{api}/visuals/acquire",
            json={"expected_revision": rev, "network": True, "preview_sha256": "0" * 64,
                  "allow_hosts": p["preview"]["hosts"]},
        )  # fmt: skip
        assert wrong.status_code == 409 and wrong.json()["error"]["code"] == "preview_mismatch"
        done = job(
            c.post(
                f"{api}/visuals/acquire",
                json={"expected_revision": rev, "network": True,
                      "preview_sha256": p["preview_sha256"], "allow_hosts": p["preview"]["hosts"]},
            )
        )  # fmt: skip
        assert done["status"] == "succeeded", done
        view = c.get(f"{api}/visuals").json()
        assert view["catalog_trusted"] is True
        cands = [x for items in view["candidates"].values() for x in items]
        assert cands and all(x["placeholder"] for x in cands if x["source_type"] == "commons")
        cand = next(x for x in cands if x.get("local_path"))
        img = c.get(f"{api}/visuals/candidates/{cand['id']}/image?sha256={cand['sha256']}")
        assert img.status_code == 200, img.text
        assert img.headers["content-type"] in ("image/jpeg", "image/png")
        assert img.headers["cache-control"] == "private, max-age=31536000, immutable"
        old = c.get(f"{api}/visuals/candidates/{cand['id']}/image?sha256={'0' * 64}")
        assert old.status_code == 409 and old.json()["error"]["code"] == "image_changed"
        stale = c.post(f"{api}/visuals/acquire/preview", json={"expected_revision": rev})
        assert stale.status_code == 409 and stale.json()["error"]["code"] == "revision_conflict"

        # Import through stdin: the engine re-encodes it and records a manual_review candidate.
        r = c.post(
            f"{api}/visuals/import",
            data={"expected_revision": view["revision"], "scene_id": "scene-005",
                  "kind": "chart", "provenance": "A chart I drew myself for this project.",
                  "creator": "Nguyễn Văn A"},
            files={"file": ("chart.png", png(640, 360, (30, 90, 160)), "image/png")},
        )  # fmt: skip
        assert r.status_code == 200, r.text
        res = r.json()["result"]
        assert res["rights_status"] == "manual_review" and res["scene_id"] == "scene-005"
        imp = next(
            x
            for x in r.json()["visuals"]["candidates"]["scene-005"]
            if x["id"] == res["candidate_id"]
        )
        served = c.get(f"{api}/visuals/candidates/{imp['id']}/image?sha256={imp['sha256']}")
        assert served.status_code == 200, served.text
        bad = c.post(
            f"{api}/visuals/import",
            data={"expected_revision": r.json()["visuals"]["revision"], "scene_id": "scene-005",
                  "kind": "chart", "provenance": "A chart I drew myself for this project."},
            files={"file": ("x.png", b"\x89PNG\r\n\x1a\nnot really", "image/png")},
        )  # fmt: skip
        assert bad.status_code == 422 and bad.json()["error"]["code"] == "visuals_refused", bad.text

        # The CLI sees the same visuals state and revision.
        out = _cli("visuals-state", f"--project-root={root}", "--json")
        assert out.returncode == 0, out.stderr
        view = c.get(f"{api}/visuals").json()
        assert json.loads(out.stdout)["revision"] == view["revision"]

        # An interrupted draft/visuals publication (as a crash leaves it): the engine reports
        # recovery_required and the backend refuses every write before any engine command.
        man = root / "render/llm/manifest.json"
        doc = json.loads(man.read_text("utf-8"))
        doc["pending"] = {"run_id": "crash-test", "state": "prepared", "files": {}}
        man.write_text(json.dumps(doc), "utf-8")
        view = c.get(f"{api}/visuals").json()
        assert view["recovery_required"] is True
        assert view["pending_journals"][0]["code"] == "recovery_required"
        r = c.post(f"{api}/visuals/acquire/preview", json={"expected_revision": view["revision"]})
        assert r.status_code == 409 and r.json()["error"]["code"] == "recovery_required"
        assert r.json()["error"]["details"]["checked_by"] == "backend"


# --------------------------------------------------------------------------- M4 UI-B: G3

VISUALS = Path(__file__).resolve().parent.parent / "fixtures" / "visuals"
PD = "https://creativecommons.org/publicdomain/mark/1.0/"
IMAGES = {  # by the kind each scene needs (the destination policy)
    "archival": ("earth-apollo17.jpg", "NASA / Apollo 17 crew",
                 "https://commons.wikimedia.org/wiki/File:The_Earth_seen_from_Apollo_17.jpg"),
    "document": ("us-constitution-page1.jpg", "Constitutional Convention",
                 "https://commons.wikimedia.org/wiki/File:Constitution_of_the_United_States_-_DPLA_-_"
                 "9ca804144bd5965e992ae3528bc3c6a3_(page_1).jpg"),
    "chart": ("global-temperature-anomaly.png", "NASA Goddard Institute for Space Studies",
              "https://commons.wikimedia.org/wiki/File:Global_Temperature_Anomaly.svg"),
}  # fmt: skip


def test_g3_success_with_genuinely_licensed_images(settings):
    """M4 UI-B on the real engine, offline: public-domain Commons images imported through
    stdin with full provenance, cleared with ``visuals-edit`` (bound to their bytes, in the
    clearance history), selected, validated and applied at the validated revision, then G1
    again. The CLI reports G3 ready, and release lists no visuals or image blockers."""
    from app.visuals_schemas import CLEARANCE_ACKNOWLEDGEMENT

    settings.visuals_search_provider = "fixture"
    api = "/api/v1/projects/hcm-demo"
    root = settings.projects_root_real / "hcm-demo"
    with Client(create_app(settings)) as c:
        assert c.post("/api/v1/projects", json=PROJECT).status_code == 201
        job_id = c.post(f"{api}/draft-jobs", json={"provider": "fixture"}).json()["job_id"]
        wait_for(
            lambda: c.get(f"/api/v1/jobs/{job_id}").json()["status"] == "succeeded", timeout=60
        )

        def approve() -> None:
            draft = c.get(f"{api}/draft").json()
            r = c.post(
                f"{api}/draft/approve",
                json={"reviewer": "Nguyễn Văn A", "confirm": True,
                      "review_token": draft["review_token"]},
            )  # fmt: skip
            assert r.status_code == 200, r.text

        def view() -> dict:
            r = c.get(f"{api}/visuals")
            assert r.status_code == 200, r.text
            return r.json()

        def edit(*ops: dict) -> dict:
            body = {"expected_revision": view()["revision"], "operations": list(ops)}
            r = c.post(f"{api}/visuals/edit", json=body)
            assert r.status_code == 200, r.text
            return r.json()

        approve()
        jid = c.post(f"{api}/visuals/plan", json={"expected_revision": view()["revision"]})
        jid = jid.json()["job_id"]
        wait_for(lambda: c.get(f"/api/v1/jobs/{jid}").json()["status"] == "succeeded", timeout=120)
        v = view()
        assert v["editing"]["supported"] is True
        assert v["editing"]["acknowledgement"] == CLEARANCE_ACKNOWLEDGEMENT
        kinds = {s["scene_id"]: s["desired_kind"] for s in v["plan"]["scenes"]}

        # 1. Import a genuinely public-domain image for every scene, with full provenance.
        picks: dict[str, dict] = {}
        for sid, want in kinds.items():
            kind = want if want in ("document", "chart") else "archival"
            name, creator, page = IMAGES[kind]
            r = c.post(
                f"{api}/visuals/import",
                data={"expected_revision": view()["revision"], "scene_id": sid, "kind": kind,
                      "provenance": f"Public-domain file from Wikimedia Commons: {page}",
                      "title": name, "source_url": page, "creator": creator,
                      "license_name": "Public domain", "license_url": PD,
                      "attribution": f"{creator}, public domain, via Wikimedia Commons"},
                files={"file": (name, (VISUALS / name).read_bytes(), "application/octet-stream")},
            )  # fmt: skip
            assert r.status_code == 200, r.text
            cid = r.json()["result"]["candidate_id"]
            picks[sid] = next(x for x in r.json()["visuals"]["candidates"][sid] if x["id"] == cid)
            assert picks[sid]["rights"]["status"] == "manual_review"

        # 2. Clear each import's rights, bound to the bytes and evidence seen; 3. select it.
        ops = [
            {"op": "clearance.set", "candidate_id": x["id"],
             "expected_candidate_sha256": x["sha256"],
             "expected_rights_fingerprint": x["rights_fingerprint"],
             "reviewer": "Nguyễn Văn A", "basis": "public_domain_confirmed",
             "justification": "The Commons file page and its source both mark this exact image "
             "as a public-domain work.",
             "evidence": x["source_page_url"], "acknowledgement": CLEARANCE_ACKNOWLEDGEMENT}
            for x in picks.values()
        ]  # fmt: skip
        ops += [{"op": "shots.set", "scene_id": sid, "shots": [{"candidate_id": x["id"]}]}
                for sid, x in picks.items()]  # fmt: skip
        out = edit(*ops)
        assert out["result"]["status"] == "published"
        assert [h["action"] for h in out["result"]["history"]] == ["set"] * len(picks)
        v = out["visuals"]
        assert len(v["clearance_history"]["entries"]) == len(picks)
        assert {s["apply_state"] for s in v["scenes"]} == {"selected_not_applied"}
        assert "visuals_not_applied" in {f["code"] for f in v["gates"]["g3"]["findings"]}

        # 4. Validate, then apply at the validated revision (G1 goes out of date).
        validated = view()
        assert validated["report"]["render_ready"] is True, validated["report"]["errors"]
        assert validated["report"]["unpublishable"] == []
        r = c.post(f"{api}/visuals/apply",
                   json={"expected_revision": validated["revision"], "reviewer": "Nguyễn Văn A",
                         "confirm": True})  # fmt: skip
        assert r.status_code == 200, r.text
        assert r.json()["result"]["status"] == "published"
        assert r.json()["result"]["rights_unverified"] == []
        v = r.json()["visuals"]
        assert {s["apply_state"] for s in v["scenes"]} == {"applied_current"}
        assert v["gates"]["g1"]["status"] == "stale_after_apply"
        assert all(a["rights_current"] and a["problem"] is None for a in v["assets"])
        stale = c.post(f"{api}/visuals/apply",
                       json={"expected_revision": validated["revision"],
                             "reviewer": "Nguyễn Văn A", "confirm": True})  # fmt: skip
        assert stale.status_code == 409 and stale.json()["error"]["code"] == "revision_conflict"

        # 5. G1 again: the engine reports G3 ready and G1 approved.
        approve()
        v = view()
        assert v["gates"]["g1"]["status"] == "approved"
        assert v["gates"]["g3"] == {"status": "ready", "findings": []}, v["gates"]["g3"]
        status = json.loads(_cli("production-status", f"--project-root={root}", "--json").stdout)
        details = {s["stage"]: s["detail"] for s in status["stages"]}
        assert details["draft"] == "G1 editorial: approved"
        assert details["visuals"] == "G3 visuals: ready"

        # An applied image is served at its hash; an outdated hash is image_changed.
        a = v["assets"][0]
        img = c.get(f"{api}/visuals/assets/{a['asset_id']}/image?sha256={a['sha256']}")
        assert img.status_code == 200 and img.headers["etag"] == f'"{a["sha256"]}"', img.text
        old = c.get(f"{api}/visuals/assets/{a['asset_id']}/image?sha256={'0' * 64}")
        assert old.status_code == 409 and old.json()["error"]["code"] == "image_changed"

        # Release: after draft-export, no visuals or image release blockers.
        exported = _cli("draft-export", f"--project-root={root}")
        assert exported.returncode == 0, exported.stderr
        qa = json.loads(
            _cli("production-check", f"--project-root={root}", "--mode", "release",
                 "--json").stdout
        )  # fmt: skip
        image_codes = {"image_not_releasable", "fixture_image", "credit_incomplete"}
        blockers = [
            f for f in qa["blockers"] if f["stage"] == "visuals" or f["code"] in image_codes
        ]
        assert blockers == [], blockers

        # A clearance does not survive a changed image: other bytes under the cleared
        # candidate's name are refused, and G3 is no longer ready.
        x = next(iter(picks.values()))
        other = (
            "global-temperature-anomaly.png"
            if x["local_path"].endswith(".jpg")
            else ("earth-apollo17.jpg")
        )
        (root / x["local_path"]).write_bytes((VISUALS / other).read_bytes())
        v = view()
        assert v["integrity"][x["id"]] == "mismatch"
        assert v["gates"]["g3"]["status"] == "needs_review"
        r = c.post(f"{api}/visuals/edit",
                   json={"expected_revision": v["revision"], "operations": [ops[0]]})  # fmt: skip
        assert r.status_code == 409 and r.json()["error"]["code"] == "image_integrity", r.text
