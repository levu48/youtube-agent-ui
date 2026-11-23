"""M3 UI-B: research edits, decisions, history, documents, attestations and narration lineage
on the fake engine (mirrors engine D-119/D-120). Every mutation is one engine command under
the revision the page loaded; the UI never writes an engine file."""

from __future__ import annotations

import json
import unicodedata
from pathlib import Path

import pytest

from app.engine import commands
from tests.unit import test_research_api as base
from tests.unit.test_research_api import API, _job, _rev, _root

# The UI-A fixtures (fixture search provider, a drafted project with G1, a prepared plan).
settings = base.settings
drafted = base.drafted
planned = base.planned

DOC_TEXT = (
    "Ngày 2 tháng 9 năm 1945, tại Quảng trường Ba Đình, Chủ tịch Hồ Chí Minh đọc bản Tuyên "
    "ngôn Độc lập. Bản Tuyên ngôn mở đầu bằng câu trích Tuyên ngôn Độc lập của Hoa Kỳ năm 1776."
)
DOC = {
    "title": "Tuyên ngôn Độc lập (trích)",
    "language": "vi",
    "citation": "Hồ Chí Minh, Toàn tập, tập 4, NXB Chính trị quốc gia, 2011, tr. 1-3",
    "imported_by": "Trần Thị B",
    "text": DOC_TEXT,
}


def _edit(client, *ops, dry_run: bool = False, revision: str | None = None):
    body = {"expected_revision": revision or _rev(client), "operations": list(ops)}
    if dry_run:
        body["dry_run"] = True
    return client.post(f"{API}/research/edit", json=body)


def _ok(resp) -> dict:
    assert resp.status_code == 200, resp.text
    return resp.json()


def _claim(client, cid: str | None = None) -> dict:
    claims = client.get(f"{API}/research").json()["report"]["claims"]
    return next(c for c in claims if cid is None or c["id"] == cid)


@pytest.fixture
def document(client, planned) -> dict:
    out = _ok(
        client.post(f"{API}/research/documents", json={"expected_revision": _rev(client), **DOC})
    )
    return out["result"]


# --------------------------------------------------------------------------- argv


def test_edit_document_and_lineage_argv_are_allowlisted():
    root = Path("/p")
    rev = "a" * 64
    argv = commands.research_edit_args(root, expect_revision=rev, dry_run=True)
    assert argv == [
        "research-edit",
        "--project-root=/p",
        f"--expect-revision={rev}",
        "--json",
        "--dry-run",
    ]
    doc = commands.research_add_document_args(
        root,
        expect_revision=rev,
        title="T",
        language="vi",
        citation="C",
        imported_by="Trần Thị B",
        declared_url="https://example.org/x",
        note="dòng 1\ndòng 2",
    )
    assert "--declared-url=https://example.org/x" in doc and "--note=dòng 1\ndòng 2" in doc
    commands.assert_allowlisted(doc)
    att = commands.narration_attest_args(
        root,
        expect_revision=rev,
        reviewer="Trần Thị B",
        statement="Viết lại.",
        segment_ids=["seg-" + "1" * 16, "seg-" + "2" * 16],
    )
    assert [a for a in att if a.startswith("--segment=")] == [
        "--segment=seg-1111111111111111",
        "--segment=seg-2222222222222222",
    ]
    commands.assert_allowlisted(commands.narration_provenance_init_args(root, expect_revision=rev))


@pytest.mark.parametrize(
    "kw",
    [
        {"title": None},
        {"citation": ""},
        {"declared_url": "http://example.org/x"},
        {"new_version_of": "src-123"},
        {"note": "bad\x07"},
        {"url": "https://example.org"},
    ],
)
def test_document_argv_rejects_bad_values(kw):
    base = {"title": "T", "language": "vi", "citation": "C", "imported_by": "Trần Thị B"}
    with pytest.raises(commands.ArgumentError):
        commands.research_add_document_args(Path("/p"), expect_revision="a" * 64, **{**base, **kw})


@pytest.mark.parametrize("segment", ["seg-1", "--force", "seg-" + "g" * 16])
def test_attest_argv_rejects_bad_segment_ids(segment):
    with pytest.raises(commands.ArgumentError):
        commands.narration_attest_args(
            Path("/p"), expect_revision="a" * 64, reviewer="B", statement="S", segment_ids=[segment]
        )


# --------------------------------------------------------------------------- request models


