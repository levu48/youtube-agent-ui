"""M4 maintenance: findings of the retrospective review of UI PRs #16-#18.

16-01 an empty engine error message never crashes the error mapping; 16-02 no file byte is
accepted before the import's fields and revision are checked; 16-03 an upload is received
without holding the project, and the project is checked again once held; 16-04 the stat
cache is bounded; 16-05 the narration read runs off the event loop.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import visuals as V
from app.api import visuals_routes as VR
from app.engine.runner import EngineResult
from tests.fake_visuals import png
from tests.unit import test_visuals_api as base
from tests.unit.test_visuals_api import API, _rev, _root, _upload, _writes

settings = base.settings
drafted = base.drafted
planned = base.planned


# --------------------------------------------------------------------------- 16-01


@pytest.mark.parametrize(
    ("stdout", "stderr"),
    [
        (json.dumps({"ok": False, "error": {"code": "error", "exit_code": 2}}), ""),
        (json.dumps({"ok": False, "error": {"code": "error", "exit_code": 2, "message": ""}}), ""),
        (json.dumps({"ok": False, "error": {"code": "invalid_input", "message": "  \n \n"}}), ""),
        (json.dumps({"ok": False, "error": {"code": "image_integrity", "message": None}}), ""),
        ("", ""),
        ("not json", "   "),
    ],
)
def test_review_an_empty_engine_message_maps_to_an_error_not_a_crash(stdout, stderr):
    res = EngineResult(["visuals-import"], 2, stdout, stderr, 0.1)
    e = VR._visuals_failure(res, "import the image")
    assert 400 <= e.status < 600 and e.code
    assert isinstance(e.message, str) and e.message.strip()


def test_review_the_first_nonblank_line_is_used():
    assert VR._first_line("\n  \nerror: the real reason\nmore") == "the real reason"
    assert VR._first_line("") == "" and VR._first_line(" \n\t") == ""


# --------------------------------------------------------------------------- 16-02


def _multipart(boundary: str, fields: dict[str, str], data: bytes) -> bytes:
    out = b""
    for k, v in fields.items():
        out += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'
        ).encode()
    out += (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n'
        "Content-Type: image/png\r\n\r\n"
    ).encode()
    return out + data + f"\r\n--{boundary}--\r\n".encode()


def test_review_file_bytes_in_the_same_chunk_are_held_until_the_gate_opens():
    """Fields and the whole image in one network chunk: the parser sees the image bytes, but
    none is accepted as the image before the fields are validated."""
    data = png(64, 36, (1, 2, 3))
    body = _multipart("b0und", {"expected_revision": "a" * 64, "scene_id": "scene-001"}, data)
    up = VR._Upload(b"b0und")
    up.parser.write(body)  # one chunk
    up.parser.finalize()
    assert up.ready and up.fields["scene_id"] == "scene-001"
    assert up.file == b"" and bytes(up.held) == data  # held, not accepted
    up.open_gate()
    assert bytes(up.file) == data and up.held == b""


def test_review_a_refused_upload_in_one_chunk_never_reaches_the_engine(client, planned, settings):
    """A stale revision with fields and image in one request body: refused before any file
    byte is accepted; no visuals-import runs."""
    before = _writes(settings)
    rev = _rev(client)
    p = _root(settings) / "visual-plan.json"
    p.write_text(p.read_text() + "\n")  # a CLI edit after the page loaded
    r = _upload(client, rev, png(640, 360, (9, 9, 9)))
    assert r.status_code == 409 and r.json()["error"]["code"] == "revision_conflict"
    assert _writes(settings) == before
    assert not (_root(settings) / "visuals-import-stdin.bin").exists()


def _feed(data: bytes, *, step: int | None = None, gate_after_headers: bool = True) -> VR._Upload:
    """Parse an upload whose file part is ``data``, in one chunk or in ``step``-byte chunks,
    opening the gate as the route does once the file part has started."""
    body = _multipart("b", {"x": "1"}, data)
    up = VR._Upload(b"b")
    chunks = [body] if step is None else [body[i : i + step] for i in range(0, len(body), step)]
    for chunk in chunks:
        up.parser.write(chunk)
        if up.error:
            break
        if gate_after_headers and up.ready and not up.gate_open:
            up.open_gate()
    return up


def _buffered(up: VR._Upload) -> int:
    return len(up.file) + len(up.held)


def test_review_an_image_exactly_at_the_limit_is_accepted():
    up = _feed(b"\x89PNG" + b"0" * (V.MAX_IMAGE_BYTES - 4))
    assert not up.error and len(up.file) == V.MAX_IMAGE_BYTES


def test_review_one_byte_over_is_refused_and_never_buffered_past_the_cap():
    up = _feed(b"\x89PNG" + b"0" * (V.MAX_IMAGE_BYTES - 3))
    assert up.error == "the image is larger than 20 MB"
    assert _buffered(up) <= V.MAX_IMAGE_BYTES


def test_review_a_single_oversized_chunk_is_refused_without_being_copied():
    """Fields and a 21 MB file in one chunk, before the gate opens: the file bytes are
    refused, not held."""
    up = _feed(b"0" * (V.MAX_IMAGE_BYTES + 1024 * 1024), gate_after_headers=False)
    assert up.error == "the image is larger than 20 MB"
    assert _buffered(up) == 0


def test_review_many_small_chunks_over_the_cap_are_refused_at_the_cap():
    up = _feed(b"0" * (V.MAX_IMAGE_BYTES + 200_000), step=64 * 1024)
    assert up.error == "the image is larger than 20 MB"
    assert _buffered(up) <= V.MAX_IMAGE_BYTES


def test_review_opening_the_gate_moves_the_held_bytes():
    up = VR._Upload(b"b")
    up.parser.write(_multipart("b", {"x": "1"}, b"\x89PNG" + b"0" * 1000))
    held = up.held
    up.open_gate()
    assert up.file is held and len(up.file) == 1004 and len(up.held) == 0  # moved, not copied


def test_review_an_oversized_upload_never_reaches_the_engine(client, planned, settings):
    from tests.unit.test_visuals_api import _calls

    data = b"\x89PNG\r\n\x1a\n" + b"\x00" * (V.MAX_IMAGE_BYTES + 10)
    r = _upload(client, _rev(client), data)
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"
    assert "visuals-import" not in _calls(settings)


# --------------------------------------------------------------------------- 16-03


def test_review_the_upload_is_received_without_holding_the_project(client, planned, monkeypatch):
    state = client.app.state.ctx
    real = VR._read_upload
    held_during_read: list[bool] = []

    async def reading(request, on_ready):
        out = await real(request, on_ready)
        held_during_read.append("hcm-demo" in state.jobs._reserved)
        return out

    monkeypatch.setattr(VR, "_read_upload", reading)
    r = _upload(client, _rev(client), png(640, 360, (10, 200, 30)))
    assert r.status_code == 200, r.text
    assert held_during_read == [False]
    assert "hcm-demo" not in state.jobs._reserved  # released afterwards


def test_review_a_change_during_the_upload_is_refused_once_held(
    client, planned, settings, monkeypatch
):
    """The revision passed when the file part started; the project changed while the bytes
    were arriving; the check made once the project is held refuses it before the engine."""
    real = VR._read_upload

    async def reading(request, on_ready):
        out = await real(request, on_ready)
        p = _root(settings) / "visual-plan.json"
        p.write_text(p.read_text() + "\n")  # the CLI, meanwhile
        return out

    monkeypatch.setattr(VR, "_read_upload", reading)
    before = _writes(settings)
    r = _upload(client, _rev(client), png(640, 360, (10, 200, 30)))
    assert r.status_code == 409 and r.json()["error"]["code"] == "revision_conflict"
    assert _writes(settings) == before


def test_review_a_project_held_by_a_job_refuses_the_import_after_the_upload(
    client, planned, settings, monkeypatch
):
    state = client.app.state.ctx
    real = VR._read_upload

    async def reading(request, on_ready):
        out = await real(request, on_ready)
        state.jobs._reserved.add("hcm-demo")  # another action took the project meanwhile
        return out

    monkeypatch.setattr(VR, "_read_upload", reading)
    before = _writes(settings)
    try:
        r = _upload(client, _rev(client), png(640, 360, (10, 200, 30)))
    finally:
        state.jobs._reserved.discard("hcm-demo")
    assert r.status_code == 409 and r.json()["error"]["code"] == "project_busy"
    assert _writes(settings) == before


# --------------------------------------------------------------------------- 16-04


def test_review_the_stat_cache_is_bounded(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(V, "MAX_STAT_ENTRIES", 5)
    cache = V._StatCache()
    for i in range(12):
        (tmp_path / f"f{i}.json").write_text(str(i))
        assert cache.sha(tmp_path, f"f{i}.json") is not None
    assert len(cache.entries) == 5
    assert (str(tmp_path), "f11.json") in cache.entries  # the newest are kept
    assert (str(tmp_path), "f0.json") not in cache.entries


# --------------------------------------------------------------------------- 16-05


def test_review_the_narration_read_runs_in_a_worker_thread(client, drafted, monkeypatch):
    """The storyboard read is handed to ``asyncio.to_thread``, never run on the event loop."""
    import asyncio

    offloaded: list[object] = []
    real = asyncio.to_thread

    async def recording(func, /, *args, **kwargs):
        offloaded.append(func)
        return await real(func, *args, **kwargs)

    monkeypatch.setattr(VR.asyncio, "to_thread", recording)
    r = client.get(f"{API}/visuals")
    assert r.status_code == 200 and r.json()["narration"]
    assert V.scene_narrations in offloaded
