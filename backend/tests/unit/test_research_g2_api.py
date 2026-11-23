"""M3 UI-C: G2 approval, apply and export on the fake engine (mirrors engine fb6bffc). Each is
one engine command under the revision the reviewer validated; the engine decides, and a refusal
records nothing."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.engine import commands
from tests.unit import test_research_api as base
from tests.unit.test_research_api import API, _job, _rev, _root

settings = base.settings
REVIEWER = "Trần Thị B"


def _ok(resp) -> dict:
    assert resp.status_code == 200, resp.text
    return resp.json()


def _err(resp, status: int, code: str) -> dict:
    assert resp.status_code == status, resp.text
    assert resp.json()["error"]["code"] == code, resp.text
    return resp.json()["error"]


def _edit(client, *ops):
    return _ok(
        client.post(
            f"{API}/research/edit",
            json={"expected_revision": _rev(client), "operations": list(ops)},
        )
    )


def _g1(client) -> None:
    draft = client.get(f"{API}/draft").json()
    _ok(
        client.post(
            f"{API}/draft/approve",
            json={
                "reviewer": "Nguyễn Văn A",
                "confirm": True,
                "review_token": draft["review_token"],
            },
        )
    )


@pytest.fixture
def g1(client, settings) -> Path:
    """A drafted project with a real (fake-engine) G1 and attested narration lineage."""
    assert client.post("/api/v1/projects", json=base.PROJECT).status_code == 201
    _job(client, client.post(f"{API}/draft-jobs", json={"provider": "fixture"}))
    root = _root(settings)
    lineage = root / "render/llm/narration-provenance.json"
    rec = json.loads(lineage.read_text("utf-8"))
    for s in rec["segments"]:  # as if every sentence was rewritten and attested
        s["origin"] = "human"
    lineage.write_text(json.dumps(rec, ensure_ascii=False), "utf-8")
    _g1(client)
    return root


@pytest.fixture
def approvable(client, g1) -> dict:
    """Plan, an imported document holding each claim's sentence, a supports link and a
    verified decision per claim, and the completeness attestation."""
    _job(client, client.post(f"{API}/research/plan", json={"expected_revision": _rev(client)}))
    claims = client.get(f"{API}/research").json()["plan"]["claims"]
    text = " ".join(f"{c['assertion']}." for c in claims)
    doc = _ok(
        client.post(
            f"{API}/research/documents",
            json={
                "expected_revision": _rev(client),
                "title": "Văn bản thử",
                "language": "vi",
                "citation": "Tài liệu kiểm thử của fake engine",
                "imported_by": REVIEWER,
                "text": text,
            },
        )
    )["result"]
    ops = []
    for c in claims:
        ops.append({"op": "evidence.add", "claim_id": c["id"], "snapshot_id": doc["snapshot_id"],
                    "quote": c["assertion"], "role": "supports",
                    "explanation": "Đoạn văn nêu đúng nội dung câu này."})  # fmt: skip
    _edit(client, *ops)
    ops = [
        {
            "op": "reviews.set",
            "claim_id": c["id"],
            "status": "verified",
            "reviewer": REVIEWER,
            "rationale": "Tôi đã đọc đoạn văn được liên kết và nó nêu đúng câu này.",
        }  # fmt: skip
        for c in claims
    ]
    ops.append({"op": "completeness.set", "reviewer": REVIEWER,
                "statement": "Mọi câu có nội dung sự kiện đều đã có claim."})  # fmt: skip
    view = _edit(client, *ops)["research"]
    assert view["report"]["approvable"] is True, view["report"]["items"]
    return view


def _approve(client, revision: str, **kw):
    body = {"expected_revision": revision, "reviewer": REVIEWER, "confirm": True, **kw}
    return client.post(f"{API}/research/approve", json=body)


# --------------------------------------------------------------------------- argv


def test_g2_apply_and_export_argv_are_allowlisted_and_never_replace():
    root, rev = Path("/p"), "a" * 64
    approve = commands.research_approve_args(
        root, expect_revision=rev, reviewer="Trần Thị B", comment="Đã đối chiếu."
    )
    assert approve == [
        "research-approve",
        "--project-root=/p",
        "--reviewer=Trần Thị B",
        "--comment=Đã đối chiếu.",
        f"--expect-revision={rev}",
        "--json",
    ]
    apply = commands.research_apply_args(root, expect_revision=rev)
    export = commands.research_export_args(root, expect_revision=rev)
    assert apply == ["research-apply", "--project-root=/p", f"--expect-revision={rev}", "--json"]
    assert export == ["research-export", "--project-root=/p", f"--expect-revision={rev}", "--json"]
    for argv in (approve, apply, export):
        commands.assert_allowlisted(argv)
        assert not any(a.startswith(("--replace", "--force")) for a in argv)


@pytest.mark.parametrize(
    "kw",
    [
        {"reviewer": "Trần\nThị B"},
        {"reviewer": " "},
        {"comment": "x\x07"},
        {"expect_revision": "abc"},
    ],
)
def test_approve_argv_rejects_bad_values(kw):
    args = {"expect_revision": "a" * 64, "reviewer": "Trần Thị B", **kw}
    with pytest.raises(commands.ArgumentError):
        commands.research_approve_args(Path("/p"), **args)


@pytest.mark.parametrize(
    "body",
    [
        {"reviewer": REVIEWER},  # no confirmation
        {"reviewer": REVIEWER, "confirm": False},
        {"reviewer": REVIEWER, "confirm": True, "comment": None},
        {"reviewer": REVIEWER, "confirm": True, "extra": 1},
        {"confirm": True},
    ],
)
def test_approve_requests_are_strict(client, body):
    r = client.post(f"{API}/research/approve", json={"expected_revision": "a" * 64, **body})
    assert r.status_code == 422, r.text


def test_apply_needs_an_explicit_confirmation(client):
    r = client.post(f"{API}/research/apply", json={"expected_revision": "a" * 64})
    assert r.status_code == 422


# --------------------------------------------------------------------------- the G2 journey


def test_approve_apply_g1_again_and_export(client, approvable, g1):
    assert approvable["gates"] == {"g1": "approved", "g2": "needs_review"}
    out = _ok(_approve(client, approvable["revision"], comment="Đã đối chiếu từng câu."))
    assert out["result"]["status"] == "approved"
    assert out["result"]["approval"]["reviewer"] == REVIEWER
    assert "not permission to publish" in out["result"]["approval"]["meaning"]
    view = out["research"]
    assert view["report"]["approval_status"] == "approved" and view["report"]["applied"] is False
    assert view["gates"]["g2"] == "approved_not_applied"
    again = _ok(_approve(client, view["revision"]))
    assert again["result"]["status"] == "already_approved"

    # Export needs apply first; the engine says so.
    err = _err(
        client.post(f"{API}/research/export", json={"expected_revision": view["revision"]}),
        422,
        "not_approvable",
    )
    assert "research-apply" in err["message"]

    out = _ok(
        client.post(
            f"{API}/research/apply", json={"expected_revision": view["revision"], "confirm": True}
        )
    )
    assert out["result"]["status"] == "published" and out["result"]["scenes_changed"]
    assert out["result"]["written"] == ["storyboard.draft.json"]
    view = out["research"]
    assert view["gates"] == {"g1": "stale_after_apply", "g2": "approved"}
    assert view["report"]["applied"] is True and view["report"]["approval_status"] == "approved"
    note = next(i for i in view["report"]["items"] if i["code"] == "editorial_storyboard_changed")
    assert note["blocking"] is False
    sb = json.loads((g1 / "storyboard.draft.json").read_text("utf-8"))
    assert any(s["claim_ids"] for s in sb["scenes"])

    # G1 again through M2's flow; the research approval stays current.
    _g1(client)
    view = client.get(f"{API}/research").json()
    assert view["gates"] == {"g1": "approved", "g2": "approved"}

    out = _ok(client.post(f"{API}/research/export", json={"expected_revision": view["revision"]}))
    assert sorted(out["result"]["written"]) == [
        "output/sources.md",
        "render/research/citation-plan.json",
        "render/research/research-report.json",
        "render/research/research-report.md",
    ]
    out = _ok(client.post(f"{API}/research/export", json={"expected_revision": view["revision"]}))
    assert out["result"]["written"] == [] and len(out["result"]["unchanged"]) == 4

    # A hand-edited export is never overwritten, and the UI does not suggest the replace flag.
    with (g1 / "output/sources.md").open("a", encoding="utf-8") as fh:
        fh.write("ghi chú tay\n")
    err = _err(
        client.post(f"{API}/research/export", json={"expected_revision": view["revision"]}),
        409,
        "human_edit_conflict",
    )
    assert err["details"]["paths"] == ["output/sources.md"]
    assert (
        "--replace" not in err["message"]
        and "ghi chú tay" in (g1 / "output/sources.md").read_text()
    )


def test_approval_uses_the_validated_revision(client, approvable, g1):
    validated = approvable["revision"]
    _edit(client, {"op": "claims.update", "id": approvable["plan"]["claims"][0]["id"],
                   "notes": "Ghi chú mới sau khi kiểm tra."})  # fmt: skip
    err = _err(_approve(client, validated), 409, "revision_conflict")
    assert err["details"]["current_revision"] == _rev(client)
    assert not (g1 / "research-approval.json").exists()


def test_a_change_while_approving_records_nothing(client, approvable, g1, fake_cli):
    fake_cli.env["FAKE_MODE"] = "research_race"
    _err(_approve(client, approvable["revision"]), 409, "revision_conflict")
    assert not (g1 / "research-approval.json").exists()


def test_not_approvable_lists_the_engine_items(client, g1):
    _job(client, client.post(f"{API}/research/plan", json={"expected_revision": _rev(client)}))
    err = _err(_approve(client, _rev(client)), 422, "not_approvable")
    codes = {i["code"] for i in err["details"]["items"]}
    assert {"no_sources", "completeness_missing"} <= codes, err


def test_approve_needs_a_current_g1(client, approvable, g1):
    (g1 / "outline.json").write_text(
        (g1 / "outline.json").read_text("utf-8") + "\n", "utf-8"
    )  # an outline edit made in the CLI: G1 is stale (not just after apply)
    client.app.state.ctx.engine.invalidate("hcm-demo")  # the status cache expires
    view = client.get(f"{API}/research").json()
    assert view["gates"]["g1"] == "stale"
    _err(_approve(client, view["revision"]), 409, "g1_not_current")


def test_a_generic_reviewer_is_refused(client, approvable):
    r = client.post(
        f"{API}/research/approve",
        json={"expected_revision": approvable["revision"], "reviewer": "reviewer", "confirm": True},
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_edit", r.text


def test_a_later_edit_makes_g2_stale_and_apply_is_refused(client, approvable):
    _ok(_approve(client, approvable["revision"]))
    view = _edit(client, {"op": "claims.update", "id": approvable["plan"]["claims"][0]["id"],
                          "notes": "Ghi chú mới sau khi duyệt."})["research"]  # fmt: skip
    assert view["report"]["approval_status"] == "stale"
    assert view["gates"]["g2"] == "needs_review"
    _err(
        client.post(
            f"{API}/research/apply", json={"expected_revision": view["revision"], "confirm": True}
        ),
        409,
        "approval_stale",
    )


def test_writes_are_refused_while_the_project_is_busy(client, approvable):
    with client.app.state.ctx.jobs.exclusive("hcm-demo"):
        _err(_approve(client, approvable["revision"]), 409, "project_busy")
