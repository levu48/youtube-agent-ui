"""M4 UI-B: visuals edits and apply on the fake engine (mirrors engine D-123/D-124 at 26c608f).

Every edit is one ``visuals-edit`` publication under the loaded revision, with the patch on
stdin; a clearance is bound to the exact image hash and rights fingerprint the reviewer saw;
apply is bound to the validated revision and never replaces hand edits. G3 is the engine's.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.engine import commands
from app.visuals_schemas import CLEARANCE_ACKNOWLEDGEMENT
from tests.fake_visuals import png
from tests.unit import test_visuals_api as base
from tests.unit.test_visuals_api import API, _calls, _pending, _rev, _root, _upload, _view, _writes

settings = base.settings
drafted = base.drafted
planned = base.planned
acquired = base.acquired


def _edit(client, *ops: dict, rev: str | None = None, dry_run: bool = False):
    body = {"expected_revision": rev or _rev(client), "operations": list(ops)}
    if dry_run:
        body["dry_run"] = True
    return client.post(f"{API}/visuals/edit", json=body)


def _apply(client, rev: str | None = None, **extra):
    body = {"expected_revision": rev or _rev(client), "reviewer": "Lan Nguyen", "confirm": True}
    return client.post(f"{API}/visuals/apply", json={**body, **extra})


def _argv(settings, cmd: str) -> list[str]:
    lines = (_root(settings) / "visuals-calls.jsonl").read_text().splitlines()
    return [json.loads(x)["argv"] for x in lines if json.loads(x)["argv"][0] == cmd][-1]


def _import(client, scene: str, rgb=(10, 200, 30)) -> dict:
    r = _upload(client, _rev(client), png(640, 360, rgb), scene_id=scene,
                kind="chart" if scene == "scene-003" else "archival",
                license_name="CC BY 4.0", license_url="https://creativecommons.org/licenses/by/4.0/",
                source_url="https://project.example/card", attribution="Project team")  # fmt: skip
    assert r.status_code == 200, r.text
    cid = r.json()["result"]["candidate_id"]
    return next(c for c in r.json()["visuals"]["candidates"][scene] if c["id"] == cid)


def _clear_op(c: dict, **over) -> dict:
    return {
        "op": "clearance.set", "candidate_id": c["id"],
        "expected_candidate_sha256": c["sha256"],
        "expected_rights_fingerprint": c["rights_fingerprint"],
        "reviewer": "Lan Nguyen", "basis": "own_work",
        "justification": "The project team drew this card itself for this video.",
        "evidence": "https://project.example/card", "acknowledgement": CLEARANCE_ACKNOWLEDGEMENT,
        **over,
    }  # fmt: skip


def _scene_ids(client) -> list[str]:
    return [s["scene_id"] for s in _view(client)["scenes"]]


@pytest.fixture
def imported(client, planned) -> dict[str, dict]:
    """One cleared-able import per scene (distinct bytes), nothing selected yet."""
    return {sid: _import(client, sid, (20 + 25 * n, 90, 160))
            for n, sid in enumerate(_scene_ids(client))}  # fmt: skip


def _g3(v: dict) -> tuple[str, set[str]]:
    g = v["gates"]["g3"]
    return g["status"], {f["code"] for f in g["findings"]}


# --------------------------------------------------------------------------- argv


def test_edit_and_apply_argv_are_allowlisted_and_never_replace():
    rev = "a" * 64
    edit = commands.visuals_edit_args(Path("/p"), expect_revision=rev)
    assert edit == ["visuals-edit", "--project-root=/p", f"--expect-revision={rev}", "--json"]
    assert commands.visuals_edit_args(Path("/p"), expect_revision=rev, dry_run=True)[-1] == (
        "--dry-run"
    )
    apply = commands.visuals_apply_args(Path("/p"), expect_revision=rev, reviewer="Lan Nguyen")
    assert apply == [
        "visuals-apply", "--project-root=/p", "--reviewer=Lan Nguyen", f"--expect-revision={rev}",
        "--json",
    ]  # fmt: skip
    for argv in (edit, apply):
        commands.assert_allowlisted(argv)
    for flag in ("--replace-shots", "--replace-assets"):
        with pytest.raises(commands.ArgumentError):
            commands.assert_allowlisted([*apply, flag])
    with pytest.raises(commands.ArgumentError):
        commands.visuals_apply_args(Path("/p"), expect_revision=rev, reviewer="  ")
    with pytest.raises(commands.ArgumentError):
        commands.visuals_edit_args(Path("/p"), expect_revision="not-a-revision")


# --------------------------------------------------------------------------- request models


@pytest.mark.parametrize(
    "op",
    [
        {"op": "shots.set", "scene_id": "scene-001", "shots": []},
        {"op": "shots.set", "scene_id": "scene-001", "shots": [{"candidate_id": "x"}]},
        {"op": "shots.set", "scene_id": "scene-001",
         "shots": [{"candidate_id": "scene-001-cm-0123456789", "motion": "spin"}]},
        {"op": "shots.set", "scene_id": "scene-001",
         "shots": [{"candidate_id": "scene-001-cm-0123456789", "fit": None}]},
        {"op": "shots.clear", "scene_id": "scene-001", "extra": 1},
        {"op": "clearance.set", "candidate_id": "scene-001-imp-0123456789"},
        {"op": "plan.update", "scene_id": "scene-001", "search_enabled": "no"},
        {"op": "clearance.revoke", "candidate_id": "scene-001-imp-0123456789",
         "reviewer": "x", "reason": "a\x07b"},
        {"op": "nope"},
    ],
)  # fmt: skip
def test_malformed_edits_are_refused_before_any_engine_run(client, acquired, settings, op):
    before = _writes(settings)
    r = _edit(client, op)
    assert r.status_code == 422, r.text
    assert _writes(settings) == before  # no visuals-edit ran


def test_too_many_shots_or_operations_are_refused(client, acquired):
    shot = {"candidate_id": "scene-001-cm-0123456789"}
    assert _edit(client, {"op": "shots.set", "scene_id": "scene-001",
                          "shots": [shot] * 21}).status_code == 422  # fmt: skip
    ops = [{"op": "shots.clear", "scene_id": "scene-001"}] * 201
    assert _edit(client, *ops).status_code == 422


# --------------------------------------------------------------------------- shots


def test_a_selection_is_published_on_stdin_and_shown_as_not_applied(client, acquired, settings):
    c = _view(client)["candidates"]["scene-001"][0]
    op = {"op": "shots.set", "scene_id": "scene-001",
          "shots": [{"candidate_id": c["id"], "motion": "pan_left"}]}  # fmt: skip
    r = _edit(client, op)
    assert r.status_code == 200, r.text
    res = r.json()["result"]
    assert res["status"] == "published" and res["changed_files"] == ["visual-selection.json"]
    sent = json.loads((_root(settings) / "visuals-edit-stdin.json").read_text())
    assert sent == {"operations": [op]}  # exactly what was given: no defaulted fields
    argv = _argv(settings, "visuals-edit")
    assert "--json" in argv and any(a.startswith("--expect-revision=") for a in argv)
    v = r.json()["visuals"]
    scene = next(s for s in v["scenes"] if s["scene_id"] == "scene-001")
    assert scene["apply_state"] == "selected_not_applied"
    assert "visuals_not_applied" in _g3(v)[1]
    # The same edit again changes nothing.
    assert _edit(client, op).json()["result"]["status"] == "already_current"


def test_a_dry_run_writes_nothing_and_returns_no_view(client, acquired, settings):
    c = _view(client)["candidates"]["scene-001"][0]
    sel = (_root(settings) / "visual-selection.json").read_bytes()
    r = _edit(client, {"op": "shots.set", "scene_id": "scene-001",
                       "shots": [{"candidate_id": c["id"]}]}, dry_run=True)  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["result"]["status"] == "would_publish" and "visuals" not in r.json()
    assert "--dry-run" in _argv(settings, "visuals-edit")
    assert (_root(settings) / "visual-selection.json").read_bytes() == sel


def test_a_stale_revision_is_refused_by_the_backend_first(client, acquired, settings):
    rev = _rev(client)
    p = _root(settings) / "visual-plan.json"
    p.write_text(p.read_text() + "\n")  # a CLI edit
    before = _writes(settings)
    r = _edit(client, {"op": "shots.clear", "scene_id": "scene-001"}, rev=rev)
    assert r.status_code == 409 and r.json()["error"]["code"] == "revision_conflict"
    assert r.json()["error"]["details"]["current_revision"] == _rev(client)
    assert _writes(settings) == before


def test_a_pending_publication_refuses_edits_and_apply_before_the_engine(
    client, acquired, settings
):
    rev = _rev(client)
    _pending(settings)
    before = _writes(settings)
    for r in (_edit(client, {"op": "shots.clear", "scene_id": "scene-001"}, rev=rev),
              _apply(client, rev=rev)):  # fmt: skip
        assert r.status_code == 409 and r.json()["error"]["code"] == "recovery_required"
        assert r.json()["error"]["details"]["checked_by"] == "backend"
    assert _writes(settings) == before


def test_changed_candidate_bytes_refuse_the_selection(client, acquired, settings):
    c = _view(client)["candidates"]["scene-001"][0]
    (_root(settings) / c["local_path"]).write_bytes(b"\x89PNG\r\n\x1a\nchanged")
    r = _edit(client, {"op": "shots.set", "scene_id": "scene-001",
                       "shots": [{"candidate_id": c["id"]}]})  # fmt: skip
    assert r.status_code == 409 and r.json()["error"]["code"] == "image_integrity"
    assert r.json()["error"]["details"]["candidate_ids"] == [c["id"]]


def test_an_unknown_candidate_is_an_invalid_edit_with_the_engine_items(client, acquired):
    r = _edit(client, {"op": "shots.set", "scene_id": "scene-001",
                       "shots": [{"candidate_id": "scene-001-cm-0123456789"}]})  # fmt: skip
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_edit"
    assert r.json()["error"]["details"]["errors"][0]["code"] == "unknown_candidate"


def test_an_engine_concurrency_refusal_asks_for_a_reload(client, acquired, fake_cli):
    fake_cli.env["FAKE_MODE"] = "visuals_edit_race"
    r = _edit(client, {"op": "shots.clear", "scene_id": "scene-001"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "engine_conflict"


# --------------------------------------------------------------------------- clearances


def test_a_clearance_is_bound_to_the_bytes_and_evidence_seen(client, imported):
    c = imported["scene-001"]
    wrong = _edit(client, _clear_op(c, expected_rights_fingerprint="0" * 64))
    assert wrong.status_code == 422
    assert wrong.json()["error"]["details"]["errors"][0]["code"] == "target_changed"
    ack = _edit(client, _clear_op(c, acknowledgement=CLEARANCE_ACKNOWLEDGEMENT[:-1]))
    assert ack.status_code == 422 and "acknowledgement" in ack.json()["error"]["message"]
    ok = _edit(client, _clear_op(c))
    assert ok.status_code == 200, ok.text
    res = ok.json()["result"]
    assert res["history"] == [{"op_index": 0, "id": "ch-00001", "action": "set",
                               "candidate_id": c["id"]}]  # fmt: skip
    v = ok.json()["visuals"]
    assert v["clearance_history"]["entries"][0]["by_reviewer"] == "Lan Nguyen"
    assert v["clearance_history_problems"] == []


def test_a_revocation_needs_a_reason_and_is_kept_in_the_history(client, imported):
    c = imported["scene-001"]
    _edit(client, _clear_op(c))
    thin = _edit(client, {"op": "clearance.revoke", "candidate_id": c["id"],
                          "reviewer": "Lan Nguyen", "reason": "no"})  # fmt: skip
    assert thin.status_code == 422
    assert thin.json()["error"]["details"]["errors"][0]["code"] == "reason_too_thin"
    r = _edit(client, {"op": "clearance.revoke", "candidate_id": c["id"], "reviewer": "Lan Nguyen",
                       "reason": "The owner withdrew the permission for this card today."},
               )  # fmt: skip
    assert r.status_code == 200, r.text
    actions = [e["action"] for e in r.json()["visuals"]["clearance_history"]["entries"]]
    assert actions == ["set", "revoked"]


def test_a_tampered_history_refuses_every_edit(client, imported, settings):
    _edit(client, _clear_op(imported["scene-001"]))
    p = _root(settings) / "render/visuals/clearance-history.json"
    p.write_text(p.read_text().replace("Lan Nguyen", "Someone Else"))
    v = _view(client)
    assert v["clearance_history_problems"]
    r = _edit(client, {"op": "shots.clear", "scene_id": "scene-001"}, rev=v["revision"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "history_tampered"


# --------------------------------------------------------------------------- plan narrowing


def test_the_plan_can_only_be_narrowed(client, acquired):
    chart = next(s for s in _view(client)["plan"]["scenes"] if not s["search_enabled"])
    widen = _edit(client, {"op": "plan.update", "scene_id": chart["scene_id"],
                           "search_enabled": True})  # fmt: skip
    assert widen.status_code == 422
    assert widen.json()["error"]["details"]["errors"][0]["code"] == "not_narrowing"
    r = _edit(client, {"op": "plan.update", "scene_id": "scene-001", "search_enabled": False,
                       "search_query": "harbour 1902"})  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["result"]["changed_files"] == ["visual-plan.json"]
    p = next(s for s in r.json()["visuals"]["plan"]["scenes"] if s["scene_id"] == "scene-001")
    assert p["search_enabled"] is False and p["search_query"] == "harbour 1902"


# --------------------------------------------------------------------------- apply and G3


def _select_all(client, imported: dict[str, dict]) -> None:
    ops = [_clear_op(c) for c in imported.values()]
    ops += [{"op": "shots.set", "scene_id": sid, "shots": [{"candidate_id": c["id"]}]}
            for sid, c in imported.items()]  # fmt: skip
    r = _edit(client, *ops)
    assert r.status_code == 200, r.text


def test_apply_needs_confirmation_and_a_reviewer(client, acquired, settings):
    before = _writes(settings)
    body = {"expected_revision": _rev(client), "reviewer": "Lan Nguyen"}
    assert client.post(f"{API}/visuals/apply", json=body).status_code == 422
    assert client.post(f"{API}/visuals/apply", json={**body, "confirm": True, "reviewer": " "}
                       ).status_code == 422  # fmt: skip
    assert _writes(settings) == before


def test_the_full_journey_reaches_g3_ready_after_apply_and_reapproval(client, imported, settings):
    assert _g3(_view(client)) == ("needs_review", {"visuals_selection_needed"})
    _select_all(client, imported)
    v = _view(client)
    assert {s["apply_state"] for s in v["scenes"]} == {"selected_not_applied"}
    assert _g3(v) == ("needs_review", {"visuals_not_applied"})
    validated = v["revision"]
    r = _apply(client, rev=validated)
    assert r.status_code == 200, r.text
    res = r.json()["result"]
    assert res["status"] == "published" and len(res["scenes_changed"]) == 8
    assert res["rights_unverified"] == []
    assert "--reviewer=Lan Nguyen" in _argv(settings, "visuals-apply")
    v = r.json()["visuals"]
    assert {s["apply_state"] for s in v["scenes"]} == {"applied_current"}
    assert v["gates"]["g1"]["status"] == "stale_after_apply"
    assert _g3(v) == ("ready", set())
    assert all(a["rights_current"] and a["problem"] is None for a in v["assets"])
    # The validated revision is spent: applying it again is a conflict.
    again = _apply(client, rev=validated)
    assert again.status_code == 409 and again.json()["error"]["code"] == "revision_conflict"
    # Re-approving the draft (G1) leaves G3 as it is.
    (_root(settings) / "review.json").write_text('{"approved": "again"}')
    v = _view(client)
    assert v["gates"]["g1"]["status"] == "approved" and _g3(v) == ("ready", set())


def test_a_revoked_clearance_after_apply_blocks_g3_without_touching_assets(
    client, imported, settings
):
    _select_all(client, imported)
    _apply(client)
    assets = (_root(settings) / "assets.json").read_bytes()
    c = imported["scene-001"]
    _edit(client, {"op": "shots.clear", "scene_id": "scene-001"},
          {"op": "clearance.revoke", "candidate_id": c["id"], "reviewer": "Lan Nguyen",
           "reason": "The owner withdrew the permission for this card today."})  # fmt: skip
    v = _view(client)
    a = next(a for a in v["assets"] if c["id"] in a["candidate_ids"])
    assert a["rights_current"] is False and a["rights_reason"] == "clearance_revoked"
    assert _g3(v)[0] == "needs_review" and "image_rights_not_cleared" in _g3(v)[1]
    assert (_root(settings) / "assets.json").read_bytes() == assets  # owner decision 3
    # A new clearance restores it without an apply.
    _edit(client, _clear_op(c))
    a = next(a for a in _view(client)["assets"] if c["id"] in a["candidate_ids"])
    assert a["rights_current"] is True


def test_hand_edited_draft_shots_are_refused_never_replaced(client, imported, settings):
    _select_all(client, imported)
    sb = _root(settings) / "storyboard.draft.json"
    doc = json.loads(sb.read_text())
    doc["scenes"][0]["shots"] = [{"asset_id": "img-0000000000000000", "motion": "static"}]
    sb.write_text(json.dumps(doc))
    before = sb.read_bytes()
    r = _apply(client)
    assert r.status_code == 409 and r.json()["error"]["code"] == "human_edit_conflict"
    assert r.json()["error"]["details"]["conflicts"]
    assert sb.read_bytes() == before
    assert all("--replace-shots" not in a for a in _argv(settings, "visuals-apply"))


def test_the_shared_bytes_refusal_is_shown_with_the_engine_items(client, imported, fake_cli):
    _select_all(client, imported)
    fake_cli.env["FAKE_MODE"] = "visuals_apply_not_ready"
    r = _apply(client)
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_ready"
    assert "different provenance or rights" in r.json()["error"]["details"]["errors"][0]


def test_apply_refuses_changed_candidate_bytes(client, imported, settings):
    _select_all(client, imported)
    c = imported["scene-001"]
    (_root(settings) / c["local_path"]).write_bytes(png(640, 360, (1, 2, 3)))
    r = _apply(client)
    assert r.status_code == 409 and r.json()["error"]["code"] == "image_integrity"
    assert not (_root(settings) / "render/visuals/applied.json").exists()


def test_a_removed_applied_image_is_reported_and_restored_by_apply(client, imported, settings):
    _select_all(client, imported)
    _apply(client)
    a = _view(client)["assets"][0]
    (_root(settings) / a["local_path"]).unlink()
    v = _view(client)
    b = next(x for x in v["assets"] if x["asset_id"] == a["asset_id"])
    assert b["image"] == "missing" and b["problem"] == "image file missing"
    assert "applied_image_problem" in _g3(v)[1]
    r = _apply(client)
    assert r.status_code == 200 and r.json()["result"]["status"] == "images_restored"
    assert r.json()["result"]["images_restored"] == [a["asset_id"]]


def test_the_engine_calls_never_include_force_or_replace_flags(client, imported, settings):
    _select_all(client, imported)
    _apply(client)
    lines = (_root(settings) / "visuals-calls.jsonl").read_text().splitlines()
    for argv in (json.loads(x)["argv"] for x in lines):
        commands.assert_allowlisted(argv)
    assert {"visuals-edit", "visuals-apply"} <= set(_calls(settings))


# --------------------------------------------------------------------------- review fixes


@pytest.mark.parametrize(
    "body",
    [
        {"dry_run": "false"},
        {"dry_run": 0},
        {"expected_revision": None},
    ],
)
def test_review_the_edit_envelope_is_strict(client, acquired, settings, body):
    """FIX-05: a wrong JSON type in the envelope is refused, never coerced."""
    before = _writes(settings)
    req = {"expected_revision": _rev(client),
           "operations": [{"op": "shots.clear", "scene_id": "scene-001"}], **body}  # fmt: skip
    r = client.post(f"{API}/visuals/edit", json=req)
    assert r.status_code == 422, r.text
    assert _writes(settings) == before


@pytest.mark.parametrize("confirm", ["true", 1, "yes"])
def test_review_the_apply_envelope_is_strict(client, acquired, settings, confirm):
    before = _writes(settings)
    body = {"expected_revision": _rev(client), "reviewer": "Lan Nguyen", "confirm": confirm}
    r = client.post(f"{API}/visuals/apply", json=body)
    assert r.status_code == 422, r.text
    body = {**body, "reviewer": 7, "confirm": True}
    assert client.post(f"{API}/visuals/apply", json=body).status_code == 422
    assert _writes(settings) == before


def test_review_a_generic_not_ready_keeps_the_engine_items(client, imported, fake_cli):
    _select_all(client, imported)
    fake_cli.env["FAKE_MODE"] = "visuals_apply_not_ready_errors"
    r = _apply(client)
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_ready"
    assert r.json()["error"]["details"]["errors"] == [
        "scene-002: candidate scene-002-cm-0123456789 is rejected and cannot be used"
    ]


# --------------------------------------------------------------------------- engine support


def test_the_view_reports_editing_from_the_engine_itself(client, acquired):
    v = _view(client)
    assert v["editing"]["supported"] is True and v["editing"]["reason"] is None
    caps = client.get("/api/v1/system/engine").json()["capabilities"]
    assert {"visuals-edit", "visuals-apply"} <= set(caps)


def test_an_engine_without_visuals_editing_says_so_and_refuses_before_running(
    fake_cli, client, settings
):
    """An engine before D-123 (no visuals-edit or visuals-apply in ``ytagent --help``): the
    view says editing is not supported by this engine, the capability list is truthful, and
    edit and apply are refused before any engine command runs."""
    fake_cli.env["FAKE_MODE"] = "no_visuals_edit"
    assert client.post("/api/v1/projects", json=base.PROJECT).status_code == 201
    v = _view(client)
    assert v["editing"]["supported"] is False
    assert "not supported by this engine" in v["editing"]["reason"]
    assert "visuals-edit" in v["editing"]["reason"]
    caps = client.get("/api/v1/system/engine").json()["capabilities"]
    assert "visuals-edit" not in caps and "visuals-apply" not in caps and "visuals-state" in caps
    before = _writes(settings)
    r = _edit(client, {"op": "shots.clear", "scene_id": "scene-001"}, rev=v["revision"])
    assert r.status_code == 502 and r.json()["error"]["code"] == "engine_unsupported"
    r = _apply(client, rev=v["revision"])
    assert r.status_code == 502 and r.json()["error"]["code"] == "engine_unsupported"
    assert _writes(settings) == before


def test_help_is_allowlisted_only_alone():
    commands.assert_allowlisted(["--help"])
    with pytest.raises(commands.ArgumentError):
        commands.assert_allowlisted(["--help", "--project-root=/x"])


def test_unreadable_help_assumes_the_pinned_engine():
    """If ``--help`` cannot be read, the UI does not invent a limitation: it assumes the
    pinned engine, whose own refusals stay truthful."""
    import asyncio

    from app.engine.runner import EngineResult
    from app.engine.service import EngineService

    class Cli:
        cwd = Path("/x")

        async def run(self, argv, **_):
            return EngineResult(argv, 2, "", "error: boom", 0.1)

    svc = EngineService(Cli())  # type: ignore[arg-type]
    assert asyncio.run(svc.subcommands()) is None
    assert asyncio.run(svc.editing_support()) == (True, None)