@pytest.mark.parametrize(
    "op",
    [
        {
            "op": "reviews.set",
            "claim_id": "clm-001-fake",
            "reviewer": "Trần Thị B",
            "rationale": "x",
        },
        {
            "op": "reviews.set",
            "claim_id": "clm-001-fake",
            "status": "verified",
            "reviewer": "B",
            "rationale": "x",
            "counterargument_summary": None,
        },
        {"op": "claims.update", "id": "clm-001-fake", "colour": "red"},
        {"op": "claims.drop", "id": "clm-001-fake"},
        {"op": "claims.update", "id": "clm-001-fake", "flags": ["not-a-flag"]},
        {
            "op": "evidence.add",
            "claim_id": "clm-001-fake",
            "snapshot_id": "snap-1",
            "quote": "q",
            "role": "supports",
            "explanation": "e",
        },
        {"op": "claims.update", "id": "clm-001-fake", "assertion": "bad\x07"},
    ],
)
def test_malformed_edits_are_refused_before_the_engine(client, planned, op):
    r = _edit(client, op)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


def test_text_is_sent_in_nfc(client, planned, settings):
    decomposed = unicodedata.normalize("NFD", "Hồ Chí Minh đọc Tuyên ngôn")
    _ok(_edit(client, {"op": "claims.update", "id": "clm-001-fake", "assertion": decomposed}))
    plan = json.loads((_root(settings) / "research-plan.json").read_text("utf-8"))
    assert plan["claims"][0]["assertion"] == unicodedata.normalize("NFC", decomposed)


# --------------------------------------------------------------------------- claims


def test_the_view_has_full_claims_with_anchor_context_and_editing_state(client, planned):
    view = client.get(f"{API}/research").json()
    claim = view["plan"]["claims"][0]
    anchor = claim["anchors"][0]
    assert anchor["context"]["excerpt"] == anchor["excerpt"]
    assert claim["origin"] == "rule" and claim["notes"] == ""
    assert view["editing"]["supported"] and not view["editing"]["migration_required"]
    assert view["review"]["schema_version"] == "m5-review-0.2"
    assert any(s["id"] == anchor["scene_id"] for s in view["scenes"])


def test_claim_update_add_and_remove_publish_one_generation(client, planned):
    out = _ok(
        _edit(
            client,
            {"op": "claims.update", "id": "clm-001-fake", "flags": ["date"], "contested": True},
            {
                "op": "claims.add",
                "anchor": {"scene_id": "scene-001", "excerpt": "nhà cung cấp thử nghiệm"},
                "assertion": "Buổi lễ diễn ra ở Ba Đình.",
                "kind": "factual",
            },
        )
    )
    assert out["result"]["status"] == "published"
    created = out["result"]["created"][0]
    assert created["kind"] == "claim"
    claims = {c["id"]: c for c in out["research"]["plan"]["claims"]}
    assert claims["clm-001-fake"]["flags"] == ["date"] and created["id"] in claims
    out = _ok(_edit(client, {"op": "claims.remove", "id": created["id"]}))
    assert created["id"] not in {c["id"] for c in out["research"]["plan"]["claims"]}


