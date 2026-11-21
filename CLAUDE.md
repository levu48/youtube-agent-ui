# Instructions for Claude Code

You are implementing `youtube-agent-ui`, a new standalone repository. Read all `docs/*.md` and `docs/milestones/*.md` before writing code. Follow `docs/ui-design.md` as the visual and interaction contract for Milestone 1.

## Non-negotiable boundaries
- `youtube-agent` is a separate, authoritative Python engine. Do not edit its source, database, artifacts, locks, caches, approval files, or state directly. UI may read documented generated artifacts safely and invoke supported CLI commands.
- Prefer `ytagent` via `uv run ytagent` in the engine repo; legacy `youtube-agent` is an alias. Verify against the installed engine rather than trusting this document blindly.
- Local Mac only; bind services to `127.0.0.1`; no cloud dependency, user accounts, paid provider, or publishing in M1.
- No `shell=True`, no user-supplied executable/command/path, no force/replace flags in M1. Use allowlisted argument arrays.
- UI state is not authoritative for engine stages or editorial gates. Display genuine statuses, errors and logs; never fabricate progress percentages.
- Keep work on a feature branch, commit in coherent units, run tests, and prepare a draft PR. Never auto-merge.

## Build order
1. Verify CLI flags, JSON response shapes, exit codes, and engine project artifact paths from sibling repo; record findings in `docs/engine-compatibility.md`.
2. Scaffold Next.js frontend and FastAPI backend, configuration and tests.
3. Implement safe engine adapter, SQLite repositories, project APIs.
4. Implement durable background jobs, SSE and cancellation/recovery.
5. Implement dashboard, project creation, draft job, read-only draft viewer.
6. Run unit/integration/E2E tests and document setup.

## Key acceptance test
With a running Ollama and qwen3:8b, user can create a project in browser, generate a draft, observe live logs, view outline and script, and use the same project from the original CLI. Offline CI must use fixture provider and not require Ollama.
