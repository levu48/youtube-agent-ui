"""Engine exit-code classification and diagnostic redaction."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

# Verified against youtube-agent src/youtube_agent/errors.py (see docs/engine-compatibility.md).
EXIT_CODES: dict[int, tuple[str, str]] = {
    0: ("ok", "Success"),
    1: ("engine_unexpected", "Unexpected engine failure"),
    2: ("engine_invalid_input", "Invalid input or protected human edits"),
    3: ("engine_error_3", "Engine error (code 3)"),
    4: ("engine_error_4", "Engine error (code 4)"),
    5: ("engine_error_5", "Engine error (code 5)"),
    6: ("engine_error_6", "Engine error (code 6)"),
    7: ("provider_unavailable", "Provider or model unavailable"),
    8: ("engine_error_8", "Engine error (code 8)"),
    9: ("engine_conflict", "Another engine run is using this project"),
    10: ("llm_failure", "LLM generation failed"),
    11: ("needs_visuals", "Scenes need visuals"),
    12: ("approval_missing", "Approval missing or stale"),
    13: ("engine_error_13", "Engine error (code 13)"),
    14: ("research_not_ready", "Research not ready"),
    15: ("partial_search_failure", "Some searches failed (the rest was saved)"),
    16: ("human_gate", "Stopped at a human review gate"),
    130: ("interrupted", "Interrupted"),
}

# Expected workflow stops rather than application errors.
EXPECTED_GATES = frozenset({16})


@dataclass(frozen=True)
class Classification:
    code: str
    summary: str
    expected_gate: bool


def classify(exit_code: int | None) -> Classification:
    if exit_code is None:
        return Classification("engine_unknown", "Engine did not report an exit code", False)
    if exit_code < 0:
        return Classification("terminated", f"Engine terminated by signal {-exit_code}", False)
    code, summary = EXIT_CODES.get(exit_code, (f"engine_error_{exit_code}", "Engine error"))
    return Classification(code, summary, exit_code in EXPECTED_GATES)


_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_SECRET_RES = [
    re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"(?i)\b(api[_-]?key|token|secret|password|passwd)\b(\s*[=:]\s*)\S+"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{10,}"),
    re.compile(r"(https?://)[^/\s:@]+:[^/\s@]+@"),
]
MAX_DIAGNOSTIC = 4000


def redact(text: str, *, limit: int = MAX_DIAGNOSTIC) -> str:
    """Strip ANSI codes, mask credentials, shorten home paths and bound the length."""
    if not text:
        return ""
    text = _ANSI_RE.sub("", text)
    text = _SECRET_RES[0].sub(r"\1 [REDACTED]", text)
    text = _SECRET_RES[1].sub(r"\1\2[REDACTED]", text)
    text = _SECRET_RES[2].sub("[REDACTED]", text)
    text = _SECRET_RES[3].sub(r"\1[REDACTED]@", text)
    home = os.path.expanduser("~")
    if home and home != "/":
        text = text.replace(home, "~")
    if len(text) > limit:
        text = text[:limit] + f"… [truncated {len(text) - limit} chars]"
    return text


def engine_error_line(stderr: str) -> str | None:
    """The engine's own ``error: …`` message, if it printed one."""
    for line in reversed(stderr.splitlines()):
        s = line.strip()
        if s.startswith("error:"):
            return redact(s[len("error:") :].strip(), limit=1000)
        if s == "interrupted":
            return "interrupted"
    return None
