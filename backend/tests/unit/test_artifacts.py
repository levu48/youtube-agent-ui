import json
import os

from app.artifacts import MAX_ARTIFACT_BYTES, read_draft


def _write(root, name, data):
    p = root / name
    if isinstance(data, bytes):
        p.write_bytes(data)
    else:
        p.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")


def test_missing(tmp_path):
    out = read_draft(tmp_path)
    assert out["available"] is False
    assert out["outline"]["state"] == "missing" and out["script"]["state"] == "missing"


def test_valid_vietnamese(tmp_path):
    _write(
        tmp_path,
        "outline.json",
        {
            "title": "Bản nháp",
            "sections": [{"id": "sec-01", "heading": "Câu hỏi đặt ra", "key_points": ["Ý chính"]}],
        },
    )
    _write(
        tmp_path,
        "script.json",
        {
            "title": "Bản nháp",
            "sections": [
                {
                    "outline_section_id": "sec-01",
                    "heading": "Câu hỏi",
                    "narration": "Đây là lời dẫn.",
                    "review_flags": [{"kind": "source_needed", "excerpt": "Năm 1945", "note": "n"}],
                }
            ],
        },
    )
    _write(tmp_path, "script.md", "# Bản nháp\n")
    out = read_draft(tmp_path)
    assert out["available"]
    assert out["outline"]["data"]["sections"][0]["heading"] == "Câu hỏi đặt ra"
    assert out["script"]["data"]["sections"][0]["review_flags"][0]["excerpt"] == "Năm 1945"
    assert out["script"]["markdown"] == "# Bản nháp\n"


def test_malformed_json_and_encoding(tmp_path):
    _write(tmp_path, "outline.json", "{not json")
    _write(tmp_path, "script.json", b"\xff\xfe bad")
    out = read_draft(tmp_path)
    assert out["outline"]["state"] == "malformed"
    assert out["script"]["state"] == "malformed" and "UTF-8" in out["script"]["error"]
    assert out["available"] is False


def test_wrong_structure(tmp_path):
    _write(tmp_path, "outline.json", {"sections": [{"no_id": True}]})
    _write(tmp_path, "script.json", [1, 2, 3])
    out = read_draft(tmp_path)
    assert out["outline"]["state"] == "malformed" and out["script"]["state"] == "malformed"


def test_symlink_not_followed(tmp_path):
    secret = tmp_path / "secret.json"
    secret.write_text('{"title": "secret", "sections": []}')
    os.symlink(secret, tmp_path / "outline.json")
    assert read_draft(tmp_path)["outline"]["state"] == "malformed"


def test_size_limit(tmp_path):
    _write(tmp_path, "outline.json", "x" * (MAX_ARTIFACT_BYTES + 1))
    assert "limit" in read_draft(tmp_path)["outline"]["error"]


def test_draft_endpoint(client):
    from tests.conftest import PROJECT, wait_for

    client.post("/api/v1/projects", json=PROJECT)
    empty = client.get("/api/v1/projects/hcm-demo/draft").json()
    assert empty["available"] is False and empty["draft_check"]["ok"] is False
    job_id = client.post(
        "/api/v1/projects/hcm-demo/draft-jobs", json={"provider": "fixture"}
    ).json()["job_id"]
    wait_for(lambda: client.get(f"/api/v1/jobs/{job_id}").json()["status"] == "succeeded")
    full = client.get("/api/v1/projects/hcm-demo/draft").json()
    assert full["available"] and full["draft_check"]["ok"]
    assert full["script"]["data"]["sections"][0]["heading"] == "Câu hỏi đặt ra"
    assert full["draft_check"]["approval_status"] == "not_approved"
