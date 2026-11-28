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

## Milestone 2: editing the outline and script

Editing needs an engine with `draft-edit` (D-117, the pinned `ENGINE_REF` `573ebdd` or later). The UI never writes a draft file. Each save is one `ytagent draft-edit` run: the patch goes on the engine's stdin, and the engine checks the revision, validates, regenerates the Markdown views and storyboard scenes, and publishes atomically.

**`GET /projects/{id}/draft/editable`** returns everything `GET /projects/{id}/draft` returns, plus `editing`. The draft page loads this, and its **Validate Draft** action calls it again.

```json
"editing": {
  "supported": true,
  "can_edit": true,
  "revision": "<64-hex engine revision>",
  "reason": null,
  "reason_code": null,
  "paths": [],
  "limits": { "title": 300, "thesis_or_question": 2000, "heading": 300, "purpose": 2000, "key_point": 1000,
              "key_points": 50, "claims_to_investigate": 50, "narration": 50000, "summary": 2000,
              "editorial_note": 2000, "editorial_notes": 50 }
}
```
- `supported` is false when the engine reports no draft revision (`reason_code: engine_unsupported`).
- `can_edit` comes from an engine dry run of a no-op patch. When it is false, `reason` gives the engine's explanation, and `reason_code` is one of `no_draft`, `job_conflict`, `downstream_artifacts` (with `paths`), `edit_refused` (the draft already has errors), `check_unavailable`, `engine_timeout`, or an engine error code.

**`POST /projects/{id}/draft/edit`** (CSRF) saves one atomic edit of the outline and/or script.

```json
{
  "expected_revision": "<editing.revision when the editor loaded>",
  "dry_run": false,
  "outline": { "title": "…", "thesis_or_question": "…",
               "sections": [ { "id": "sec-02", "heading": "…", "purpose": "…", "key_points": ["…"], "claims_to_investigate": [] } ] },
  "script":  { "sections": [ { "outline_section_id": "sec-02", "heading": "…", "narration": "…", "summary": "", "editorial_notes": [] } ] }
}
```
- Send only changed fields: omit a field to keep it. `null`, unknown fields, wrong types, bad section IDs and over-limit values get 422, and the engine is not run. The serialised patch is limited to 1 MiB, the engine's own limit.
- One request instead of the proposed separate `PUT …/outline` and `PUT …/script`: an edit that touches both is published as one engine generation, under one revision check.
- The project is held during the call. A draft job cannot start (`409 project_busy`), and an active job refuses the edit (`409 job_conflict`).
- **200:** `{ "result": {status, dry_run, previous_revision, revision, changed_files, human_edited, storyboard, check, approval_status, approval_changed}, "draft": <editable view after the save> }`.
  - `status` is `published`, `already_current` or `would_publish`.
  - `draft` is omitted for a dry run.
  - The engine's absolute `project_root` and `files` are not returned.

| Code | HTTP | Cause |
|---|---|---|
| `revision_conflict` | 409 | the draft changed since `expected_revision` (another save, the CLI, a job). Nothing was written; `details.current_revision` gives the new revision. The UI never retries or overwrites. |
| `downstream_artifacts` | 409 | later-stage work depends on the draft (`details.paths`); edit it in the CLI's way instead |
| `engine_conflict` | 409 | the engine's lock is held |
| `unresolved_publication` | 409 | an interrupted engine write must be resolved in the CLI first |
| `job_conflict` / `project_busy` | 409 | a job is active, or another save or approval is running |
| `invalid_edit` | 422 | the engine rejected the patch (`details.errors[{loc, msg}]`, for example an unknown section) |
| `edit_refused` | 422 | the engine refused: the draft has errors, or a hand-edited view would be overwritten (`details.errors`) |
| `validation_error` | 422 | request validation (field errors), or the patch is larger than 1 MiB |
| `engine_unavailable` / `engine_timeout` | 503 / 504 | as for other engine calls. After a timeout, reload before editing again. |

