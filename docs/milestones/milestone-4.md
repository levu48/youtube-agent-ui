# Milestone 4 — Visuals: Plan, Candidate Gallery, Rights and Selection (G3)

**Status:** specification. The engine needs prerequisite PRs (V1, V2) before the UI can drive this stage; none is started. Engine facts below were verified read-only at engine `main` `fb6bffc` (the pinned `ENGINE_REF`), including an offline probe with the fixture and mock providers.

**Goal:** a reviewer can choose one or more images for every scene of an approved draft in the browser, see each image's licence evidence, record rights clearances where a licence cannot be verified automatically, and apply the selection to the draft, with the `youtube-agent` engine as the only authority. This covers:
- the visual plan (one planned visual per scene, with its kind and search query);
- explicit, host-confirmed image search on Wikimedia Commons;
- a candidate gallery with previews, licence evidence and the engine's warnings;
- importing an image the reviewer owns or has cleared;
- per-scene selection (shots), and human rights clearances bound to the exact image bytes;
- validation, apply (which makes G1 out of date), and G3 as the engine computes it.

**Numbering.** The engine also calls this stage **M4** (`docs/milestone-4-visuals.md`, decisions D-58…D-75). This document uses the UI numbering, which happens to match.

## Existing baseline

**Engine (`fb6bffc`).** Five commands. The parser is `cli.py:239-317`; the handlers are `cli.py:1260-1415`.
- `visuals-plan` writes `visual-plan.json` (`m4-visual-plan-0.1`, one entry per scene). It needs a current G1 (exit 12) and uses no network. `--replace-plan` regenerates a hand-edited plan.
- `visuals-acquire` searches and/or generates candidates.
  - `--search-provider {none,fixture,wikimedia}`: Wikimedia contacts `commons.wikimedia.org`, `upload.wikimedia.org` and `thumb.wikimedia.org`, behind an HTTPS host allowlist (`host_not_allowed`).
  - `--image-provider {none,mock,openai}`: openai is paid and needs `--allow-paid` and spend limits.
  - Also: `--scene`, `--force` (re-download; may pay again), `--max-candidates-per-scene`, `--concurrency`, `--timeout`.
  - It writes `render/visuals/candidates.json`, `provenance.json` and per-scene contact sheets, and an **empty** `visual-selection.json` template.
- `visuals-import --scene --file PATH --kind --provenance [--source-url --creator --license-name --license-url --attribution]` copies a still image (JPEG, PNG, WebP or TIFF) into the project. Imports are always `rights: manual_review`.
- `visuals-check [--json]` validates the plan and selection and **writes** `render/visuals/visual-report.{json,md}`. Exit codes: 0 ready, 11 not ready, 2 errors, 12 approval problem.
- `visuals-apply --reviewer` publishes `storyboard.draft.json` (only `scenes[].shots`), `assets.json` (with `assets/images/<sha256>.<ext>`) and `render/visuals/applied.json` as one generation.
  - It refuses to overwrite human-authored shots or assets without `--replace-shots` / `--replace-assets`.
  - Afterwards G1 is `stale_after_apply` and the draft `revision` changes.

**Rights policy (D-61, D-62, D-72, D-73).**
- Each candidate has `rights` evidence: `status` `accepted`, `manual_review`, `rejected` or `not_applicable`, plus licence, creator, credit line, restrictions, reasons and field findings.
- A licence is verified by complete metadata (`licence_metadata`), or by a human clearance of a `manual_review` image (`human_attestation`).
  - A clearance is bound to the candidate's `sha256` and a rights fingerprint, and needs an exact acknowledgement text.
- Placeholder, mock and fixture images are never publishable.
- Chart scenes are import only. Archival and document scenes are never generated.

**G3.** `production-status` reports `G3 visuals: pending | needs_review | ready`, computed live by `gates.visuals()`. **Nothing approves G3 explicitly.** It is `ready` once every scene is render-ready, there are no errors and nothing is unpublishable. Its findings are `visuals_not_started`, `visuals_invalid`, `visuals_selection_needed` and `image_rights_not_cleared`. It goes stale when the draft content changes after planning (D-59).

**UI.** M1–M3 are merged (UI `main`, `ENGINE_REF` `fb6bffc`). M4 reuses:
- the job runner, SSE and cancellation;
- `_engine_write` (project held, refusals mapped);
- the preview-and-confirm-hosts pattern from research collection;
- the snapshot-reader pattern for engine-owned files, read only and hash-verified;
- M2's G1 re-approval flow.

