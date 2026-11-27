"""Visuals (M4 UI-A): the engine's ``visuals-state`` snapshot, kept current, and images read
by engine ID and expected content hash.

The engine is authoritative. This module never writes a project file. It keeps the latest
``visuals-state`` result per project and, before that result authorises anything (an image
read, a write's recovery and revision pre-checks), re-hashes every file the snapshot names in
``inputs`` and ``evidence_inputs``. Any difference runs ``visuals-state`` again, one run per
project at a time. Images are served only as the exact bytes verified against the hash of a
record in such a current snapshot.
"""

from __future__ import annotations

import asyncio
import errno
import hashlib
import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MAX_IMAGE_BYTES = 20 * 1024 * 1024  # the engine's decode limit
MAX_PIXELS = 40_000_000  # the engine's 40 megapixels
MAX_RECORD_BYTES = 50 * 1024 * 1024
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
CANDIDATE_PATH = re.compile(r"^render/visuals/candidates/([0-9a-f]{64})\.(png|jpg)$")
ASSET_PATH = re.compile(r"^assets/images/([0-9a-f]{64})\.(png|jpg)$")
_OPEN_DIR = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | os.O_NOFOLLOW
_OPEN_FILE = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0)
_UNREADABLE = "unreadable"  # never equal to a SHA-256: a file that exists but cannot be read


class VisualsError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details or {}


# ---------------------------------------------------------------------- safe reads


def _parts(rel: str) -> list[str] | None:
    """The components of a lexically safe project-relative path, or None."""
    if (
        not isinstance(rel, str)
        or not rel
        or rel.startswith("/")
        or "\\" in rel
        or "\x00" in rel
        or "://" in rel
        or len(rel) > 1024
    ):
        return None
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return None
    return parts


def open_nofollow(root: Path, rel: str) -> int | None:
    """A read-only descriptor for ``root/rel``, opened one component at a time without
    following any symlink, so the result is inside the project. None when the path is unsafe
    or absent; raises ``OSError`` for anything else (a symlink, a directory, …)."""
    parts = _parts(rel)
    if parts is None:
        return None
    fd = os.open(root, _OPEN_DIR)
    try:
        for name in parts[:-1]:
            nxt = os.open(name, _OPEN_DIR, dir_fd=fd)
            os.close(fd)
            fd = nxt
        try:
            return os.open(parts[-1], _OPEN_FILE, dir_fd=fd)
        except FileNotFoundError:
            return None
    except FileNotFoundError:
        return None
    finally:
        os.close(fd)


def _hash_fd(fd: int, limit: int) -> str:
    h = hashlib.sha256()
    n = 0
    while chunk := os.read(fd, 1 << 20):
        n += len(chunk)
        if n > limit:
            raise OSError(errno.EFBIG, "file too large")
        h.update(chunk)
    return h.hexdigest()


MAX_STAT_ENTRIES = 4096  # small JSON records (inputs and evidence) across every project


@dataclass
class _StatCache:
    """SHA-256 per file, keyed by its stat identity, so an unchanged file is not re-read.
    Bounded: past ``MAX_STAT_ENTRIES`` the oldest entries are dropped (a miss only re-hashes)."""

    entries: dict[tuple[str, str], tuple[tuple, str]] = field(default_factory=dict)

    def sha(self, root: Path, rel: str, *, limit: int = MAX_RECORD_BYTES) -> str | None:
        """None when absent (or lexically unsafe); ``unreadable`` for a file that exists but
        is not a regular, readable file inside the project (a symlink, a directory, …)."""
        try:
            fd = open_nofollow(root, rel)
        except OSError:
            return _UNREADABLE
        if fd is None:
            return None
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                return _UNREADABLE
            key = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
            hit = self.entries.get((str(root), rel))
            if hit and hit[0] == key:
                return hit[1]
            digest = _hash_fd(fd, limit)
        except OSError:
            return _UNREADABLE
        finally:
            os.close(fd)
        self.entries.pop((str(root), rel), None)
        self.entries[(str(root), rel)] = (key, digest)
        while len(self.entries) > MAX_STAT_ENTRIES:
            self.entries.pop(next(iter(self.entries)))
        return digest


def evidence_sha(cache: _StatCache, root: Path, reference: str) -> str | None:
    """The engine's evidence reading (``rights.evidence_file_sha``) with this UI's stricter
    containment: a relative path inside the project, no symlink, a regular file. A URL is
    never fetched (None), and so is anything refused."""
    ref = reference.strip() if isinstance(reference, str) else ""
    if ref.lower().startswith(("http://", "https://")) or _parts(ref) is None:
        return None
    digest = cache.sha(root, ref)
    return None if digest == _UNREADABLE else digest


# ---------------------------------------------------------------------- snapshots


@dataclass
class _Entry:
    root: Path
    data: dict[str, Any]


class Snapshots:
    """The latest engine ``visuals-state`` per project, re-validated before each use."""

    def __init__(self, engine) -> None:
        self.engine = engine
        self._entries: dict[str, _Entry] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._stats = _StatCache()
        self.runs = 0  # engine visuals-state runs (tests)

    def _lock(self, project_id: str) -> asyncio.Lock:
        return self._locks.setdefault(project_id, asyncio.Lock())

    def invalidate(self, project_id: str) -> None:
        self._entries.pop(project_id, None)

    def _current(self, entry: _Entry) -> bool:
        data = entry.data
        for rel, want in (data.get("inputs") or {}).items():
            if self._stats.sha(entry.root, rel) != want:
                return False
        for ref, want in (data.get("evidence_inputs") or {}).items():
            if evidence_sha(self._stats, entry.root, ref) != want:
                return False
        return True

    async def _run(self, project_id: str, root: Path) -> dict[str, Any]:
        self.runs += 1
        data = await self.engine.visuals_state(root)
        self._entries[project_id] = _Entry(root, data)
        return data

    async def fresh(self, project_id: str, root: Path) -> dict[str, Any]:
        """Run ``visuals-state`` now (the Check action, and after every write)."""
        async with self._lock(project_id):
            return await self._run(project_id, root)

    async def current(self, project_id: str, root: Path) -> dict[str, Any]:
        """The kept snapshot if every file it was built from is unchanged; otherwise a new
        one. Single-flight: concurrent callers for one project wait for the same run."""
        async with self._lock(project_id):
            entry = self._entries.get(project_id)
            if (
                entry is not None
                and entry.root == root
                and await asyncio.to_thread(self._current, entry)
            ):
                return entry.data
            return await self._run(project_id, root)