**Approval and editing.** Any saved edit makes an existing approval `stale`, by the engine's rule. With this engine, approval sends the engine `revision` as `--expect-revision`, so the engine itself refuses to approve a version other than the one validated. The browser does not offer approval while edits are unsaved, and the server checks the revision.

## Milestone 3, UI-A: research reads and collection jobs (implemented)

Implemented in UI-A against engine `fb6bffc` (only E1 is used). These rows replace the matching proposed rows below; everything else in the proposed table (history, documents, edits, attestations, apply) is still proposed for UI-B and UI-C.

| Method and path | Engine command | Body | Response and errors |
|---|---|---|---|
| `GET /projects/{id}/research` | `research-check --json` (exit 0 or 14), plus reads of `research.json`, `render/research/snapshots.json` and `evidence.json` | none | `report` (or `report_error {code, message}`), `revision`, `started` (`research-plan.json` exists), `sources`, `snapshots`, `evidence`, `records_error`, `stage`, `network {enabled, search_provider}`, `active_job_id` |
| `GET /projects/{id}/research/snapshots/{snapshot_id}` | read only | none | `{snapshot, text}`. `404 not_found`; `409 snapshot_tampered` when the record or path is invalid, the file is missing or not regular, or its SHA-256 or UTF-8 check fails |
| `POST /projects/{id}/research/plan` | `research-plan --claim-provider=none --expect-revision=R --json` | `expected_revision` | `202` job `research-plan` |
| `POST /projects/{id}/research/collect/preview` | `research-collect --dry-run … --expect-revision=R --json` | `expected_revision`, `languages` (`vi`/`en`, default both), `claim_ids`, `max_queries` (≤50, default 8), `max_results_per_query` (≤20, default 5), `max_pages` (≤100, default 15) | the engine's preview `{revision, search_hosts, provider_result_hosts, known_targets, hosts, plan_sha256}`. Nothing is contacted |
| `POST /projects/{id}/research/collect` | `research-collect --search-provider=… --allow-host=H … --expect-revision=R --json` | as preview, plus `network: true`, `plan_sha256`, `allow_hosts` | `202` job `research-collect`. The backend runs the preview again first: a different `plan_sha256` or host set is `422 network_not_confirmed` with `details.preview`; an empty host list is `422 nothing_to_collect` |
| `POST /projects/{id}/research/sources` | `research-add-url --url=U [--claim=…] --fetch=queue\|live [--allow-host=H] --expect-revision=R --json` | `expected_revision`, `url` (https, no credentials, ≤2000), `claim_ids`, `fetch` (`queue` default, or `live`), and for live `network: true` and `allow_hosts: [host of url]` | `202` job `research-add-url`. Live without exactly that host is `422 network_not_confirmed` with `details.host` |

Common rules:
- Mutations need CSRF and origin, and are refused while the project has an active job (`409 job_conflict`).
- `YTA_RESEARCH_NETWORK=false` refuses collect and live add-URL with `403 network_disabled`. Queueing a URL still works.
- With the offline fixture search provider (`YTA_RESEARCH_SEARCH_PROVIDER=fixture`, honoured only with `YTA_ALLOW_FIXTURE_PROVIDER=true`), live add-URL runs `--fetch=fixture`, so nothing leaves the machine.
- Hosts are DNS names only: IP literals, single-label names, credentials and non-https URLs are rejected before the engine runs.
- Engine refusals are mapped once, in the job (or, for the preview, directly):
  - `revision_mismatch` → `409 revision_conflict` with `details.current_revision`;
  - `g1_not_current` → `409 g1_not_current`;
  - `invalid_input` → `422 research_refused`;
  - `unresolved_publication` → `409 unresolved_publication`.
- Job success messages come from the job type ("Claim inventory prepared", "Source collection finished", "Source added"). The engine's own JSON and progress lines are shown as logs; there is no progress percentage.

## Milestone 3, UI-B: research review (implemented)

These endpoints are implemented in UI-B against engine `fb6bffc`. They replace the matching proposed rows below. Every write holds the project (`409 job_conflict` / `project_busy`), needs CSRF, and returns the refreshed view.