## Critical dependency — engine capabilities (V1, V2)
The UI never writes, moves or deletes engine-owned files, never passes a user-supplied path, and never passes force, replace or paid options. At `fb6bffc` a browser cannot drive visuals safely:
- **No selection command.** Selection and rights clearances can only be recorded by hand-editing `visual-selection.json` (`visuals/models.py:273-283`); so can narrowing the plan (D-61).
- **No JSON or revisions.** Only `visuals-check` prints JSON, and its failures do not use the JSON error envelope. No visuals command takes an expected revision or reports one.
- **The check writes files.** `visuals-check` writes the report under the lock, and there is no read-only visuals CLI.
- **No network control.** `visuals-acquire --search-provider wikimedia` contacts the network with no host confirmation and no preview of what it would contact.
- **Import takes a path.** `visuals-import --file` takes an arbitrary filesystem path.

Two engine PRs in `youtube-agent`, each with a decision entry, README update and tests, are reviewed and merged before the UI PR that needs them. If one cannot land, the UI ships only what the merged capabilities allow and does not claim M4 complete.

### What the engine already guarantees (fb6bffc), and what V1/V2 add
**Existing** (verified at `fb6bffc`, which is also the engine's current `main`):
- **Content-addressed images.** Every candidate image is decoded, re-encoded as PNG or JPEG, and stored as `render/visuals/candidates/<sha256>.<png|jpg>`. Its `sha256` and `local_path` are recorded in `candidates.json` (`processing.py`, `store_blob` in `storage/visual_cache.py`).
  - Only PNG and JPEG are ever stored for use. An imported TIFF survives only as an original in `render/visuals/originals/`, which nothing serves.
- **Decode limits.** 20 MB, 40 megapixels, and Pillow's decompression-bomb guard (`processing.py:25-31, 121-144`).
- **Byte check.** `blob_ok(root, rel, sha)` is true only for a regular, non-symlink file inside the project whose SHA-256 equals `sha` (`storage/visual_cache.py:45-56`). Selection validation (`agents/visuals.py:1194`), the contact sheets, and `visuals-apply` all use it. Apply re-reads every image under the lock, refuses a changed one ("candidate image … changed; nothing was applied", `agents/visuals.py:1497-1500`), then stores it content-addressed in `assets/images/`.
- **Catalogue integrity.** `render/visuals/manifest.json` records the SHA-256 of the `candidates.json` and `provenance.json` the tool last wrote. Other bytes make the whole catalogue untrusted, so no candidate can be selected or cleared (`agents/visuals.py:181-192`).
- **Clearance binding.** A clearance records `candidate_sha256` and `rights_fingerprint`: the SHA-256 of the source identity, page, kind, synthetic flag, licence status, ID, name, URL, offer, creator, credit line, restrictions and attribution requirement (`visuals/rights.py:486-530`). It has no effect once either differs.
- **Not covered today:**
  - contact sheets (`render/visuals/previews/<scene>.png`) are written with **no recorded hash**;
  - `assets.json` records have **no image hash**, only a content-addressed file name;
  - `applied.json` records the SHA-256 of each asset record, not of its image.

### V1 — visuals CLI contract (no policy change)
- **Read-only state command.** `visuals-check --json --read-only`, or an equivalent `visuals-state --json`, returns in one consistent snapshot everything the UI shows, and writes nothing:
  - the evaluation (the `VisualReport` fields);
  - the plan scenes;
  - the candidates, with rights evidence, `rights_fingerprint`, `local_path` and `sha256`;
  - the selection, the clearances (and, after V2, their history), the contact sheets with their hashes, and the applied assets with their image hashes;
  - `catalog_trusted`, and `revision` (below).

  The UI reads no visuals file directly. A consistent snapshot means the files are read under the engine lock and released before returning, or re-read until two passes give the same hashes. Either way it writes nothing and leaves no report.
- **Visuals revision** (`scheme: m4-visuals-revision-1`). SHA-256 of the canonical JSON `{"files": {rel: sha256|null}, "draft_revision": R|null, "scheme": "m4-visuals-revision-1"}`, serialised with sorted keys, no whitespace, UTF-8, `ensure_ascii=false`.
  - The files are `visual-plan.json`, `visual-selection.json`, `render/visuals/candidates.json`, `render/visuals/provenance.json`, `render/visuals/manifest.json` (which, from V1, also records the contact-sheet hashes), `render/visuals/applied.json`, `assets.json` and, after V2, `render/visuals/clearance-history.json`.
  - `draft_revision` is the `draft-check` revision (D-117), so a draft edit, a `research-apply` or a G1 change invalidates in-flight visuals work.
  - Report files are excluded (they are outputs), and so are image bytes (see Integrity).
- **Recorded hashes for everything servable.** V1 records:
  - each contact sheet's SHA-256 (`manifest.json`: `previews: {scene_id: {path, sha256, catalog_sha256}}`, written together with the sheet);
  - each applied asset's image SHA-256 and path (`applied.json`: `asset_images: {asset_id: {path, sha256}}`).

  Neither may exist without the other: a sheet or asset image without a matching record is never served.
- **`--json` and the JSON error envelope** (`{ok:false, error:{code, exit_code, message, details?}}`) on `visuals-plan`, `visuals-acquire`, `visuals-import`, `visuals-check` and `visuals-apply`, with stable codes:
  - `revision_mismatch` (with `current_revision`), `preview_mismatch`, `g1_not_current`, `host_not_allowed`;
  - `image_integrity` (with `details.candidate_ids`), `catalog_untrusted`, `human_edit_conflict`, `concurrency`, `invalid_input`, `not_ready`.
- **`--expect-revision`** on every visuals mutation. `visuals-acquire` re-checks it after the network phase, under the lock, before publishing any result (as research collect does, D-118).
- **Acquisition preview and binding** (see Network confirmation).
- **Import from stdin.** `visuals-import --stdin` reads the image bytes from standard input. They are size-limited, decoded, hashed and stored exactly like a download. No filesystem path crosses the boundary, and the other flags are unchanged.
- **Progress.** One line per scene searched, downloaded or rejected, on a progress logger.

### V2 — `visuals-edit`: selection, clearances and plan narrowing
- **The command.** `visuals-edit --expect-revision=R --json [--dry-run]`, with a strict patch `{"operations": [...]}` on stdin: no nulls, no unknown fields, at most 1 MiB and 200 operations. All operations are applied and published atomically under the lock, or none are.
- **Operations:**
  - `shots.set {scene_id, shots: [{candidate_id, motion?, fit?, duration_seconds?}]}` and `shots.clear {scene_id}`;
  - `clearance.set {candidate_id, reviewer, basis, justification, evidence, acknowledgement}` and `clearance.revoke {candidate_id, reviewer, reason}`. The engine fills `candidate_sha256` and `rights_fingerprint` from the trusted catalogue; the caller never supplies them;
  - `plan.update {scene_id, search_query?, search_enabled?, generation_enabled?, notes?}`, narrowing only (D-61).
- **Validation.**
  - Each operation is validated as `visuals-check` and `visuals-apply` would validate it: selectable candidate, destination-scene policy (D-73), placeholder clearances, exact acknowledgement.
  - Every candidate an operation selects or clears is byte-verified with `blob_ok` under the lock. A failure is refused with `image_integrity`.
  - Refusals are `invalid_patch`, with `details[{loc, msg, code}]`.
- **Clearance history.** `render/visuals/clearance-history.json` is append-only and hash-chained, like research review history (D-119). Every replaced or revoked clearance is kept with who, when and why. A broken chain is `history_tampered`, and every edit is refused until it is resolved in the CLI. The history is part of the visuals revision.

### Integrity: how changed, missing or substituted images are detected
Image bytes are **not** in the revision, because hashing every candidate on every page load would cost a full read of each one. Instead, integrity is enforced by mandatory checks wherever bytes matter, all against the authoritative `sha256` in the trusted catalogue:

| Where | Check | Failure |
|---|---|---|
| Read-only state (V1) | `blob_ok` for every **selected**, **cleared** or **applied** candidate (a small set), plus `catalog_trusted` | reported per candidate as `integrity: ok \| missing \| mismatch`, an `image_integrity` error item, and readiness false |
| `visuals-edit` `shots.set` / `clearance.set` (V2) | `blob_ok` of each named candidate, under the lock | `image_integrity`; nothing written |
| `visuals-check` / `visuals-apply` (existing) | `blob_ok` in selection validation; apply re-reads and re-hashes each image under the lock before installing it | `image_integrity` (V1 gives the existing refusal this code); nothing published |
| Image endpoint (UI) | hash of the exact bytes served (M4-02) | `409 image_integrity`; nothing served |

- **Bytes changed after validation, before apply.** The revision is unchanged, so `--expect-revision` passes. Apply's own re-hash under the lock refuses it, and nothing is published.
- **A replaced image.** A replacement has a different hash, so it is a different file name and a different catalogue entry, and a clearance bound to the old `candidate_sha256` has no effect.
- **Changed rights metadata.** This changes `candidates.json` (so the revision changes) and `rights_fingerprint`, so the clearance shows as stale and is never counted.
- **A hand-edited catalogue** is `catalog_untrusted`: nothing can be selected or cleared until `visuals-acquire` rebuilds it.

### Network confirmation: the acquisition preview
- **Preview.** `visuals-acquire --dry-run --json` contacts nothing. It returns the canonical preview `P` and `preview_sha256 = sha256(canonical_json(P))`, serialised as the revision is. `P` contains:
  - `scheme` (`m4-acquire-preview-1`), the engine `project_id`, the visuals `revision`, `search_provider`, and `image_provider` (always `none` from the UI);
  - the sorted effective `scene_ids`, the `queries` (`[{scene_id, query}]`, as the plan yields them after narrowing), `max_candidates_per_scene`, `timeout` and `concurrency`;
  - `hosts`: the sorted exact set a run may contact, including media hosts.
- **Binding.** `visuals-acquire … --expect-revision=R --expect-preview=H --allow-host=…` recomputes `P` from its current state before any request, and refuses with `preview_mismatch` unless the hash equals `H` and the `--allow-host` set equals `P.hosts`.
  - Every request and redirect is checked against the allowed hosts (`host_not_allowed`).
  - After the network phase, the revision is re-checked under the lock before anything is published (`revision_mismatch`; nothing recorded).

## Owner decisions (proposed defaults; please confirm in review)
1. **`draft_revision` in the visuals revision.** Proposed: yes. Any draft change, including `research-apply`, then invalidates confirmed acquisitions and open edits. This is the safe choice, at the cost of an occasional "reload".
2. **The plan step as a job.** Proposed: yes, for consistency with M3's plan job. It is fast and uses no network.
3. **Clearance revocation.** Proposed: a revocation needs a reviewer and a reason, and is kept in history. A revoked clearance can only be replaced by a new `clearance.set`.
4. **TIFF originals.** Proposed: never served. The UI shows only the engine's normalised PNG or JPEG.

## User journeys
1. **Plan visuals.** With a current G1, the Visuals page offers **Plan visuals** (`visuals-plan`), a job with no network. The page lists every scene with its kind, search query, and whether it needs a human-provided image.
2. **Narrow the plan** (optional). Edit a scene's search query, or turn search or generation off. Generation is shown as unavailable: no paid provider in M4.
3. **Search Wikimedia Commons.**
   - The backend asks the engine for the acquisition preview at the loaded revision. The dialog lists exactly its hosts, scenes and queries.
   - The confirmation is bound to that preview's `preview_sha256`. Changing any parameter (scenes, the per-scene limit, a query through plan narrowing), a new revision, or closing the dialog clears it. A preview answer for older parameters is dropped (the M3 collect-dialog pattern).
   - After confirmation, acquisition runs as a job with live logs. Nothing is contacted before confirmation, and `YTA_VISUALS_NETWORK=false` refuses it.
4. **Review candidates.** A gallery per scene shows previews (served read-only by the backend), title, source page, creator, licence, credit line, restrictions, the engine's rights status and reasons, and labels for placeholder or mock images ("Test image: never publishable").
5. **Import an image.** Upload a still image with its provenance (kind, provenance statement, source URL, creator, licence and attribution). The engine adds it as a `manual_review` candidate.
6. **Select.** Choose one or more candidates per scene, optionally with motion, fit and duration. Each save runs `visuals-edit` under the loaded revision.
7. **Clear rights.** For a `manual_review` candidate, record a clearance: basis, justification, evidence, the reviewer's name, and the exact acknowledgement text shown verbatim. It can be revoked later.
8. **Validate and apply.**
   - **Validate visuals** shows the engine's report: per-scene readiness, errors, warnings, unpublishable images and publication blockers.
   - **Apply selection** runs `visuals-apply --reviewer` with the validated revision. It warns first that G1 will go out of date, then links to the G1 re-approval.
9. **G3.** The page shows G3 exactly as `production-status` reports it. There is no G3 approve button, because the engine has no G3 approval.
10. **Use the CLI** at any step. A change made there appears as a revision conflict or a new state, never as a silent overwrite.

## M4-01 — Compatibility and engine contract
- V1 and V2 are separate engine PRs, reviewed and merged in that order. Each UI PR pins its minimum engine in `ENGINE_REF`.
- `docs/engine-compatibility.md` records every flag, JSON shape, exit code and error code against the merged engine, with a real-engine probe.
- The UI's capability list grows only with commands the pinned engine actually has. An older engine shows a truthful "not supported by this engine" state.

## M4-02 — Backend API (`/api/v1`; CSRF and origin on every mutation)
Every write holds the project (`409 job_conflict` / `project_busy`) and carries `expected_revision`. Refusals map as in M3, plus `image_integrity` → 409, `catalog_untrusted` → 409 and `preview_mismatch` → 409.

| Method and path | Engine command | Returns |
|---|---|---|
| `GET /projects/{id}/visuals` | the V1 read-only state, plus `production-status` | the view: the engine snapshot (with `revision`, `catalog_trusted`, per-candidate `integrity`), `gates {g1, g3}`, `network`, `editing`, `active_job_id` |
| `GET /projects/{id}/visuals/candidates/{candidate_id}/image` | read, verified as below | image bytes |
| `GET /projects/{id}/visuals/previews/{scene_id}/image` | read, verified as below | image bytes |
| `GET /projects/{id}/visuals/assets/{asset_id}/image` | read, verified as below | image bytes |
| `POST /projects/{id}/visuals/plan {expected_revision}` | `visuals-plan --expect-revision --json` | 202 job |
| `POST /projects/{id}/visuals/acquire/preview {expected_revision, scene_ids?, max_candidates_per_scene}` | `visuals-acquire --dry-run --search-provider=wikimedia --json` (nothing contacted) | `{preview, preview_sha256}` |
| `POST /projects/{id}/visuals/acquire {expected_revision, scene_ids?, max_candidates_per_scene, network: true, preview_sha256, allow_hosts}` | `visuals-acquire --search-provider=wikimedia --image-provider=none --expect-revision --expect-preview --allow-host=… --json` | 202 job |
| `POST /projects/{id}/visuals/import` (multipart) | `visuals-import --stdin --expect-revision --json` | the refreshed view |
| `POST /projects/{id}/visuals/edit {expected_revision, operations, dry_run?}` | `visuals-edit` | `{result, visuals}` (no `visuals` for a dry run) |
| `POST /projects/{id}/visuals/apply {expected_revision, reviewer, confirm: true}` | `visuals-apply --expect-revision --json` | `{result, visuals}` |

**Acquire confirmation.** Before submitting the job, the backend re-runs the dry run with the same parameters. It refuses (`409 preview_changed`) unless the hash equals `preview_sha256` and `allow_hosts` equals the preview's hosts exactly. The engine then checks both again itself (`--expect-preview`), so a change between the two checks is still refused. With `YTA_VISUALS_NETWORK=false`, both preview and acquire are refused (`403 network_disabled`), and no network provider is ever passed.

**Import.**
- Multipart: the image (at most 20 MB, the engine's limit; JPEG, PNG, WebP or TIFF by magic bytes), `scene_id`, `kind`, `provenance`, and optional `source_url` (https), `creator`, `license_name`, `license_url` (https) and `attribution`.
- The bytes are streamed to `visuals-import --stdin`. The UI never stores them, or stores them only in memory.

**Image endpoints: authorisation and serving.** Images are addressed by engine IDs, never by file name or path, so no request can name an arbitrary project file.
1. **Resolve the record** from the latest V1 read-only state the backend holds for the project. That state is kept in memory, keyed by revision, and replaced on every `GET …/visuals` and every write; with none, the backend runs the read-only state once. No engine run happens per image, and the byte check in step 4 keeps an outdated record safe, because it can only serve bytes matching an engine-recorded hash. The records are:
   - `candidates/{id}`: the trusted catalogue entry (`catalog_trusted` must be true), with `local_path` and `sha256`;
   - `previews/{scene_id}`: the manifest's `previews[scene_id]` `{path, sha256}`;
   - `assets/{id}`: `applied.json` `asset_images[id]` `{path, sha256}`.

   An unknown ID, a missing record or an untrusted catalogue gives `404`.
2. **Check the path shape.** It must be exactly `render/visuals/candidates/<sha256>.(png|jpg)`, `render/visuals/previews/<scene_id>.png` or `assets/images/<sha256>.(png|jpg)`. For candidates and assets, the file name's hash must equal the record's `sha256`.
3. **Open safely.** Each path component is opened with `O_NOFOLLOW` from the project directory (no symlink anywhere, and the result stays inside the project). The descriptor must be a regular file of at most 20 MB. It is read once into memory, from that descriptor.
4. **Verify the bytes read:** their SHA-256 must equal the record's (otherwise `409 image_integrity`), the magic bytes must be PNG or JPEG matching the extension, and the header dimensions must be at most 40 megapixels. No full decode happens in the request path.
5. **Serve exactly those bytes,** with:
   - `Content-Type: image/png` or `image/jpeg` (from the verified magic);
   - `X-Content-Type-Options: nosniff`;
   - `Content-Security-Policy: default-src 'none'; sandbox`;
   - `Content-Disposition: inline`;
   - `Cache-Control: private, max-age=3600` and `ETag: "<sha256>"`. The content is immutable per hash, so a replaced image is a different URL response.

   Because the verified bytes are the bytes served, replacing the file after verification cannot change what is sent.
6. **Never served:** SVG, HTML or any other type; originals and staging files; TIFF. Image reads share a small semaphore, so concurrent large reads are bounded.

## M4-03 — Visuals workspace UI (`/projects/[projectId]/visuals`)
- **Navigation.** The sidebar's **Visuals** entry becomes live. The project page's next step leads here once G2 is applied and G1 is current, or straight after G1 when research is not used.
- **Layout.**
  - **Scenes:** one card per scene, with narration, brief, kind, selection and readiness.
  - **Gallery:** per scene, candidates in a responsive grid with keyboard selection, alt text from the title and brief, and a large preview dialog.
  - **Validation:** the report, unpublishable images, credits, and apply.
- **Honesty.**
  - Rights status and reasons are the engine's.
  - "Publishable" is never shown for placeholder, mock or `manual_review` images without a clearance.
  - Generated images (if ever present) carry the engine's disclosure label.
  - Progress is the engine's log lines, never a percentage.
- **Accessibility:** WCAG 2.2 AA, as in M1–M3. Images need text alternatives; the selection state is never conveyed by colour alone.

## M4-04 — Validation, apply and G3
- **Apply** sends the revision the reviewer last validated, as M3's G2 approval does: a validation is spent by any later change, and the confirmation dialog stays bound to it.
  - A change in records, from the UI, the CLI or a job, is refused with `revision_mismatch`.
  - A change in image bytes alone is refused by apply's own re-hash with `image_integrity`.
- **After apply,** G1 shows as out of date until `draft-approve` runs again (M2's flow). Apply also changes the draft revision, so any open draft editor reloads.
- **G3** is shown as production-status reports it, and is never inferred or "approved" by the UI.
- **Nothing runs automatically.** Nothing advances to narration or rendering.

## M4-05 — Security
- **Unchanged:** loopback binding, host and origin checks, CSRF on every mutation.
- **Argv.**
  - Allowlisted per operation. No `shell=True`, and no user-supplied flag, path or executable.
  - Excluded: force, replace and paid options (`--force`, `--replace-plan`, `--replace-shots`, `--replace-assets`, `--allow-paid`, `--image-provider openai`).
  - User text travels as single argv elements; image bytes and patches go on stdin.
- **Network.**
  - Only hosts the reviewer confirmed for that exact acquisition. The confirmation is bound to the engine preview's `preview_sha256`, checked by the backend and again by the engine (`--expect-preview`), and the engine enforces `--allow-host` on every request and redirect.
  - `YTA_VISUALS_NETWORK=false` refuses every network action. The backend never fetches anything itself. No paid services and no API keys.
- **Untrusted content.** Image files, titles, licence text, creators and source URLs are untrusted.
  - Images are served only by engine ID, from engine-recorded paths and hashes, verified on the exact bytes sent, and never as SVG, HTML or TIFF (M4-02).
  - Text is rendered as text, and links carry `rel="noopener noreferrer"`.
  - None of it is ever used in a command line.
- **Uploads.** At most 20 MB, magic-byte checked, streamed to the engine on stdin, and never stored by the UI on disk.

## M4-06 — Tests, CI and handoff
- **Backend.**
  - The argv builders and the excluded flags.
  - Requests and errors: the upload limits and magic bytes; the edit request models; the error mapping, including `image_integrity`, `catalog_untrusted` and `preview_mismatch`; `exclusive`.
  - A fake engine extended with the V1/V2 JSON, errors and race modes.
- **Image endpoints** (unit tests):
  - served: a catalogued candidate, a contact sheet with its manifest record, an applied asset;
  - `404`: a file with a valid name but no record; an untrusted catalogue;
  - path traversal in an ID, and a symlink anywhere in the path;
  - `409 image_integrity`: a hash mismatch, a missing file; a file replaced between being opened and the response (the served bytes are the verified bytes);
  - refused: a PNG named `.jpg`, an SVG or HTML disguised as an image, an oversized file, a header claiming more than 40 megapixels.
- **Integrity** (engine and UI):
  - a candidate's bytes changed with no catalogue change: reported as a mismatch, and selection, clearance and apply refused;
  - a missing or corrupted candidate;
  - rights metadata changed after a clearance: the clearance is stale and not counted;
  - bytes changed after validation, before apply: apply is refused and nothing is published;
  - a cleared image replaced: the clearance does not carry over;
  - unchanged, valid images continue through the normal workflow.
- **Network confirmation** (backend and frontend):
  - after the preview, a change of scenes, of the per-scene limit or of a query (plan narrowing), or a new revision: the confirmation is cleared and the backend refuses with `preview_changed`;
  - preview answers arriving out of order: the stale one is dropped;
  - the dialog closed and reopened: no confirmation is kept;
  - a redirect to an unconfirmed host: `host_not_allowed` (fixture provider);
  - network disabled: `403`, and no engine run;
  - research or visuals state changing during acquisition: `revision_mismatch` after the network phase, nothing recorded;
  - a valid, explicitly confirmed acquisition succeeds.
- **Real-engine integration (required, offline).** A successful G3 on non-fixture images:
  1. create; fixture draft; narration rewritten and attested (as in M3's G2 test); G1;
  2. `visuals-plan`;
  3. import a **genuinely public-domain or openly licensed image** for every scene, through `visuals-import --stdin`, with full provenance;
  4. clear the rights of each `manual_review` import with `visuals-edit` (bound to its bytes, recorded in the clearance history);
  5. select a shot per scene with `visuals-edit`;
  6. validate, then apply with the validated revision (G1 now out of date);
  7. `draft-approve`.

  The CLI then reports `G3 visuals: ready` and G1 approved. The test also checks that:
  - an applied asset image is served through the asset endpoint, and its hash matches `applied.json`;
  - a stale revision on apply is refused;
  - a clearance does not survive a changed image.

  The images are committed under `backend/tests/fixtures/visuals/` with a `SOURCE.md` giving the Commons file page, the revision or upload date, the licence and the attribution.
- **Other negative paths:**
  - a placeholder image never shown as publishable;
  - a clearance refused for a wrong acknowledgement;
  - a chart scene refusing a non-imported image;
  - a human-edit conflict on apply, shown and not overwritten;
  - `history_tampered`;
  - a CLI hand edit producing a UI conflict.
- **Frontend component tests:**
  - selection, and its keyboard and focus;
  - the clearance form, with the exact acknowledgement and no prefill;
  - labels for placeholder and mock images;
  - the host-confirmation dialog;
  - apply's G1 warning;
  - conflict and recovery.
- **E2E (fake and real engine).** The journey above, with axe WCAG 2.2 AA on every tab and dialog; 1440, 768 and 375 px; 200% zoom; reduced motion.
- **CI.** The real-engine script minimums rise, and `ENGINE_REF` is bumped per UI PR. A live Wikimedia smoke test is recorded by hand in `docs/m4-verification.md`, not in CI.

## Delivery plan (independently reviewable PRs; none merged automatically)

```
UI-0 (this spec) ─► V1 engine: visuals CLI contract ─► V2 engine: visuals-edit (selection, clearances, plan)
                      └─► UI-A read-only workspace, plan job, previewed Wikimedia acquire, gallery, import   (needs V1)
                                                   V1 + V2 ─► UI-B selection, clearances, plan narrowing, validation, apply, G1 again, G3
```

| PR | Repository | Depends on | Content | Verified by |
|---|---|---|---|---|
| UI-0 | UI | none | this specification and the roadmap | review |
| V1 | engine | UI-0 reviewed | the read-only state command (one consistent snapshot, no writes) with `revision` and per-candidate `integrity`; recorded contact-sheet and applied-image hashes; `--json` and the error envelope with stable codes (including `image_integrity`, `catalog_untrusted`, `preview_mismatch`); `--expect-revision` everywhere (acquire re-checked after the network phase); the canonical acquisition preview with `--expect-preview` and `--allow-host`; `visuals-import --stdin`; progress | engine pytest |
| V2 | engine | V1 | `visuals-edit` (shots, clearances bound by the engine to the image bytes and rights fingerprint, plan narrowing); byte verification under the lock; the hash-chained clearance history in the revision; a strict patch, atomic publication | engine pytest |
| UI-A | UI | V1 | the visuals view (from the read-only state), the three ID-addressed image endpoints, the plan job, the preview-bound acquire job, the gallery, the import upload, navigation | backend, frontend, E2E, real-engine script, CI |
| UI-B | UI | V1, V2 | selection, clearances (with history), plan narrowing, validation, apply with the G1 warning and re-approval link, G3 display; the required real-engine G3 success test with genuinely licensed images | same, plus the manual live Wikimedia smoke test |

## Non-goals
- Paid image generation, API keys, OpenAI or any chargeable call: the UI never offers `--image-provider openai` or `--allow-paid`.
- Narration audio, rendering and publishing (M5, M6).
- Image editing, cropping or upscaling in the browser.
- Editing tool-owned files (`candidates.json`, `provenance.json`, `applied.json`, the report) or the draft from the visuals page.
- Bypassing licences, robots or access controls.
- Force or replace flags, and `resume`.

## Definition of done
- [ ] V1 and V2 are merged in the engine and recorded in `engine-compatibility.md`. `ENGINE_REF` pins the minimum.
- [ ] The browser performs every visuals action only by invoking supported engine commands. The UI and backend never write, move or delete engine-owned files directly; reading documented artifacts is the only direct file access.
- [ ] Network requests go only to hosts the reviewer confirmed for that exact acquisition. The confirmation is bound to the engine's canonical preview (`preview_sha256`), checked by the backend and by the engine, and invalidated by any parameter or revision change. With `YTA_VISUALS_NETWORK=false` there are none. No paid call is possible from the UI.
- [ ] Image integrity holds end to end:
  - selection, clearance, validation and apply verify the image bytes against the engine's recorded hashes;
  - a changed, missing or replaced image is refused with `image_integrity`;
  - a clearance never applies to different bytes or changed rights evidence;
  - images are served only by engine ID, from recorded paths and hashes, verified on the exact bytes sent.
- [ ] Every mutation, including acquire after its network phase, is checked against the revision the reviewer loaded. Conflicts never overwrite.
- [ ] Rights status and reasons are the engine's. Placeholder, mock and uncleared `manual_review` images are never shown as publishable. Clearances need the exact acknowledgement and are kept in a hash-chained history, which is part of the visuals revision, when replaced or revoked.
- [ ] Imports reach the engine only as bytes on stdin, size- and format-checked; no path crosses the boundary.
- [ ] Apply warns about G1 and leads to re-approval. G3 is shown as the engine reports it, never approved or inferred by the UI.
- [ ] The required real-engine test reaches `G3 visuals: ready` offline with genuinely licensed images. M1–M3 flows still pass, and CI and the real-engine script pass.
- [ ] The gallery and forms meet WCAG 2.2 AA at all three widths, at 200% zoom and with reduced motion.
- [ ] Each PR is reviewed, with no automatic merge.

## Claude Code handoff
- **Read first:** `CLAUDE.md`, `docs/architecture.md`, `docs/engine-compatibility.md`, `docs/api-contract.md`, `docs/ui-design.md`, this file, and the engine's `docs/milestone-4-visuals.md` and decisions D-58…D-75.
- **Order:** V1, V2 on engine feature branches, then UI-A, UI-B.
- **Verify engine facts** again at the current engine `main` before relying on them, and never invent adapter flags the engine lacks.
- **Process:** each PR is a draft with its own tests and docs, merged only on the owner's explicit request.
