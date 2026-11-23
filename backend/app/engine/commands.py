"""Allowlisted argv builders for the engine CLI.

Only these operations exist. Every free-text value is validated and passed as a single
``--option=value`` argv element, so a value can never be parsed as another flag, and argv is
never handed to a shell. Force/replace/paid options are not representable here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

LANGUAGES = ("en", "vi")
PROVIDERS = ("ollama", "fixture")
FROM_STAGES = ("outline", "script", "storyboard")
MIN_DURATION, MAX_DURATION = 60, 3600

FIELD_LIMITS = {
    "idea": (5, 2000),
    "audience": (0, 500),
    "tone": (0, 200),
    "guidance": (0, 4000),
    # Engine ReviewRecord limits (models.py): reviewer 1-200, comment <= 2000.
    "reviewer": (1, 200),
    "comment": (0, 2000),
}


class EngineOp(StrEnum):
    VERSION = "version"
    CREATE = "create"
    DRAFT = "draft"
    PRODUCTION_STATUS = "production-status"
    DRAFT_CHECK = "draft-check"
    DRAFT_APPROVE = "draft-approve"
    DRAFT_EDIT = "draft-edit"
    RESEARCH_CHECK = "research-check"
    RESEARCH_PLAN = "research-plan"
    RESEARCH_COLLECT = "research-collect"
    RESEARCH_ADD_URL = "research-add-url"
    RESEARCH_EDIT = "research-edit"
    RESEARCH_ADD_DOCUMENT = "research-add-document"
    NARRATION_ATTEST = "narration-attest"
    NARRATION_PROVENANCE_INIT = "narration-provenance-init"
    RESEARCH_APPROVE = "research-approve"
    RESEARCH_APPLY = "research-apply"
    RESEARCH_EXPORT = "research-export"


class ArgumentError(ValueError):
    """A value was rejected before reaching the engine."""


def clean_text(name: str, value: str | None, *, required: bool = False) -> str | None:
    if value is None or not value.strip():
        if required:
            raise ArgumentError(f"{name} is required")
        return None
    value = value.strip()
    if _CONTROL_RE.search(value):
        raise ArgumentError(f"{name} contains control characters")
    lo, hi = FIELD_LIMITS[name]
    if not lo <= len(value) <= hi:
        raise ArgumentError(f"{name} must be {lo}-{hi} characters")
    return value


def check_slug(slug: str) -> str:
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        raise ArgumentError("slug must match ^[a-z0-9][a-z0-9-]{0,62}$")
    return slug


def check_model(model: str) -> str:
    if not isinstance(model, str) or not MODEL_RE.fullmatch(model):
        raise ArgumentError("model name contains unsupported characters")
    return model


def _root(root: Path) -> str:
    if not isinstance(root, Path) or not root.is_absolute():
        raise ArgumentError("project root must be an absolute path")
    return f"--project-root={root}"


@dataclass(frozen=True)
class CreateSpec:
    idea: str
    language: str
    duration_seconds: int = 180
    audience: str | None = None
    tone: str | None = None
    guidance: str | None = None


def version_args() -> list[str]:
    return ["--version"]


def create_args(root: Path, spec: CreateSpec) -> list[str]:
    idea = clean_text("idea", spec.idea, required=True)
    if spec.language not in LANGUAGES:
        raise ArgumentError("language must be en or vi")
    if (
        isinstance(spec.duration_seconds, bool)
        or not isinstance(spec.duration_seconds, int)
        or not MIN_DURATION <= spec.duration_seconds <= MAX_DURATION
    ):
        raise ArgumentError("duration must be an integer 60-3600")
    argv = [
        EngineOp.CREATE.value,
        _root(root),
        f"--idea={idea}",
        f"--language={spec.language}",
        f"--duration={spec.duration_seconds}",
    ]
    for name, flag in (("audience", "--audience"), ("tone", "--tone"), ("guidance", "--guidance")):
        v = clean_text(name, getattr(spec, name))
        if v is not None:
            argv.append(f"{flag}={v}")
    argv.append("--draft-provider=none")
    return argv


def draft_args(root: Path, *, provider: str, model: str | None, from_stage: str) -> list[str]:
    if provider not in PROVIDERS:
        raise ArgumentError("provider must be ollama or fixture")
    if from_stage not in FROM_STAGES:
        raise ArgumentError("from_stage must be outline, script or storyboard")
    argv = [EngineOp.DRAFT.value, _root(root), f"--provider={provider}"]
    if provider == "ollama":
        if model is None:
            raise ArgumentError("model is required for the ollama provider")
        argv.append(f"--model={check_model(model)}")
    argv.append(f"--from-stage={from_stage}")
    return argv


def production_status_args(root: Path) -> list[str]:
    return [EngineOp.PRODUCTION_STATUS.value, _root(root), "--json"]


def draft_check_args(root: Path) -> list[str]:
    return [EngineOp.DRAFT_CHECK.value, _root(root), "--json"]


def draft_approve_args(
    root: Path,
    *,
    reviewer: str,
    comment: str | None = None,
    expect_revision: str | None = None,
) -> list[str]:
    """G1 approval. ``--reviewer`` is always explicit: the engine would otherwise fall back to
    ``$YTA_REVIEWER`` or the OS user name.

    With ``expect_revision`` (engines that report a draft ``revision``), the engine itself
    refuses the approval unless its locked snapshot is still at that revision, and answers
    in JSON."""
    name = clean_text("reviewer", reviewer, required=True) or ""
    if any(ch in name for ch in "\r\n\t"):
        raise ArgumentError("reviewer must be a single line")
    argv = [EngineOp.DRAFT_APPROVE.value, _root(root), f"--reviewer={name}"]
    note = clean_text("comment", comment)
    if note is not None:
        argv.append(f"--comment={note}")
    if expect_revision is not None:
        if not re.fullmatch(r"[0-9a-f]{64}", expect_revision):
            raise ArgumentError("expect_revision must be a 64-character hex revision")
        argv += [f"--expect-revision={expect_revision}", "--json"]
    return argv


REVISION_RE = re.compile(r"[0-9a-f]{64}")


def draft_edit_args(root: Path, *, expect_revision: str, dry_run: bool = False) -> list[str]:
    """Human edit of outline.json/script.json (engine D-117). The JSON patch goes on stdin,
    never on the command line; the engine refuses unless the draft is at ``expect_revision``."""
    if not isinstance(expect_revision, str) or not REVISION_RE.fullmatch(expect_revision):
        raise ArgumentError("expect_revision must be a 64-character hex revision")
    argv = [EngineOp.DRAFT_EDIT.value, _root(root), f"--expect-revision={expect_revision}"]
    argv.append("--json")
    if dry_run:
        argv.append("--dry-run")
    return argv


# ---------------------------------------------------------------------- research (M3)

CLAIM_ID_RE = re.compile(r"^clm-[a-z0-9-]{3,40}$")
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
HOST_RE = re.compile(rf"^(?=.{{1,253}}$){_LABEL}(?:\.{_LABEL})+$")
SEARCH_PROVIDERS = ("wikipedia", "fixture")
RESEARCH_LANGUAGES = ("vi", "en")
COLLECT_LIMITS = {"max_queries": (0, 50), "max_results_per_query": (0, 20), "max_pages": (0, 100)}
MAX_URL = 2000


def _revision(value: str) -> str:
    if not isinstance(value, str) or not REVISION_RE.fullmatch(value):
        raise ArgumentError("expect_revision must be a 64-character hex revision")
    return f"--expect-revision={value}"


def check_host(host: str) -> str:
    """A DNS host name (not an IP literal, not a single label such as localhost)."""
    import ipaddress

    if not isinstance(host, str) or not HOST_RE.fullmatch(host):
        raise ArgumentError(f"not a host name: {host!r}")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return host
    raise ArgumentError(f"IP addresses are not accepted as research hosts: {host!r}")


def url_host(url: str) -> str:
    """The host of an https URL accepted for research-add-url (validated, lower-case)."""
    from urllib.parse import urlsplit

    if (
        not isinstance(url, str)
        or len(url) > MAX_URL
        or _CONTROL_RE.search(url)
        or any(ch.isspace() for ch in url)
    ):
        raise ArgumentError("the URL is too long or contains spaces or control characters")
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise ArgumentError("only https URLs without credentials are accepted")
    return check_host(parts.hostname.lower())


def research_check_args(root: Path) -> list[str]:
    return [EngineOp.RESEARCH_CHECK.value, _root(root), "--json"]


def research_plan_args(root: Path, *, expect_revision: str) -> list[str]:
    """The claim inventory, without an LLM (``--claim-provider=none``) and without network."""
    return [
        EngineOp.RESEARCH_PLAN.value,
        _root(root),
        "--claim-provider=none",
        _revision(expect_revision),
        "--json",
    ]


def research_collect_args(
    root: Path,
    *,
    expect_revision: str,
    search_provider: str,
    languages: list[str],
    claim_ids: list[str],
    max_queries: int,
    max_results_per_query: int,
    max_pages: int,
    allow_hosts: list[str] | None = None,
    dry_run: bool = False,
) -> list[str]:
    """Search and fetch (engine D-118). Live network use needs one --allow-host per host the
    reviewer confirmed; the engine refuses every other host, on requests and redirects."""
    if search_provider not in SEARCH_PROVIDERS:
        raise ArgumentError("search provider must be wikipedia or fixture")
    langs = list(dict.fromkeys(languages))
    if not langs or any(x not in RESEARCH_LANGUAGES for x in langs):
        raise ArgumentError("languages must be vi and/or en")
    argv = [
        EngineOp.RESEARCH_COLLECT.value,
        _root(root),
        f"--search-provider={search_provider}",
        "--fetch=auto",
    ]
    if len(langs) == 1:  # both is the engine's default (--languages takes several values)
        argv.append(f"--languages={langs[0]}")
    for cid in dict.fromkeys(claim_ids):
        if not isinstance(cid, str) or not CLAIM_ID_RE.fullmatch(cid):
            raise ArgumentError(f"not a claim id: {cid!r}")
        argv.append(f"--claim={cid}")
    for name, value in (
        ("max_queries", max_queries),
        ("max_results_per_query", max_results_per_query),
        ("max_pages", max_pages),
    ):
        lo, hi = COLLECT_LIMITS[name]
        if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
            raise ArgumentError(f"{name} must be an integer {lo}-{hi}")
        argv.append(f"--{name.replace('_', '-')}={value}")
    for host in dict.fromkeys(allow_hosts or []):
        argv.append(f"--allow-host={check_host(host)}")
    argv += [_revision(expect_revision), "--json"]
    if dry_run:
        argv.append("--dry-run")
    return argv


def research_add_url_args(
    root: Path,
    *,
    expect_revision: str,
    url: str,
    claim_ids: list[str],
    fetch: str,
    allow_host: str | None = None,
) -> list[str]:
    """Add a researcher-chosen URL: queue it (no network) or fetch it now, confined to the
    URL's own host, which the reviewer confirmed."""
    host = url_host(url)
    if fetch not in ("queue", "live", "fixture"):
        raise ArgumentError("fetch must be queue or live")
    argv = [EngineOp.RESEARCH_ADD_URL.value, _root(root), f"--url={url}", f"--fetch={fetch}"]
    for cid in dict.fromkeys(claim_ids):
        if not isinstance(cid, str) or not CLAIM_ID_RE.fullmatch(cid):
            raise ArgumentError(f"not a claim id: {cid!r}")
        argv.append(f"--claim={cid}")
    if fetch == "live":
        if allow_host != host:
            raise ArgumentError("a live fetch must confirm exactly the URL's host")
        argv.append(f"--allow-host={host}")
    argv += [_revision(expect_revision), "--json"]
    return argv