| Method and path | Engine command | Body | Response and errors |
|---|---|---|---|
| `GET /projects/{id}/research` | as in UI-A | none | UI-A's fields, plus: `plan {claims (anchors with `context {before, excerpt, after}` or null), leads}`; `review {present, schema_version, supported, reviews, completeness, source_rechecks, primary_source_attestations, history_summary {count, last_seq}}`; `scenes`; `editing {supported, reason, migration_required, legacy_ids}` |
| `GET /projects/{id}/research/history` | read of `research-review.json` | query: `kind`, `subject_id`, `after_seq`, `limit` ≤200 | `{entries, next_after_seq, has_more, chain_ok, revision}`, in ascending `seq` (oldest first); `after_seq` returns entries with `seq > after_seq`, so passing `next_after_seq` loads the next, newer page (the UI's "Load more"). A `0.1` file gives `502 engine_unsupported`; `chain_ok` comes from the engine's `history_tampered` item |
| `POST /projects/{id}/research/edit` | `research-edit --expect-revision=R --json [--dry-run]`, patch on stdin | `expected_revision`, `dry_run`, `operations` (1–200, the E2/E3 operations, strict) | `{result: {status, previous_revision, revision, changed_files, created, occurrences, check, approval_status}, research}`; there is no `research` for a dry run |
| `POST /projects/{id}/research/documents` | `research-add-document … --expect-revision=R --json`, text on stdin | `expected_revision`, `title`, `language`, `citation`, `imported_by`, optional `edition`, `declared_url` (https), `original_published_at`, `license`, `note`, `new_version_of` (a `doc-` source of this project), `text` (≤400k characters). There is no `url` field | `{result: {source_id, snapshot_id, supersedes_snapshot_id, chars, revision}, research}` |
| `GET /projects/{id}/draft/narration` | `research-check` plus a read of the lineage | none | `{revision, lineage {present, fixture_project, segments [{segment_id, section_id, scene_id, origin, text, norm, derived_from, attestation, initialized_from}]}, items (fixture_narration / narration_provenance_*), needs_init}` |
| `POST /projects/{id}/draft/narration/attest` | `narration-attest --segment=… --reviewer=… --statement=… --expect-revision=R --json` | `expected_revision`, `reviewer`, `statement`, `segment_ids` (1–500 `seg-` IDs) | `{result: {status, segments, remaining, recovered, revision}, narration}` |
| `POST /projects/{id}/draft/narration/provenance-init` | `narration-provenance-init --expect-revision=R --json` | `expected_revision`, `confirm: true` | as attest |

**Error mapping:**
- `revision_mismatch` → `409 revision_conflict`, with `details.current_revision`.
- `invalid_patch` → `422 invalid_edit`, with `details.errors[{loc, msg, code}]`, where `code` is the engine operation's own code. The exception is the code `history_tampered`, which gives `409 history_tampered`.
- `migration_required` → `409`.
- `document_exists` → `422 invalid_edit`, with `details.source_id` and `snapshot_id`.
- `lineage_refused` → `422`, or `409` for integrity reasons, with `details.reason`.
- `human_edit_conflict` / `unresolved_publication` → `409`.
- `invalid_input` → `422 invalid_edit`.
- Request validation → `422 validation_error`, before any engine run.

## Milestone 3, UI-C: G2, apply and export (implemented)

Implemented in UI-C against engine `fb6bffc`. Every write holds the project (`409 job_conflict` / `project_busy`), needs CSRF, and returns the refreshed research view.

| Method and path | Engine command | Body | Response and errors |
|---|---|---|---|
| `GET /projects/{id}/research` | as in UI-B | none | UI-B's fields, plus `gates {g1, g2}`: the states production-status reports in its stage details (`G1 editorial: <state>`, `G2 research: <state>`), or `null` when it reports none |
| `POST /projects/{id}/research/approve` | `research-approve --reviewer=… [--comment=…] --expect-revision=R --json` | `expected_revision` (the revision the reviewer validated), `reviewer`, optional `comment` (≤2000), `confirm: true` | `{result: {status: approved \| already_approved, revision, approval {reviewer, approved_at, comment, policy_version, meaning}}, research}` |
| `POST /projects/{id}/research/apply` | `research-apply --expect-revision=R --json` | `expected_revision`, `confirm: true` | `{result: {status: published \| already_current, scenes_changed, written, revision}, research}`; afterwards `gates.g1` is `stale_after_apply` |
| `POST /projects/{id}/research/export` | `research-export --expect-revision=R --json` (never `--replace-output`) | `expected_revision` | `{result: {written, unchanged, revision}, research}`, as paths relative to the project |

**Error mapping:**
- `revision_mismatch` → `409 revision_conflict`, with `details.current_revision`. Nothing is recorded.
- `not_approvable` → `422 not_approvable`, with `details.items[{code, detail}]` (the engine's blocking items, at most 25). The engine also uses this code for "export before apply"; the message says which.
- `approval_stale` / `g1_not_current` → `409`, with the engine's first line.
- `human_edit_conflict` → `409`, with `details.paths` (the hand-edited export files). The message never suggests the replace flag.
- `invalid_input` (for example a placeholder reviewer) → `422 invalid_edit`.
- Request validation (no `confirm`, nulls, unknown fields) → `422 validation_error`, before any engine run.

## Milestone 4, UI-A: visuals reads, images, plan, search and import (implemented)

Implemented in UI-A against engine `65c5f52` (V1, D-122). Selection, clearances, plan narrowing and apply are UI-B (they need engine V2). Every mutation needs CSRF and origin and carries the visuals `expected_revision` the page loaded.

| Method and path | Engine command | Body | Response and errors |
|---|---|---|---|
| `GET /projects/{id}/visuals` | `visuals-state --json` (one run per request) | none | the engine snapshot as it prints it (`scheme`, `revision`, `inputs`, `evidence_inputs`, `pending_journals`, `recovery_required`, `catalog_trusted`, `catalog_problems`, `plan`, `candidates`, `selection`, `applied`, `integrity`, `scenes` with `apply_state`, `assets`, `report`, `gates {g1, g3}`), plus `narration {scene_id: text}` (only from the storyboard bytes the snapshot names), `network {enabled, search_provider}`, `editing` (UI-B: `{supported, reason, acknowledgement, bases, motions, fits, max_shots}`; `supported` is true only when `ytagent --help` lists both `visuals-edit` and `visuals-apply`, otherwise `reason` says the feature is not supported by this engine; if `--help` cannot be read, the pinned engine is assumed) and `active_job_id`. The snapshot also carries `clearance_history` and `clearance_history_problems` (engine D-123). `503 state_unavailable` if the engine cannot produce it; `502 engine_unsupported` for an engine before D-122 |
| `GET /projects/{id}/visuals/candidates/{candidate_id}/image?sha256=H` | read, verified | none | the image bytes. `400 invalid_input` (no or malformed `sha256`, malformed ID); `404 not_found`; `409 catalog_untrusted`; `409 image_changed` with `details.current_sha256`; `409 image_integrity`; `503 state_unavailable` |
| `GET /projects/{id}/visuals/assets/{asset_id}/image?sha256=H` | read, verified | none | as above, for an asset whose record is the one `visuals-apply` wrote (`record_intact`), otherwise `409 image_integrity` |
| `POST /projects/{id}/visuals/plan` | `visuals-plan --expect-revision=R --json` (never `--replace-plan`) | `expected_revision` | `202` job `visuals-plan` |
| `POST /projects/{id}/visuals/acquire/preview` | `visuals-acquire --search-provider=… --image-provider=none [--scene=…] --max-candidates-per-scene=N --dry-run --expect-revision=R --json` | `expected_revision`, `scene_ids` (empty: every planned scene), `max_candidates_per_scene` (1–20, default 4) | `{preview, preview_sha256}`, the engine's canonical preview. Nothing is contacted or written |
| `POST /projects/{id}/visuals/acquire` | as the preview without `--dry-run`, plus `--expect-preview=H --allow-host=…` | as preview, plus `network: true`, `preview_sha256`, `allow_hosts` | `202` job `visuals-acquire`. The backend runs the preview again first: another hash or host set is `409 preview_mismatch` with `details {checked_by: "backend", preview, preview_sha256}` |
| `POST /projects/{id}/visuals/import` | `visuals-import --scene=… --stdin --title=… --kind=… --provenance=… [--source-url --creator --license-name --license-url --attribution] --expect-revision=R --json`, bytes on stdin | `multipart/form-data`: `expected_revision`, `scene_id`, `kind` (`archival`, `document`, `chart`, `generated`), `provenance` (10–2000), optional `title` (default: the file name), `source_url` and `license_url` (https), `creator`, `license_name`, `attribution`; then the `file` part, last | `{result {candidate_id, scene_id, sha256, width, height, rights_status, warnings, revision}, visuals}` |

**Order and limits of an import.** As soon as the `file` part starts, the text fields are validated and the revision and pending recovery are checked against the current snapshot (`409 revision_conflict` / `recovery_required`). File bytes that arrived in the same network chunk are held, not accepted, until that check passes, and no further chunk is read before it. The upload is received without holding the project. Once it is complete, the project is held (`409 job_conflict` / `project_busy`) and recovery and the revision are checked again before the engine runs. The file is read in memory only (at most 20 MB, `413 too_large`), must be JPEG, PNG, WebP or TIFF by its first bytes (`422 invalid_input`), and goes to the engine on stdin. A part after the file, a repeated field or an unknown field is `422`. Not multipart is `415`. The engine also needs at least 480×270 pixels.

**Snapshot freshness.** The backend keeps the latest `visuals-state` per project. Before it authorises an image or a write, every file in `inputs` and `evidence_inputs` is hashed again (keyed by its stat identity; opened one component at a time without following symlinks; an evidence URL is never fetched and counts as `null`). Any difference runs `visuals-state` again, one run per project at a time. Every write and every job end discards it.

**Pending recovery.** When the current snapshot has `recovery_required: true`, plan, preview, acquire and import are refused with `409 recovery_required`, `details {checked_by: "backend", journals: [{stage, code, detail, next_action}]}`, before any engine command. Reads and images continue.

**Engine refusals** (writes, the preview, and job outcomes):
- `revision_mismatch` → `409 revision_conflict`, with `details.current_revision`;
- `recovery_required` → `409 recovery_required`, `details {checked_by: "engine", journals}`;
- `preview_mismatch` → `409 preview_mismatch`, `details {checked_by: "engine", preview_sha256, hosts}`;
- `catalog_untrusted`, `image_integrity` (with `candidate_ids`, `asset_ids`, `paths`), `g1_not_current`, `not_ready`, `human_edit_conflict` → `409` with the same code;
- `invalid_input`, and the generic `error` exit 3 for undecodable import bytes → `422 visuals_refused`;
- `concurrency` (exit 9) → `409 engine_conflict`.

A failed job reports the engine's JSON error code when it printed one (`revision_mismatch`, `preview_mismatch`, `recovery_required`, `partial_acquire_failure` exit 13, `g1_not_current`, `catalog_untrusted`) as its `error_code`, with a fixed message, instead of the exit code's summary. This applies to research jobs too. `YTA_VISUALS_NETWORK=false` refuses the preview and the search with `403 network_disabled` and runs no engine command; imports still work.

**Image responses.** `Content-Type` from the verified magic (`image/png` or `image/jpeg`), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Content-Disposition: inline`, `Cache-Control: private, max-age=31536000, immutable`, `ETag: "H"`. Errors are `Cache-Control: no-store`. The bytes sent are the bytes hashed.

## Milestone 4, UI-B: selection, clearances, plan narrowing and apply (implemented)

Implemented in UI-B against engine `26c608f` (V2a D-123, V2b D-124). With an engine whose `ytagent --help` lacks `visuals-edit` or `visuals-apply`, both are refused with `502 engine_unsupported` before anything runs, and `GET /system/engine` lists only the commands the engine has. Both writes hold the project (`409 job_conflict`), need CSRF and origin, and are refused first by the backend for a pending publication (`409 recovery_required`, `checked_by: backend`) or another revision (`409 revision_conflict`) before any engine command runs.

| Method and path | Engine command | Body | Response |
|---|---|---|---|
| `POST /projects/{id}/visuals/edit` | `visuals-edit --expect-revision=R --json [--dry-run]`, the patch `{"operations": [...]}` on stdin | `expected_revision`, `operations` (1–200), `dry_run?` | `{result {status: published \| already_current \| would_publish, dry_run, previous_revision, revision, changed_files, history [{op_index, id, action, candidate_id}], check}, visuals}`; no `visuals` for a dry run |
| `POST /projects/{id}/visuals/apply` | `visuals-apply --reviewer=… --expect-revision=R --json` (never `--replace-shots` or `--replace-assets`) | `expected_revision` (the validated one), `reviewer`, `confirm: true` | `{result {status: published \| already_current \| images_restored, scenes_changed, assets_added, assets_unchanged, rights_unverified, images_restored, revision}, visuals}` |

**Operations** (strict like the engine: unknown fields, wrong JSON types and explicit nulls are `422` before any engine run; text is NFC-normalised):
- `shots.set {scene_id, shots: [{candidate_id, motion?, fit?, duration_seconds?}]}` (1–20 shots; motion `static | slow_zoom | slow_zoom_out | pan_left | pan_right`, fit `auto | cover | contain`, seconds 0–600) and `shots.clear {scene_id}`;
- `clearance.set {candidate_id, expected_candidate_sha256, expected_rights_fingerprint, reviewer, basis, justification, evidence, acknowledgement}`. The engine refuses (`target_changed`) unless the two expected values are the catalogue's, re-hashes the bytes, binds a local evidence document's bytes, and records the clearance in the hash-chained history;
- `clearance.revoke {candidate_id, reviewer, reason}`;
- `plan.update {scene_id, search_query?, search_enabled?, generation_enabled?, notes?}`, narrowing only.

**Engine refusals** (in addition to the UI-A list):
- `invalid_patch` → `422 invalid_edit` with `details.errors [{loc, msg, code}]` (`unknown_candidate`, `target_changed`, `not_narrowing`, `reason_too_thin`, …); with a `history_tampered` item → `409 history_tampered`;
- `image_integrity` → `409 image_integrity` (`candidate_ids`);
- `not_ready` → `409 not_ready` with `details.errors` (the engine's items, e.g. one asset getting two different rights records);
- `human_edit_conflict` → `409 human_edit_conflict` with `details.conflicts` (shots the engine did not write; never replaced);
- `concurrency` → `409 engine_conflict` (the project changed during the command; reload and retry).

## Milestone 3 (proposed): research and G2

**Status: proposed, now implemented.** UI-A, UI-B and UI-C implemented the rows above; this table is kept as the original proposal. The endpoints need the engine additions E1–E3 ([milestone-3.md](milestones/milestone-3.md#critical-dependency--engine-capabilities-e1-e2-e3)). The UI never writes engine files: every mutation is one allowlisted engine command, and every mutation carries the `expected_revision` from `GET …/research` (the engine's `research-check --json` `revision`). The common rules match M2: CSRF and origin on mutations, the project held during the call (`409 job_conflict` / `project_busy`), and no absolute paths in responses.

| Method and path | Engine command | Body (main fields) | Response |
|---|---|---|---|
| `GET /projects/{id}/research` | `research-check --json` plus reads of `research.json`, `snapshots.json`, `evidence.json`, `research-review.json` | none | `report` (with `revision`), `sources`, `snapshots` (with `acquisition`), `evidence` (persistent `id`s), `reviews` (with `outdated_components`), `primary_source_attestations`, `history_summary {count, last_seq, chain_ok}`, `gate`, `network`, `editing`, `active_job_id` |
| `GET /projects/{id}/research/snapshots/{snapshot_id}` | read only, hash-verified | none | metadata and plain text; `409 snapshot_tampered` |
| `GET /projects/{id}/research/history` | read of `research-review.json` (`m5-review-0.2`) | query: `kind`, `subject_id`, `after_seq`, `limit` ≤200 | `{entries, next_after_seq, has_more, chain_ok}` |
| `POST /projects/{id}/research/plan` | `research-plan --claim-provider=none --expect-revision --json` | `expected_revision` | 202 job |
| `POST /projects/{id}/research/collect/preview` | `research-collect --dry-run --expect-revision --json` | `expected_revision`, `languages`, `claim_ids`, the limits | `{revision, search_hosts, provider_result_hosts, known_targets, hosts, plan_sha256}`: hosts are a permission scope (potential destinations), and result hosts appear only when searches are pending |
| `POST /projects/{id}/research/collect` | `research-collect --search-provider=wikipedia --fetch=auto --allow-host=… --expect-revision --json` | as preview, plus `network: true`, `plan_sha256`, `allow_hosts` (exactly the confirmed preview's hosts; re-checked server-side immediately before the run) | 202 job |
| `POST /projects/{id}/research/sources` | `research-add-url --fetch=queue\|live [--allow-host=H] --expect-revision --json` | `expected_revision`, `url`, `claim_id?`, `fetch`, and for live `network: true` and `allow_hosts: [url host]` | 202 job |
| `POST /projects/{id}/research/documents` | `research-add-document … [--declared-url] [--edition] [--new-version-of] --expect-revision --json`, text on stdin | `expected_revision`, `title`, `language`, `citation`, `imported_by`, `edition?`, `declared_url?` (data only, never fetched), `original_published_at?`, `license?`, `note?`, `new_version_of?` (`doc-…`; complete provenance still required), `text` (≤400k characters) | `{source_id, snapshot_id, supersedes_snapshot_id, revision}` plus the research view |
| `POST /projects/{id}/research/edit` | `research-edit --expect-revision --json [--dry-run]`, patch on stdin | `expected_revision`, `dry_run`, `operations` (the E2/E3 operation list) | `{result, research}` (no `research` for a dry run) |
| `POST /projects/{id}/draft/narration/attest` | `narration-attest --expect-revision --json` | `expected_revision`, `reviewer`, `statement`, `segment_ids` | `{result}` plus the draft view |
| `POST /projects/{id}/draft/narration/provenance-init` | `narration-provenance-init --expect-revision --json` | `expected_revision`, `confirm: true` (legacy fixture projects only) | `{result}` plus the draft view |
| `POST /projects/{id}/research/approve` | `research-approve --expect-revision --json` | `expected_revision`, `reviewer`, `comment?`, `confirm: true` | the engine result plus the research view |
| `POST /projects/{id}/research/apply` | `research-apply --expect-revision --json` | `expected_revision`, `confirm: true` | the research view plus the draft's G1 status |
| `POST /projects/{id}/research/export` | `research-export --expect-revision --json` | `expected_revision` | written files (relative paths) |

**Errors.**
- **Conflicts (409):**
  - `revision_conflict`, with `details.current_revision`; nothing written, never retried;
  - `human_edit_conflict`;
  - `approval_stale` / `g1_not_current`;
  - `snapshot_tampered` / `history_tampered` / `narration_provenance_invalid` / `narration_provenance_missing`;
  - `migration_required` (a `m5-review-0.1` review file; upgrade with `migrate_review_file`);
  - `engine_conflict` / `unresolved_publication`;
  - `job_conflict` / `project_busy`.
- **Network:** `network_disabled` (403); `network_not_confirmed` (422, with `details.preview` when the plan or hosts changed).
- **Validation (422):** `invalid_edit` (`details.errors[{loc, msg}]`, including `recheck_target_changed`, `recheck_exists`, `document_exists`); `research_not_ready` (`details.items`); `validation_error`.
- **Engine (503/504/502):** `engine_unavailable`, `engine_timeout`, `engine_unsupported`.

**Never exposed:** `--replace-plan`, `--force`, `--replace-output`, `--claim-provider=ollama|fixture` (fixture only with `YTA_ALLOW_FIXTURE_PROVIDER` in tests), and `resume`. `YTA_HTTP_CONTACT` is never set. A new setting, `YTA_RESEARCH_NETWORK` (default `true`), disables every network action when `false`.
