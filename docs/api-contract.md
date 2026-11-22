# Proposed API Contract — v1

Base URL `http://127.0.0.1:8000/api/v1`. This is a **target contract**, not a claim of existing endpoints. JSON UTF-8; ISO-8601 UTC timestamps; consistent error envelope `{ "error": {"code": "...", "message": "...", "details": {}} }`. Never expose arbitrary server paths, shell commands or secrets.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | UI backend health |
| GET | `/system/engine` | Engine version/capability/availability |
| GET | `/system/ollama` | Local Ollama reachability/models |
| GET | `/projects` | Registered projects and current engine status summary |
| POST | `/projects` | Create engine project and register |
| GET | `/projects/{id}` | Project metadata |
| GET | `/projects/{id}/status` | Engine `production-status --json` |
| POST | `/projects/{id}/draft-jobs` | Queue draft job; 202 |
| GET | `/projects/{id}/draft` | Read-only outline/script artifacts |
| GET | `/projects/{id}/draft-check` | Engine `draft-check --json` |
| GET | `/jobs/{id}` | Job status and recent events |
| GET | `/jobs/{id}/events` | SSE stream with event IDs |
| POST | `/jobs/{id}/cancel` | Cancel queued/running job |

## Create project
`POST /projects`:
```json
{
  "slug": "hcm-demo",
  "idea": "Ho Chi Minh: Nationalist or Communist?",
  "language": "vi",
  "duration_seconds": 180,
  "audience": "General Vietnamese audience",
  "tone": "Balanced documentary",
  "guidance": "Distinguish evidence from interpretation"
}
```
Validate slug `^[a-z0-9][a-z0-9-]{0,62}$`, idea nonblank and bounded, language en/vi, duration 60–3600; bound all free-text fields. Return 201 on success, 409 on existing project, 422 on invalid input, 503 if engine unavailable. Engine command uses `create --draft-provider none` (verify exact syntax).

Response:
```json
{"id":"hcm-demo","status":"created","next_action":"generate_draft"}
```

## Draft job
`POST /projects/{id}/draft-jobs`:
```json
{"provider":"ollama","model":"qwen3:8b","from_stage":"outline"}
```
Allow `fixture` provider for offline tests; production UI defaults to `ollama`. Whitelist stages `outline`, `script`, `storyboard`. No force or replace options in M1. Response `202`:
```json
{"job_id":"<uuid>","project_id":"hcm-demo","status":"queued"}
```
Return 409 if a mutating job already exists for that project, 429/409 if global capacity reached (or queue with explicit queued status), and 503 if Ollama unavailable for Ollama jobs.

## Job representation
```json
{
 "id":"<uuid>", "project_id":"hcm-demo", "type":"draft",
 "status":"running", "started_at":"2026-11-20T16:00:00Z",
 "finished_at":null, "exit_code":null, "message":"Generating draft"
}
```
Statuses: `queued`, `running`, `succeeded`, `failed`, `cancelled`, `interrupted`. Engine stage statuses are distinct. Exit 16 may represent expected human gate, not generic failure; preserve the engine message.

## SSE
`GET /jobs/{id}/events`:
```text
id: 1
event: status
data: {"status":"running"}

id: 2
event: log
data: {"sequence":2,"message":"Starting draft generation"}

id: 3
event: completed
data: {"status":"succeeded","exit_code":0}
```
Support `Last-Event-ID` replay, keepalive, bounded backlog and polling fallback. Events should come from real process output or actual lifecycle transitions; don't synthesize percent complete.

## Draft viewer response
Prefer normalized validated fields while preserving the original structure. Include `{ "outline": ..., "script": ..., "available": true, "draft_check": ... }`. Do not expose file reads based on browser-supplied paths. Handle missing, malformed, or partially generated artifacts explicitly.

## Security and status codes
- 400 invalid state, 404 unknown ID, 409 conflict, 422 validation, 503 dependency unavailable, 500 unexpected.
- Mutations require same-origin/CSRF defense. Restrict CORS and Host to loopback origins.
- Engine errors should include a stable UI code plus a safely truncated/redacted engine diagnostic.
- OpenAPI generated from Pydantic schemas is the implementation source of truth once endpoints exist.

---

## Implemented v1 — additions and clarifications (M1)