def research_edit_args(root: Path, *, expect_revision: str, dry_run: bool = False) -> list[str]:
    """Claims, evidence, translations, decisions, completeness, rechecks and attestations as one
    publication (engine D-119/D-120); the JSON patch goes on stdin."""
    argv = [EngineOp.RESEARCH_EDIT.value, _root(root), _revision(expect_revision), "--json"]
    if dry_run:
        argv.append("--dry-run")
    return argv


DOC_ID_RE = re.compile(r"^doc-[0-9a-f]{16}$")
SEGMENT_ID_RE = re.compile(r"^seg-[0-9a-f]{16}$")
# Engine limits (D-120): research-add-document provenance fields.
DOCUMENT_FIELDS = {
    "title": (1, 300, True),
    "language": (2, 20, True),
    "citation": (1, 2000, True),
    "imported_by": (1, 200, True),
    "edition": (1, 200, False),
    "declared_url": (9, MAX_URL, False),
    "original_published_at": (1, 100, False),
    "license": (1, 200, False),
    "note": (1, 4000, False),
}


def research_add_document_args(
    root: Path, *, expect_revision: str, new_version_of: str | None = None, **fields: str | None
) -> list[str]:
    """Import an offline document (engine D-120): provenance as separate argv elements, the
    text on stdin. No network: a declared URL is stored as data and never fetched."""
    unknown = set(fields) - set(DOCUMENT_FIELDS)
    if unknown:
        raise ArgumentError(f"unknown document fields: {sorted(unknown)}")
    argv = [EngineOp.RESEARCH_ADD_DOCUMENT.value, _root(root)]
    for name, (lo, hi, required) in DOCUMENT_FIELDS.items():
        value = fields.get(name)
        if value is None or value == "":
            if required:
                raise ArgumentError(f"{name} is required")
            continue
        if not isinstance(value, str) or _CONTROL_RE.search(value) or not lo <= len(value) <= hi:
            raise ArgumentError(f"{name} must be {lo}-{hi} characters without control characters")
        if name == "declared_url":
            url_host(value)
        argv.append(f"--{name.replace('_', '-')}={value}")
    if new_version_of is not None:
        if not isinstance(new_version_of, str) or not DOC_ID_RE.fullmatch(new_version_of):
            raise ArgumentError("new_version_of must be a doc- source id")
        argv.append(f"--new-version-of={new_version_of}")
    argv += [_revision(expect_revision), "--json"]
    return argv


