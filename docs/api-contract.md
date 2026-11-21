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