def test_a_stale_revision_is_refused_and_nothing_is_written(client, planned, settings):
    before = (_root(settings) / "research-plan.json").read_bytes()
    r = _edit(
        client, {"op": "claims.update", "id": "clm-001-fake", "notes": "n"}, revision="0" * 64
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "revision_conflict"
    assert len(r.json()["error"]["details"]["current_revision"]) == 64
    assert (_root(settings) / "research-plan.json").read_bytes() == before


def test_an_engine_refusal_names_the_operation_and_its_code(client, planned):
    r = _edit(client, {"op": "claims.remove", "id": "clm-999-none"})
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "invalid_edit"
    assert err["details"]["errors"][0] == {
        "loc": "operations.0",
        "msg": "unknown claim 'clm-999-none'",
        "code": "unknown_claim",
    }


def test_a_research_edit_is_refused_while_a_job_runs(client, planned, fake_cli):
    fake_cli.env["FAKE_MODE"] = "research_slow"
    from tests.unit.test_research_api import _preview

    p = _preview(client)
    job = client.post(
        f"{API}/research/collect",
        json={
            "expected_revision": p["revision"],
            "network": True,
            "plan_sha256": p["plan_sha256"],
            "allow_hosts": p["hosts"],
        },
    )
    r = _edit(
        client, {"op": "claims.update", "id": "clm-001-fake", "notes": "n"}, revision=p["revision"]
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "job_conflict"
    client.post(f"/api/v1/jobs/{job.json()['job_id']}/cancel")


# --------------------------------------------------------------------------- evidence and decisions


def test_link_evidence_after_a_dry_run_lists_the_occurrences(client, document):
    link = {
        "op": "evidence.add",
        "claim_id": "clm-001-fake",
        "snapshot_id": document["snapshot_id"],
        "quote": "Tuyên ngôn Độc lập",
        "role": "supports",
        "explanation": "Câu mở đầu nêu sự kiện.",
        "source_type": "primary",
    }
    dry = _ok(_edit(client, link, dry_run=True))
    assert "research" not in dry and dry["result"]["status"] == "would_publish"
    occ = dry["result"]["occurrences"][0]["occurrences"]
    assert [o["n"] for o in occ] == [1, 2] and "Tuyên ngôn Độc lập" in occ[0]["context"]
    r = _edit(client, link)
    assert r.json()["error"]["details"]["errors"][0]["code"] == "ambiguous_quote"
    out = _ok(_edit(client, {**link, "occurrence": 2}))
    ev = out["research"]["evidence"][0]
    assert ev["id"].startswith("ev-") and ev["start"] == occ[1]["start"]
    claim = next(c for c in out["research"]["report"]["claims"] if c["id"] == "clm-001-fake")
    assert claim["supports"][0]["acquisition"] == "imported"


def test_a_decision_goes_outdated_when_the_claim_changes_and_history_keeps_it(client, planned):
    decide = {
        "op": "reviews.set",
        "claim_id": "clm-001-fake",
        "status": "disputed",
        "reviewer": "Trần Thị B",
        "rationale": "Nguồn mâu thuẫn về giờ đọc.",
    }
    _ok(_edit(client, decide))
    assert _claim(client, "clm-001-fake")["status"] == "disputed"
    _ok(_edit(client, {"op": "claims.update", "id": "clm-001-fake", "flags": ["date"]}))
    claim = _claim(client, "clm-001-fake")
    assert claim["status"] == "unverified" and claim["review_outdated"] == ["claim"]
    assert claim["outdated_review"]["status"] == "disputed"
    items = client.get(f"{API}/research").json()["report"]["items"]
    assert any(
        i["code"] == "review_outdated" and i["refs"]["components"] == ["claim"] for i in items
    )
    # Confirm again: the same decision, now on the current claim; the old one goes to history.
    _ok(_edit(client, decide))
    assert _claim(client, "clm-001-fake")["status"] == "disputed"
    page = client.get(f"{API}/research/history", params={"kind": "claim_review"}).json()
    assert page["chain_ok"] is True and page["has_more"] is False
    assert page["entries"][0]["action"] == "replaced"
    assert page["entries"][0]["previous"]["status"] == "disputed"


def test_an_engine_refuses_a_non_person_reviewer(client, planned):
    r = _edit(
        client,
        {
            "op": "reviews.set",
            "claim_id": "clm-001-fake",
            "status": "verified",
            "reviewer": "reviewer",
            "rationale": "x",
        },
    )
    assert r.status_code == 422
    assert r.json()["error"]["details"]["errors"][0]["code"] == "invalid_reviewer"


def test_history_pages_and_tampering(client, planned, settings):
    for n in range(3):
        _ok(
            _edit(
                client,
                {"op": "completeness.set", "reviewer": "Trần Thị B", "statement": f"Lần {n}"},
            )
        )
    first = client.get(f"{API}/research/history", params={"limit": 1}).json()
    assert [e["seq"] for e in first["entries"]] == [1] and first["has_more"]
    rest = client.get(
        f"{API}/research/history", params={"after_seq": first["next_after_seq"]}
    ).json()
    assert [e["seq"] for e in rest["entries"]] == [2]
    assert client.get(f"{API}/research/history", params={"kind": "nope"}).status_code == 422
    assert client.get(f"{API}/research/history", params={"limit": 201}).status_code == 422
    path = _root(settings) / "research-review.json"
    rf = json.loads(path.read_text("utf-8"))
    rf["history"][0]["reason"] = "edited by hand"
    path.write_text(json.dumps(rf, ensure_ascii=False), "utf-8")
    assert client.get(f"{API}/research/history").json()["chain_ok"] is False
    r = _edit(client, {"op": "claims.update", "id": "clm-001-fake", "notes": "n"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "history_tampered"


def test_completeness_goes_stale_when_the_inventory_changes(client, planned):
    codes = lambda: {i["code"] for i in client.get(f"{API}/research").json()["report"]["items"]}  # noqa: E731
    assert "completeness_missing" in codes()
    _ok(_edit(client, {"op": "completeness.set", "reviewer": "Trần Thị B", "statement": "Đủ."}))
    assert not {"completeness_missing", "completeness_stale"} & codes()
    _ok(_edit(client, {"op": "claims.update", "id": "clm-001-fake", "kind": "interpretation"}))
    assert "completeness_stale" in codes()


# --------------------------------------------------------------------------- legacy upgrade


def test_legacy_review_records_need_the_explicit_upgrade(client, drafted, fake_cli):
    fake_cli.env["FAKE_MODE"] = "legacy_review"
    _job(client, client.post(f"{API}/research/plan", json={"expected_revision": _rev(client)}))
    view = client.get(f"{API}/research").json()
    assert (
        view["editing"]["migration_required"]
        and view["review"]["schema_version"] == "m5-review-0.1"
    )
    r = _edit(client, {"op": "claims.update", "id": "clm-001-fake", "notes": "n"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "migration_required"
    assert client.get(f"{API}/research/history").status_code == 502
    out = _ok(_edit(client, {"op": "migrate_review_file"}, {"op": "migrate_ids"}))
    assert out["research"]["review"]["schema_version"] == "m5-review-0.2"
    claim = next(c for c in out["research"]["report"]["claims"] if c["id"] == "clm-001-fake")
    assert claim["review_outdated"] == ["basis_missing"] and claim["status"] == "unverified"
    page = client.get(f"{API}/research/history").json()
    assert page["entries"][0]["kind"] == "migration"


# --------------------------------------------------------------------------- documents


def test_import_a_document_and_a_new_edition(client, document, settings):
    view = client.get(f"{API}/research").json()
    src = next(s for s in view["sources"] if s["id"] == document["source_id"])
    assert src["kind"] == "document" and src["url"] is None and src["host"] is None
    snap = next(s for s in view["snapshots"] if s["id"] == document["snapshot_id"])
    assert snap["acquisition"] == "imported"
    assert snap["document_provenance"]["citation"] == DOC["citation"]
    dup = client.post(f"{API}/research/documents", json={"expected_revision": _rev(client), **DOC})
    assert (
        dup.status_code == 422
        and dup.json()["error"]["details"]["errors"][0]["code"] == "document_exists"
    )
    edition = {
        **DOC,
        "citation": DOC["citation"] + " (bản sửa)",
        "new_version_of": document["source_id"],
    }
    out = _ok(
        client.post(
            f"{API}/research/documents", json={"expected_revision": _rev(client), **edition}
        )
    )
    assert out["result"]["supersedes_snapshot_id"] == document["snapshot_id"]


@pytest.mark.parametrize(
    "change",
    [
        {"url": "https://example.org/x"},
        {"declared_url": "http://example.org/x"},
        {"citation": "   "},
        {"text": "a\x00b"},
        {"new_version_of": "doc-" + "0" * 16},
        {"new_version_of": "src-0123456789ab"},
        {"text": "x" * 400_001},
    ],
)
def test_bad_document_imports_are_refused_before_the_engine(client, planned, change):
    r = client.post(
        f"{API}/research/documents", json={"expected_revision": _rev(client), **DOC, **change}
    )
    assert r.status_code == 422, r.text


def test_primary_attestation_and_revocation(client, document):
    sid = document["snapshot_id"]
    _ok(
        _edit(
            client,
            {
                "op": "documents.attest_primary",
                "snapshot_id": sid,
                "reviewer": "Trần Thị B",
                "statement": "Bản in chính thức của văn kiện gốc.",
            },
        )
    )
    review = client.get(f"{API}/research").json()["review"]
    assert review["primary_source_attestations"][0]["snapshot_id"] == sid
    _ok(
        _edit(
            client,
            {
                "op": "documents.revoke_primary",
                "snapshot_id": sid,
                "reviewer": "Trần Thị B",
                "reason": "Nhầm ấn bản.",
            },
        )
    )
    view = client.get(f"{API}/research").json()
    assert view["review"]["primary_source_attestations"] == []
    assert view["review"]["history_summary"]["count"] == 1


def test_source_rechecks_add_update_and_remove(client, document):
    link = {
        "op": "evidence.add",
        "claim_id": "clm-001-fake",
        "snapshot_id": document["snapshot_id"],
        "quote": "Quảng trường Ba Đình",
        "role": "supports",
        "explanation": "Nơi diễn ra.",
    }
    _ok(_edit(client, link))
    edition = {
        **DOC,
        "citation": DOC["citation"] + " (in lại)",
        "new_version_of": document["source_id"],
    }
    new = _ok(
        client.post(
            f"{API}/research/documents", json={"expected_revision": _rev(client), **edition}
        )
    )
    add = {
        "op": "source_rechecks.add",
        "source_id": document["source_id"],
        "cited_snapshot_id": document["snapshot_id"],
        "expected_current_snapshot_id": new["result"]["snapshot_id"],
        "claim_ids": ["clm-001-fake"],
        "reviewer": "Trần Thị B",
        "rationale": "Câu trích không đổi.",
    }
    rid = _ok(_edit(client, add))["result"]["created"][0]["id"]
    again = _edit(client, add)
    assert again.json()["error"]["details"]["errors"][0]["code"] == "recheck_exists"
    _ok(
        _edit(
            client,
            {
                "op": "source_rechecks.update",
                "recheck_id": rid,
                "reviewer": "Trần Thị B",
                "rationale": "Đã so lại cả hai ấn bản.",
            },
        )
    )
    _ok(
        _edit(
            client,
            {
                "op": "source_rechecks.remove",
                "recheck_id": rid,
                "reviewer": "Trần Thị B",
                "reason": "Liên kết bản mới thay thế.",
            },
        )
    )
    kinds = [e["action"] for e in client.get(f"{API}/research/history").json()["entries"]]
    assert kinds == ["updated", "removed"]


# --------------------------------------------------------------------------- narration lineage


def test_the_narration_view_shows_fixture_segments_with_their_text(client, planned):
    view = client.get(f"{API}/draft/narration").json()
    segs = view["lineage"]["segments"]
    assert segs and all(s["origin"] == "fixture" for s in segs)
    assert all(s["text"] for s in segs)  # every sentence matched by its SHA-256
    assert view["items"][0]["code"] == "fixture_narration" and not view["needs_init"]
    r = client.post(
        f"{API}/draft/narration/attest",
        json={
            "expected_revision": view["revision"],
            "reviewer": "Trần Thị B",
            "statement": "Tôi đã viết lại.",
            "segment_ids": [segs[0]["segment_id"]],
        },
    )
    assert r.status_code == 422
    assert r.json()["error"] == {
        "code": "lineage_refused",
        "message": f"{segs[0]['segment_id']} equals fixture text",
        "details": {"reason": "unchanged_fixture_text"},
    }


def test_a_rewrite_can_be_attested(client, fake_cli):
    from tests.conftest import PROJECT

    fake_cli.env["FAKE_REVISION"] = "1"
    assert client.post("/api/v1/projects", json=PROJECT).status_code == 201
    _job(client, client.post(f"{API}/draft-jobs", json={"provider": "fixture"}))
    draft = client.get(f"{API}/draft/editable").json()
    sec = draft["script"]["data"]["sections"][0]["outline_section_id"]
    r = client.post(
        f"{API}/draft/edit",
        json={
            "expected_revision": draft["editing"]["revision"],
            "script": {
                "sections": [
                    {
                        "outline_section_id": sec,
                        "narration": "Một câu do biên tập viên viết hoàn toàn mới.",
                    }
                ]
            },
        },
    )
    assert r.status_code == 200, r.text
    view = client.get(f"{API}/draft/narration").json()
    derived = [s for s in view["lineage"]["segments"] if s["origin"] == "fixture_derived"]
    assert [s["text"] for s in derived] == ["Một câu do biên tập viên viết hoàn toàn mới."]
    out = client.post(
        f"{API}/draft/narration/attest",
        json={
            "expected_revision": view["revision"],
            "reviewer": "Trần Thị B",
            "statement": "Tôi viết lại câu mở đầu.",
            "segment_ids": [derived[0]["segment_id"]],
        },
    ).json()
    assert out["result"]["status"] == "attested"
    seg = next(
        s
        for s in out["narration"]["lineage"]["segments"]
        if s["segment_id"] == derived[0]["segment_id"]
    )
    assert seg["origin"] == "human" and seg["attestation"]["reviewer"] == "Trần Thị B"


def test_legacy_fixture_projects_initialise_lineage_once(client, planned, settings):
    (_root(settings) / "render/llm/narration-provenance.json").unlink()
    view = client.get(f"{API}/draft/narration").json()
    assert view["lineage"]["present"] is False
    body = {"expected_revision": view["revision"], "confirm": True}
    assert (
        client.post(
            f"{API}/draft/narration/provenance-init", json={**body, "confirm": False}
        ).status_code
        == 422
    )
    out = client.post(f"{API}/draft/narration/provenance-init", json=body).json()
    assert out["result"]["status"] == "initialized" and out["result"]["recovered"] is False
    segs = out["narration"]["lineage"]["segments"]
    assert segs and {s["initialized_from"] for s in segs} == {"legacy_unrecoverable"}
    again = client.post(
        f"{API}/draft/narration/provenance-init",
        json={"expected_revision": out["narration"]["revision"], "confirm": True},
    )
    assert again.status_code == 422 and again.json()["error"]["details"] == {
        "reason": "already_initialized"
    }