def narration_attest_args(
    root: Path, *, expect_revision: str, reviewer: str, statement: str, segment_ids: list[str]
) -> list[str]:
    """Attest rewritten fixture-derived sentences (engine D-120); the engine decides."""
    ids = list(dict.fromkeys(segment_ids))
    if not ids or len(ids) > 500:
        raise ArgumentError("give 1-500 segments")
    argv = [EngineOp.NARRATION_ATTEST.value, _root(root)]
    for sid in ids:
        if not isinstance(sid, str) or not SEGMENT_ID_RE.fullmatch(sid):
            raise ArgumentError(f"not a segment id: {sid!r}")
        argv.append(f"--segment={sid}")
    who = clean_text("reviewer", reviewer, required=True)
    if (
        not isinstance(statement, str)
        or _CONTROL_RE.search(statement)
        or not 1 <= len(statement.strip()) <= 4000
    ):
        raise ArgumentError("statement must be 1-4000 characters without control characters")
    argv += [
        f"--reviewer={who}",
        f"--statement={statement.strip()}",
        _revision(expect_revision),
        "--json",
    ]
    return argv


def narration_provenance_init_args(root: Path, *, expect_revision: str) -> list[str]:
    return [
        EngineOp.NARRATION_PROVENANCE_INIT.value,
        _root(root),
        _revision(expect_revision),
        "--json",
    ]


