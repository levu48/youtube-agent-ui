"""Local-only request guards.

* Host header must be a loopback name (DNS-rebinding defence).
* State-changing requests need a per-process CSRF token in ``X-CSRF-Token`` (issued by
  ``GET /api/v1/session``); a custom header also forces a CORS preflight that foreign
  origins fail.
* If an ``Origin`` header is present on any API request (including SSE), it must be one of
  the configured loopback UI origins.
"""

from __future__ import annotations

import hmac
import secrets

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.errors import envelope

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
CSRF_HEADER = "x-csrf-token"


def new_token() -> str:
    return secrets.token_urlsafe(32)


class LocalGuardMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, *, allowed_hosts: list[str], origins: list[str], token: str):
        super().__init__(app)
        self.allowed_hosts = {h.lower() for h in allowed_hosts}
        self.origins = set(origins)
        self.token = token

    async def dispatch(self, request: Request, call_next):
        host = (request.headers.get("host") or "").lower()
        hostname = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
        if hostname not in self.allowed_hosts:
            return JSONResponse(envelope("bad_host", "Invalid Host header."), status_code=400)
        origin = request.headers.get("origin")
        if origin is not None and origin not in self.origins:
            return JSONResponse(envelope("bad_origin", "Origin not allowed."), status_code=403)
        if request.method not in SAFE_METHODS and request.url.path.startswith("/api/"):
            sent = request.headers.get(CSRF_HEADER, "")
            if not hmac.compare_digest(sent, self.token):
                return JSONResponse(
                    envelope("csrf_failed", "Missing or invalid CSRF token. Reload the page."),
                    status_code=403,
                )
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Cache-Control", "no-store")
        return response
