"""Backend configuration.

All paths are configured by the operator (environment / ``.env``), never by the browser.
Settings are validated once at startup; malformed settings stop the server with a clear
message, while an engine that merely cannot run yet is reported through ``/system/engine``.
"""

from __future__ import annotations

import ipaddress
import os
import shutil
from functools import cached_property
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
_UV_FALLBACKS = ("/opt/homebrew/bin/uv", "/usr/local/bin/uv", "~/.local/bin/uv", "~/.cargo/bin/uv")


def _expand(p: Path) -> Path:
    return Path(os.path.expanduser(str(p)))


def is_loopback_host(host: str | None) -> bool:
    if not host:
        return False
    if host in LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="YTA_", env_file=".env", extra="ignore")

    engine_repo: Path = Field(default=Path("~/dev/youtube-agent"))
    projects_root: Path = Field(default=Path("~/Documents/YouTubeAgent/projects"))
    data_dir: Path = Field(default=Path("~/Library/Application Support/youtube-agent-ui"))
    uv_path: Path | None = None
    ollama_base_url: str = "http://127.0.0.1:11434"
    ui_origins: list[str] = Field(default=["http://127.0.0.1:3000", "http://localhost:3000"])
    allowed_hosts: list[str] = Field(default=["127.0.0.1", "localhost"])
    default_model: str = "qwen3:8b"
    # The offline fixture provider writes placeholder text. It is for tests and demos only,
    # so it is hidden unless explicitly enabled.
    allow_fixture_provider: bool = False
    read_timeout_seconds: float = 60.0
    cancel_grace_seconds: float = 10.0

    @field_validator("engine_repo", "projects_root", "data_dir", mode="after")
    @classmethod
    def _absolute(cls, v: Path) -> Path:
        v = _expand(v)
        if not v.is_absolute():
            raise ValueError(f"must be an absolute path, got {v}")
        return v

    @field_validator("uv_path", mode="after")
    @classmethod
    def _uv_absolute(cls, v: Path | None) -> Path | None:
        if v is None:
            return None
        v = _expand(v)
        if not v.is_absolute():
            raise ValueError("YTA_UV_PATH must be an absolute path")
        return v

    @field_validator("ollama_base_url")
    @classmethod
    def _ollama_loopback(cls, v: str) -> str:
        parts = urlsplit(v)
        if parts.scheme not in ("http", "https") or not is_loopback_host(parts.hostname):
            raise ValueError("YTA_OLLAMA_BASE_URL must be an http(s) URL on a loopback host")
        if parts.username or parts.password:
            raise ValueError("YTA_OLLAMA_BASE_URL must not contain credentials")
        return v.rstrip("/")

    @field_validator("ui_origins")
    @classmethod
    def _origins_loopback(cls, v: list[str]) -> list[str]:
        for origin in v:
            parts = urlsplit(origin)
            if parts.scheme != "http" or not is_loopback_host(parts.hostname) or parts.path:
                raise ValueError(f"UI origin must be http://<loopback>:<port>, got {origin!r}")
        return v

    @model_validator(mode="after")
    def _roots_disjoint(self) -> Settings:
        projects = self.projects_root.resolve(strict=False)
        engine = self.engine_repo.resolve(strict=False)
        ui_repo = Path(__file__).resolve().parents[2]
        for repo in (engine, ui_repo):
            if projects == repo or projects.is_relative_to(repo):
                raise ValueError(
                    f"YTA_PROJECTS_ROOT ({projects}) must be outside source repositories ({repo})"
                )
        return self

    # ---------------------------------------------------------------- derived values

    @cached_property
    def projects_root_real(self) -> Path:
        """Canonical projects root (created on first use)."""
        self.projects_root.mkdir(parents=True, exist_ok=True)
        return self.projects_root.resolve(strict=True)

    @cached_property
    def db_path(self) -> Path:
        return self.data_dir / "ui.sqlite3"

    @cached_property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    def resolve_uv(self) -> Path | None:
        """The ``uv`` executable: configured path, else PATH, else common install locations."""
        candidates: list[str | Path] = []
        if self.uv_path is not None:
            candidates.append(self.uv_path)
        else:
            found = shutil.which("uv")
            if found:
                candidates.append(found)
            candidates.extend(_expand(Path(p)) for p in _UV_FALLBACKS)
        for c in candidates:
            p = Path(c)
            if p.is_absolute() and p.is_file() and os.access(p, os.X_OK):
                return p.resolve()
        return None

    def prepare_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        _ = self.projects_root_real


def home_relative(path: Path | str) -> str:
    """Display form of a server path: ``~`` instead of the home directory."""
    s = str(path)
    home = os.path.expanduser("~")
    return "~" + s[len(home) :] if s == home or s.startswith(home + os.sep) else s
