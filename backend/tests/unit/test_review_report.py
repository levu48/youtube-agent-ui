"""verify_report: a review token only for a well-formed report covering the files on disk."""

from __future__ import annotations

import copy

import pytest

from app.artifacts import engine_revision, record_digest, review_token, verify_report

H = {n: c * 64 for n, c in zip(("input.json", "outline.json", "script.json"), "abc", strict=True)}
H |= {"storyboard.draft.json": "d" * 64, "assets.json": None}


def good() -> dict:
    return {
        "ok": True,
        "approval_status": "not_approved",
        "artifacts": [
            {"path": "outline.json", "sha256": "b" * 64},
            {"path": "outline.md", "sha256": "e" * 64},
            {"path": "script.json", "sha256": "c" * 64},
            {"path": "storyboard.draft.json", "sha256": "d" * 64},
        ],
    }


def test_complete_report_is_accepted():
    assert verify_report(good(), H) is None


def _drop(path):
    def f(r):
        r["artifacts"] = [a for a in r["artifacts"] if a["path"] != path]

    return f


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (lambda r: r.update(ok=False), "did not pass"),
        (lambda r: r.update(ok="yes"), "did not pass"),
        (lambda r: r.update(approval_status="maybe"), "approval status"),
        (lambda r: r.pop("artifacts"), "no artifact list"),
        (lambda r: r.update(artifacts={}), "no artifact list"),
        (lambda r: r.update(artifacts=[]), "does not cover outline.json"),
        (_drop("script.json"), "does not cover script.json"),
        (_drop("storyboard.draft.json"), "does not cover storyboard.draft.json"),
        (lambda r: r["artifacts"].append("outline.json"), "malformed"),
        (lambda r: r["artifacts"].append({"sha256": "b" * 64}), "malformed"),
        (lambda r: r["artifacts"].append({"path": "outline.json", "sha256": "b" * 64}), "twice"),
        (lambda r: r["artifacts"][0].update(sha256="B" * 64), "no valid hash"),
        (lambda r: r["artifacts"][0].update(sha256=None), "no valid hash"),
        (lambda r: r["artifacts"][0].update(sha256="b" * 63), "no valid hash"),
        (lambda r: r["artifacts"][2].update(sha256="0" * 64), "script.json on disk differs"),
        (
            lambda r: r["artifacts"].append({"path": "assets.json", "sha256": "f" * 64}),
            "assets.json on disk differs",
        ),
    ],
)
def test_malformed_or_incomplete_reports_are_rejected(mutate, reason):
    r = copy.deepcopy(good())
    mutate(r)
    assert reason in (verify_report(r, H) or "")


@pytest.mark.parametrize("missing", ["input.json", "outline.json", "script.json"])
def test_missing_files_on_disk_are_rejected(missing):
    assert f"{missing} is missing" in (verify_report(good(), {**H, missing: None}) or "")


def test_non_dict_report():
    assert verify_report(None, H) and verify_report([], H)


def test_engine_revision_must_be_hex64():
    assert engine_revision({"revision": "a" * 64}) == "a" * 64
    for bad in (None, 5, "A" * 64, "a" * 63, "../" * 22):
        assert engine_revision({"revision": bad}) is None
    assert engine_revision("x") is None


def test_token_and_digest_are_stable_and_distinct():
    assert review_token(H) == review_token(dict(H)) != review_token({**H, "assets.json": "f" * 64})
    rec = {"reviewer": "A", "approved_at": "t", "artifacts": {"x": "1"}, "status": "approved"}
    assert record_digest(rec) == record_digest(dict(rec))
    assert record_digest(rec) != record_digest({**rec, "approved_at": "u"})
    assert record_digest(None) is None