The endpoints above are implemented. The OpenAPI document generated from the Pydantic schemas (`GET /api/openapi.json`) is now the source of truth. These were added for the UI design (`docs/ui-design.md`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/session` | Per-process CSRF token. Send it as `X-CSRF-Token` on every POST. |
| GET | `/system/config` | Display-safe config: projects root (with `~`), default language/model, enabled providers. |
| GET | `/projects/location-preview?slug=` | Server-derived location for a validated slug, and whether it is free. |
| GET | `/projects/discoverable` | Unregistered engine projects directly under the projects root. |
| POST | `/projects/register` | `{ "slug" }`: register one discovered project. |
| GET | `/projects/{id}/draft-available` | `{ "available": bool }` once `outline.json` and `script.json` are readable. |
| GET | `/jobs?project_id=&limit=` | Recent jobs, newest first. |
| GET | `/jobs/{id}/events/page?after=&limit=` | Cursor page of persisted events with `id > after` (limit ≤ 1000): `{job_id, status, events, next_after, has_more}`. Used to seed and to poll without gaps. |

Clarifications:
- `GET /projects` returns each project plus a `status` summary (`available`, `stages[]`, `current_stage`, `error`) taken from the engine's `production-status --json`. It is cached for up to 20 s and refreshed when a job finishes.
- `GET /projects/{id}/draft` returns `{available, outline: {state, error, data, markdown}, script: {…}, draft_check, draft_check_error}`, where `state` is `ok | missing | malformed`. When the check fails, `draft_check_error` is `{code, message}`: the same code and message that `GET /draft-check` returns in its error envelope.
- `GET /projects/{id}/draft-check` relays the engine report. The engine exits 2 when `ok` is false; that is still a valid report. Failures use stable codes with sanitized messages; raw exception text and engine stderr are logged server-side, never returned:

  | Code | HTTP | Cause |
  |---|---|---|
  | `engine_unavailable` | 503 | uv, the engine repo or its virtualenv cannot be started |
  | `engine_timeout` | 504 | the command exceeded the read timeout; its whole process group is terminated |
  | `engine_bad_json` | 502 | the output was not the expected JSON |
  | `engine_*` / engine codes | 502 | the engine exited with an error; its own `error:` line is passed on, redacted |
  | `internal_error` | 500 | unexpected backend error |
- The status summary from `/projects` and `/projects/{id}/status` adds an `error_code` with the same codes.
- Job objects also include `created_at`, `error_message`, `error_code` (a stable UI code such as `llm_failure`, `provider_unavailable`, `engine_conflict`, `human_gate`, `interrupted`), `cancel_requested`, `provider`, `model` and `from_stage`. `GET /jobs/{id}?events=N` includes the last N events.
- SSE event types: `status`, `log` (`{sequence, stream: stdout|stderr, message, ts}`), `log_truncated`, `cancel_requested`, `completed` (`{status, exit_code, message, error_message, error_code}`). Event ids are the persisted `job_events` row ids. Replay uses `Last-Event-ID` or `?after=`, in pages of 1000 until nothing is left, so a reconnect after any number of missed events is complete. Keepalive pings run every 15 s.
- `POST /jobs/{id}/cancel` returns `200` with `cancelled` for a queued job, `202` with `cancel_requested: true` for a running job (completion arrives as a `completed` event), and `409 job_finished` for a terminal job.
- Draft job errors: `409 job_conflict` (with `details.job_id`), `503 ollama_unavailable`, `422 model_not_installed`, and `422 provider_disabled` (fixture provider not enabled).
- Project creation errors: `409 project_exists`, `409 path_exists` (any existing file or folder, even an empty one), `422 engine_invalid_input` (the engine rejected the input), `503 engine_unavailable`.

## Milestone 2: validation and G1 approval

`GET /projects/{id}/draft` gains these fields. Every call runs `draft-check` again, so the UI's **Validate Draft** action is this request.
- `review_mode`: which side guards the reviewed version.
  - `engine`: the installed engine reports a draft `revision` in `draft-check --json` (engine decision D-117, `youtube-agent` PR #11). The token *is* that revision, and approval passes it to `draft-approve --expect-revision … --json`. The engine compares it on the same locked snapshot it approves.
  - `ui`: the engine has no revision (it is pinned at `d1325c4`). The token is a UI hash of the reviewed files, and the UI checks it.
  - `null` when the check could not run.
- `review_token`: the version the reviewer validated. It is `null` whenever the report cannot back it, and then `review_token_reason` says why. In `engine` mode it is the engine's 64-hex `revision`, issued only when the check is ok. In `ui` mode, it is a hex SHA-256 over the hashes of the files a G1 approval binds (`input.json`, `outline.json`, `script.json`, `storyboard.draft.json`, `assets.json`), issued only when:
  - the files were byte-identical before and after the check;
  - the check is `ok` and `approval_status` is a known value;
  - `artifacts` is a list of well-formed entries (string `path`, 64-hex `sha256`, no duplicates);
  - the list covers `outline.json`, `script.json` and `storyboard.draft.json`, each matching the bytes on disk, and every listed reviewed file matches;
  - `input.json` exists.

  An empty, partial or malformed report never yields a token.
- `approval`: the engine's `review.json` (`reviewer`, `approved_at`, `comment`, `artifacts`, `unresolved_blockers`, `meaning`), or `null`. It is for display only; whether it is current comes from `draft_check.approval_status` (`approved`, `stale` or `not_approved`).
- `approval_confirmed`: `null` unless the engine reports `approved`.
  - `false` means the engine's current approval record is one the UI could not confirm covers the version the reviewer validated (see `approval_unconfirmed` below). The UI never presents it as the reviewer's approval.
  - `true` otherwise.

  The flag is kept in SQLite (`approval_mismatches`, migration 0002) and keyed to that exact `review.json` record.
- `active_job_id`: the queued or running job for this project, if any.

`POST /projects/{id}/draft/approve` (requires CSRF) records G1 approval through `ytagent draft-approve`.

```json
{ "reviewer": "Nguyễn Văn A", "comment": "optional, ≤ 2000", "confirm": true, "review_token": "<from GET /draft>" }
```
- `reviewer` must be 1–200 characters on a single line. `confirm` must be `true`, and unknown fields are rejected (422).
- The project is held for the duration of the call, so no draft job can start until it returns (`409 project_busy`).
- The draft is checked again first. If it passes and the current token differs from `review_token`, the response is `409 draft_changed`. If the check fails, the request goes to the engine, which refuses with its own error list.
- **`engine` mode:** the engine enforces `--expect-revision` under its lock. A change made in between is refused (`revision_mismatch` → `409 draft_changed`), and nothing is written.
- **`ui` mode:** the engine approves its own snapshot. Afterwards the UI compares the record's file hashes with the validated ones. If they differ, the approval is recorded as unconfirmed and the response is `409 approval_unconfirmed`, never 200. Approving again after validating the current version confirms it and clears the flag (the engine answers "already approved").
- **Response 200:** `{already_approved, approved_version_matches: true, approval, approval_confirmed: true, draft_check, draft_check_error, review_token, review_token_reason, review_mode, status}`. The approval fields come from the engine after the command; `status` is a fresh `production-status` summary.

| Code | HTTP | Cause |
|---|---|---|
| `job_conflict` | 409 | a draft job is queued or running (`details.job_id`) |
| `project_busy` | 409 | another approval of this project is in progress |
| `draft_changed` | 409 | the reviewed files changed since `review_token` was issued (or the engine reported `revision_mismatch`); validate again |
| `approval_unconfirmed` | 409 | `ui` mode only: the engine recorded an approval of bytes other than the validated ones. `details.approval_status` gives the engine's view. |
| `engine_conflict` | 409 | the engine's lock is held, for example by a CLI run |
| `approval_refused` | 422 | the engine refused because the check has errors (`details.errors[]`) |
| `draft_unverifiable` | 422 | the check passed but its report does not verifiably cover the reviewed files; the engine is not invoked |
| `validation_error` | 422 | request validation failed (also the standard field errors) |
| `engine_unavailable` | 503 | the engine cannot be started |
| `engine_timeout` | 504 | no answer in time; the process group is stopped. Reload to see whether approval was recorded. |
| `engine_*` | 502 | any other engine exit, with its redacted `error:` line |

While a draft-approve call is in progress, `POST /projects/{id}/draft-jobs` returns `409 project_busy`.
