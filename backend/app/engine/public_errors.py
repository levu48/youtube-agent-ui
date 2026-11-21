"""Translate engine failures into stable, sanitized public errors.

Raw exception strings never reach API clients: they can contain server paths or library
internals. Clients get a stable ``code`` and a fixed (or engine-authored, redacted) message;
diagnostics are logged server-side.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from app.engine.errors import redact
from app.engine.runner import EngineUnavailable

log = logging.getLogger("ytagent_ui.engine")

MAX_ENGINE_MESSAGE = 300


@dataclass(frozen=True)
class PublicError:
    status: int
    code: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


FIXED = {
    "engine_unavailable": (
        503,
        "The youtube-agent engine could not be started. Check the engine setup "
        "(YTA_ENGINE_REPO and `uv sync` in the engine repository).",
    ),
    "engine_timeout": (504, "The engine did not respond in time. Try again."),
    "engine_bad_json": (502, "The engine returned output the UI could not read."),
    "internal_error": (500, "Unexpected error while running the engine. See the backend log."),
}


def _fixed(code: str) -> PublicError:
    status, message = FIXED[code]
    return PublicError(status, code, message)


def to_public(exc: BaseException, *, operation: str) -> PublicError:
    """Map an exception raised while running an engine command to a public error."""
    # Imported here to avoid a cycle (service imports this module's users).
    from app.engine.service import EngineReadError

    if isinstance(exc, EngineUnavailable):
        log.warning("%s: engine unavailable: %s", operation, redact(str(exc)))
        return _fixed("engine_unavailable")
    if isinstance(exc, EngineReadError):
        log.warning(
            "%s: engine error %s: %s | %s", operation, exc.code, exc.message, exc.diagnostic
        )
        if exc.code in FIXED:
            return _fixed(exc.code)
        msg = redact(exc.message, limit=MAX_ENGINE_MESSAGE).splitlines()[0] if exc.message else ""
        return PublicError(502, exc.code, f"The engine reported an error: {msg}".rstrip(": "))
    log.error("%s: unexpected error", operation, exc_info=exc)
    return _fixed("internal_error")