# ---------------------------------------------------------------------- snapshot lookups


def candidate_record(snapshot: dict, candidate_id: str) -> dict | None:
    for items in (snapshot.get("candidates") or {}).values():
        for c in items or []:
            if isinstance(c, dict) and c.get("id") == candidate_id:
                return c
    return None


def asset_record(snapshot: dict, asset_id: str) -> dict | None:
    for a in snapshot.get("assets") or []:
        if isinstance(a, dict) and a.get("asset_id") == asset_id:
            return a
    return None


def scene_narrations(snapshot: dict, root: Path) -> dict[str, str]:
    """Scene narrations from ``storyboard.draft.json``, only when its bytes are the ones the
    snapshot was built from (so they are part of the same moment)."""
    import json

    want = (snapshot.get("inputs") or {}).get("storyboard.draft.json")
    if not want:
        return {}
    try:
        fd = open_nofollow(root, "storyboard.draft.json")
    except OSError:
        return {}
    if fd is None:
        return {}
    try:
        with os.fdopen(fd, "rb") as fh:
            data = fh.read(MAX_RECORD_BYTES + 1)
    except OSError:
        return {}
    if hashlib.sha256(data).hexdigest() != want:
        return {}
    try:
        doc = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {}
    out = {}
    for sc in doc.get("scenes") or [] if isinstance(doc, dict) else []:
        if isinstance(sc, dict) and isinstance(sc.get("id"), str):
            out[sc["id"]] = str(sc.get("narration") or "")
    return out


# ---------------------------------------------------------------------- image bytes

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def sniff(data: bytes) -> str | None:
    """The still-image format by magic bytes (the engine's accepted imports)."""
    if data.startswith(PNG_MAGIC):
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    return None


_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def dimensions(data: bytes, fmt: str) -> tuple[int, int] | None:
    """Width and height from a PNG or JPEG header, without decoding the image."""
    if fmt == "png":
        if len(data) < 24 or data[12:16] != b"IHDR":
            return None
        return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if fmt != "jpg":
        return None
    i, n = 2, len(data)
    for _ in range(10_000):
        while i < n and data[i] != 0xFF:
            i += 1
        while i < n and data[i] == 0xFF:
            i += 1
        if i >= n:
            return None
        marker = data[i]
        i += 1
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            continue
        if marker in (0xD9, 0xDA) or i + 2 > n:
            return None
        length = int.from_bytes(data[i : i + 2], "big")
        if length < 2:
            return None
        if marker in _SOF:
            if i + 7 > n:
                return None
            h = int.from_bytes(data[i + 3 : i + 5], "big")
            w = int.from_bytes(data[i + 5 : i + 7], "big")
            return w, h
        i += length
    return None


def read_verified(
    root: Path, rel: str, expected: str, pattern: re.Pattern[str]
) -> tuple[bytes, str]:
    """The exact bytes of a content-addressed image, verified: the path has the expected shape
    and names ``expected``, every component is opened without following a symlink, the file is
    regular and at most 20 MB, its bytes hash to ``expected``, and its magic bytes and header
    dimensions are a PNG or JPEG of at most 40 megapixels matching the extension."""
    m = pattern.fullmatch(rel or "")
    if m is None or m.group(1) != expected:
        raise VisualsError(409, "image_integrity", "The image record does not name its file.")
    ext = m.group(2)
    try:
        fd = open_nofollow(root, rel)
    except OSError:
        fd = -1
    if fd is None:
        raise VisualsError(409, "image_integrity", "The image file is missing.", {"path": rel})
    if fd < 0:
        raise VisualsError(
            409, "image_integrity", "The image file is not a regular file.", {"path": rel}
        )
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_IMAGE_BYTES:
            raise VisualsError(
                409, "image_integrity", "The image file is not a regular file of at most 20 MB."
            )
        chunks, total = [], 0
        while chunk := os.read(fd, 1 << 20):
            total += len(chunk)
            if total > MAX_IMAGE_BYTES:
                raise VisualsError(409, "image_integrity", "The image file is larger than 20 MB.")
            chunks.append(chunk)
    except OSError:
        raise VisualsError(409, "image_integrity", "The image file cannot be read.") from None
    finally:
        os.close(fd)
    data = b"".join(chunks)
    if hashlib.sha256(data).hexdigest() != expected:
        raise VisualsError(
            409,
            "image_integrity",
            "The image file's bytes do not match its recorded hash.",
            {"path": rel},
        )
    fmt = sniff(data)
    if fmt not in ("png", "jpg") or fmt != ext:
        raise VisualsError(
            409, "image_integrity", "The image is not the PNG or JPEG its name says."
        )
    dims = dimensions(data, fmt)
    if dims is None or dims[0] <= 0 or dims[1] <= 0 or dims[0] * dims[1] > MAX_PIXELS:
        raise VisualsError(409, "image_integrity", "The image header is invalid or too large.")
    return data, "image/png" if fmt == "png" else "image/jpeg"