def research_approve_args(
    root: Path, *, expect_revision: str, reviewer: str, comment: str | None = None
) -> list[str]:
    """G2: a named reviewer's attestation of the exact research state they validated
    (``expect_revision``). The engine refuses unless that state is current and approvable,
    and G1 is current; ``real_person`` on the reviewer is the engine's to judge."""
    who = clean_text("reviewer", reviewer, required=True) or ""
    if any(ch in who for ch in "\r\n\t"):
        raise ArgumentError("reviewer must be a single line")
    argv = [EngineOp.RESEARCH_APPROVE.value, _root(root), f"--reviewer={who}"]
    note = clean_text("comment", comment)
    if note is not None:
        argv.append(f"--comment={note}")
    return [*argv, _revision(expect_revision), "--json"]


def research_apply_args(root: Path, *, expect_revision: str) -> list[str]:
    """Write the approved claim IDs to the draft's scenes (only ``claim_ids`` change)."""
    return [EngineOp.RESEARCH_APPLY.value, _root(root), _revision(expect_revision), "--json"]


def research_export_args(root: Path, *, expect_revision: str) -> list[str]:
    """Write sources.md, the citation plan and the report. Never ``--replace-output``: a
    hand-edited export is refused by the engine and left for the CLI."""
    return [EngineOp.RESEARCH_EXPORT.value, _root(root), _revision(expect_revision), "--json"]


ALLOWED_SUBCOMMANDS = frozenset(op.value for op in EngineOp if op is not EngineOp.VERSION)
FORBIDDEN_FLAGS = ("--force", "--replace-edits", "--replace-output", "--replace-plan", "--section")


def assert_allowlisted(argv: list[str]) -> None:
    """Last line of defence before spawning: shape check of a built argv."""
    if argv == ["--version"]:
        return
    if not argv or argv[0] not in ALLOWED_SUBCOMMANDS:
        raise ArgumentError("subcommand not allowlisted")
    for a in argv[1:]:
        if not a.startswith("--"):
            raise ArgumentError("positional engine arguments are not allowed")
        flag = a.split("=", 1)[0]
        if flag in FORBIDDEN_FLAGS:
            raise ArgumentError(f"{flag} is not allowed in this UI")
        if "\x00" in a:
            raise ArgumentError("NUL in argument")
