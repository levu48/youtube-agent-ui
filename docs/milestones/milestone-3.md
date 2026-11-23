# Milestone 3 — Research Workspace: Claims, Sources, Evidence Review and G2 Approval

**Status:** complete (2026-11-23). Three separate engine PRs (E1, E2, E3) were prerequisites. All three are merged: E1 (engine PR #12, D-118, `8b1a766`), E2 (PR #13, D-119, `de1e876`) and E3 (PR #14, D-120, `fb6bffc`). UI-A (the workspace and collection jobs) is merged (UI PR #7, `3b6eb8f`); UI-B (review, evidence, decisions, documents, attestations) is merged (UI PR #8, `1fb1e45`); UI-C (G2, apply, export, the required G2 success test) is merged (UI PR #9, `958aeb1`); the manual live smoke test is recorded (UI PR #10, `3f03878`). Verification: [m3-verification.md](../m3-verification.md).

**Goal:** a reviewer can research every factual statement of an approved draft in the browser, approve the research (G2) and apply it, with the `youtube-agent` engine as the only authority. This covers:
- the claim inventory and its classification;
- explicit source discovery and collection;
- source snapshots and exact evidence passages;
- supporting and contradicting evidence;
- translated quotations traced to their originals;
- human review decisions with a durable history;
- unresolved claims;
- research validation and explicit G2 approval.

**Numbering.** The engine calls this stage **M5** (`docs/milestone-5-research-evidence.md`, decisions D-76…D-87 and D-90); the UI roadmap calls it **M3**. This document uses the UI numbering and quotes engine names as they are.

## Existing baseline
**UI.** M1 and M2 are merged (UI `main` @ `a40cec2`, `ENGINE_REF` `573ebdd`). M3 reuses:
- the app shell and loopback/CSRF/origin security;
- project confinement;
- `JobManager`: durable jobs, SSE, cancellation, restart recovery and `exclusive` holds;
- the allowlisted argv adapter (`backend/app/engine/commands.py`, `service.py`, and `runner.py` with stdin support);
- M2's patterns: revision-checked edits (`_edit_failure`), the approval panel, the conflict dialog, unsaved-edit recovery, and the tabbed workspace with its section navigator.

**Engine at `573ebdd`.** It has a complete research workflow (details in [engine-compatibility.md](../engine-compatibility.md#milestone-3-research-engine-m5-verified-at-573ebdd)):

```
G1 current → research-plan → research-collect / research-add-url → research-link
→ (hand-edit research-review.json) → research-check → research-approve (G2)
→ research-apply (claim IDs into scenes; G1 becomes stale_after_apply) → draft-approve (G1 again) → research-export
```

Verified properties the design relies on:
- **Files.**
  - Human-edited: `research-plan.json`, `evidence.json`, `research-review.json`.
  - Tool-owned: `research.json`, `render/research/snapshots.json`, `render/research/pages/<sha256>.txt`, `research-approval.json`, the reports and the exports.
  - A tool-owned file edited by hand becomes untrusted (`invalid_file`).
- **G2 binding.** sha256 of `input.json`, `outline.json` and `script.json`, plus the exact bytes of the three human files, the narration fingerprint, the cited snapshot records, the source versions and the policy version (`m5-research-2`). Any change makes the approval `stale`. `storyboard.draft.json` is not bound.
- **Human-only verification.**
  - No code writes a review. `suggested_status` is a hint.
  - `verified` needs:
    - a real-person reviewer and a substantive rationale;
    - a non-fixture `supports` passage;
    - a contradiction resolution when contradicting evidence exists;
    - for contested or interpretive claims, two independent roots (or an exceptional primary basis), a counter-search and a counterargument;
    - for quotations, a verbatim primary passage or a traced translation.
- **Fixture data never passes.** Fixture snapshots block (`fixture_evidence`). Fixture-drafted narration blocks today whenever the storyboard's `generated_by` starts with `fixture:`, and `draft-edit` does not change that.
- **Evidence passages.** NFC Unicode code-point offsets with an exact quote match. Snapshot text is re-hashed before each use.
- **Network.**
  - The only paths are Wikipedia search (`vi.`/`en.wikipedia.org`) and the page fetcher (https only, public IPs pinned, robots.txt on every redirect, size caps).
  - There is no paid or keyed provider. `research-collect` fetches *every* unfetched relevant source, including queued URLs on any host. `research-add-url` fetches live by default.
- **G1 interplay.**
  - Research commands need a current G1 for the input, outline and script.
  - `research-apply` makes G1 `stale_after_apply`.
  - `draft-edit` refuses once research files exist (`downstream_artifacts`).

## Critical dependency — engine capabilities (E1, E2, E3)
The UI never writes, moves or deletes engine-owned files. At `573ebdd` a browser cannot drive research safely:
- review decisions, claim edits and evidence edits or removals are hand edits only;
- no research command takes an expected revision, and none reports one;
- only `research-check` prints JSON, and exit 2 is shared between invalid input and a human-edit conflict;
- there is no progress output, no host-level network control and no offline source;
- fixture provenance is all-or-nothing.

Three engine PRs in `youtube-agent`, each with a decision entry, README update and tests, are reviewed and merged before the UI PR that needs them. If one cannot land, the UI ships only what the merged capabilities allow and does not claim M3 complete.

### E1 — research CLI contract (no policy change; engine PR #12, D-118)
- **Research revision.** `research-check --json` adds `revision`: sha256 of the canonical JSON `{"files": {rel: sha256|null}, "narration_fingerprint": fp|null, "scheme": "m5-research-revision-1"}`. The files are:
  - `input.json`, `outline.json`, `script.json`;
  - `research-plan.json`, `evidence.json`, `research-review.json`;
  - `research.json`, `render/research/snapshots.json`, `research-approval.json`;
  - `render/llm/narration-provenance.json` (E3; `null` until it exists).

  The storyboard's bytes are not in the revision, because `research-apply` changes only its claim IDs and `visuals-apply` only its shots. Its **narration fingerprint** is (ordered scene, section, language and NFC narration, excluding shots and claim IDs), because G2 binds it: a narration change in the storyboard alone changes the revision, while claim-ID-only and shot-only changes do not.
- **Expected revision.**
  - `--expect-revision=R` on `research-plan`, `research-collect` (including `--dry-run`), `research-add-url`, `research-link`, `research-approve`, `research-apply` and `research-export`.
  - It is checked under the project lock after journal recovery.
  - A mismatch gives `revision_mismatch` (exit 9) with `current_revision`.
- **Re-check after the network phase.** `research-collect` and `research-add-url` check the revision at the start. Then, under the lock and before publishing, they recompute it over everything they read. On a change they refuse with `revision_mismatch` and publish nothing. Unreferenced content-addressed page files may remain. Success returns the new `revision`.
- **Fetch-plan preview.** `research-collect --dry-run --expect-revision=R --json` contacts nothing. It returns:
  - `revision`;
  - `search_hosts`;
  - `provider_result_hosts`: fixed per provider; for Wikipedia, `{lang}.wikipedia.org` for each chosen language. These are potential destinations of search results, not guaranteed requests, and are listed only when searches are pending and pages will be fetched;
  - `known_targets[{source_id, url, host, reason}]`: queued and discovered sources that would be fetched;
  - `hosts`: the union of the above;
  - `plan_sha256`: a hash of the revision, the parameters and `hosts`.

  The hosts are a conservative permission scope, not a forecast: a run contacts a subset of them.
- **Host allowlist.**
  - `--allow-host=H` (repeatable) is required for every live fetch in `research-collect` and `research-add-url`.
  - It is enforced on every search request, every fetch and every redirect hop, including redirects of the Wikipedia API itself (the search provider confines its own requests; its client accepts both language wikis) and redirects of a page's `robots.txt`.
  - Any other host is not contacted. The attempt is recorded as `host_not_allowed` (discovered, not fetched) and shows up in the next preview. A `robots.txt` redirect to an unconfirmed host is reported as `host_not_allowed`, not as a robots disallow. A refused search redirect is a `host_not_allowed` search, not a failed search.
  - Without `--allow-host`, live network use stops with exit 2 (`invalid_input`) before anything is contacted. Queued URLs and fixture runs need none.
- **`--json` on every research command.** Results are `{"ok": true, …, "revision"}`; errors use the draft commands' envelope `{"ok": false, "error": {"code", "exit_code", "message", …}}` on stdout, with the message also on stderr. The codes are:
  - `invalid_input`, `human_edit_conflict` (now distinct from `invalid_input`);
  - `revision_mismatch`, `concurrency`, `unresolved_publication`;
  - `approval_stale` and `g1_not_current` (both exit 12), `not_approvable` (14), `partial_search_failure` (15, with the saved partial result in `details`);
  - `provider_unavailable`, `llm_error`.
- **Two exceptions to the envelope.**
  - `research-check --json` prints the report's own fields plus `revision`, with no `ok` field, and exits 14, still printing the JSON, when the research is not approvable.
  - A command line argparse cannot parse (unknown flag, missing required option, invalid choice) exits 2 with argparse's usage message on stderr and nothing on stdout, with or without `--json`. The backend's allowlisted argv should never produce one; it treats exit 2 with empty stdout as an adapter error.
- **Progress.** `research-collect` writes one stderr line per search and per fetch outcome.
- **Read contract.** `render/research/snapshots.json` and `render/research/pages/<sha256>.txt` are documented, read-only artifacts. Readers verify `text_sha256`.

### E2 — `research-edit` and review policy `m5-research-3` (needs E1)
**Command:** `research-edit --project-root=P --expect-revision=R --json [--dry-run]`.
- The patch comes on stdin, at most 1 MiB, with a strict schema: no `null`, no unknown fields.
- It is an ordered list of operations, published as one generation. Under the lock the engine recovers, checks the revision, applies, validates the schemas and cross-references, and publishes atomically through the research journal.
- Files are written canonically (`model_dump_json(indent=2)` plus a newline). Unchanged files stay byte-identical, so a no-op does not make G2 stale.

| Operation | Fields | Engine-computed |
|---|---|---|
| `claims.update` | `id`, `assertion?`, `kind?`, `flags?`, `contested?`, `notes?`, `search_queries?` | |
| `claims.add` | `anchor: {scene_id, start, end}` or `{scene_id, excerpt, occurrence?}`, `assertion`, `kind`, `flags?`, `contested?`, `notes?` | `id`, anchor `excerpt`, `narration_sha256`, `origin: "editor"` |
| `claims.remove` | `id` | refused while evidence or a review references the claim |
| `evidence.add` | `claim_id`, `snapshot_id`, `quote`, `occurrence?`, `role`, `explanation`, `source_type?`, `evidence_root?`, `is_translation?`, `translator?`, `original_language?`, `translation_of?` | `id`, offsets, the original's offsets |
| `evidence.update` | `link_id`, `role?`, `explanation?`, `source_type?`, `evidence_root?` | |
| `evidence.set_translation` | `link_id`, `translation_of`, `translator?`, `original_language?` | the original's offsets |
| `evidence.clear_translation` / `evidence.remove` | `link_id` | |
| `reviews.set` | `claim_id`, `status`, `reviewer`, `rationale`, `counterargument_summary?`, `counter_search_done?`, `contradiction_resolution?`, `narration_qualifies_dispute?`, `exceptional_primary_basis?` | `reviewed_at`, `basis`; the previous review goes to history |
| `reviews.clear` | `claim_id`, `reviewer`, `reason` | the cleared review goes to history |
| `completeness.set` | `reviewer`, `statement` | `confirmed_at`, `narration_fingerprint`, `inventory_fingerprint`; the previous attestation goes to history |
| `source_rechecks.add` | `source_id`, `cited_snapshot_id`, `expected_current_snapshot_id`, `claim_ids`, `reviewer`, `rationale` | `id` (`rc-` plus 16 hex), `reviewed_at` |
| `source_rechecks.update` | `recheck_id`, `reviewer`, `claim_ids?`, `rationale?` | the previous record goes to history |
| `source_rechecks.remove` | `recheck_id`, `reviewer`, `reason` | the removed record goes to history |
| `migrate_ids` | (none) | IDs for legacy evidence links and legacy source rechecks |
| `migrate_review_file` | (none) | upgrades `research-review.json` from `m5-review-0.1` to `m5-review-0.2` (see Legacy review migration) |

`translation_of` is `{snapshot_id, quote, occurrence?, language, speaker, equivalence_note}`. The original quote is located like the main quote. A dry run returns `occurrences` with context for both quotes.

**Persistent IDs.**
- `EvidenceLink.id` (`ev-` plus 16 hex) and `SourceRecheck.id` (`rc-` plus 16 hex) are assigned once, stored in the human files, kept by every update and never reused, even after removal.
- No ID anywhere is derived from content.
- An exact duplicate link (same claim, snapshot, offsets and role) is refused.
- Legacy links and rechecks get IDs only through the explicit `migrate_ids` operation. It changes the files, and so makes G2 stale; this is documented, and the UI asks for confirmation. Until migrated they are read-only in the UI.
- `reviews.set` is refused while the claim still has links without an ID.

**Translation provenance.**
- `is_translation`, `translator`, `original_language` and `translation_of` can be set on add, replaced with `set_translation` (including a legacy free-text `translation_of`, which never counts), or removed with `clear_translation`.
- Translation problems found by the engine (`_translation_problems`, D-83) are reported per link.

**Review basis: component fingerprints.** `reviews.set` stores:

```json
"basis": {
  "scheme": "m5-review-basis-1",
  "claim":     "<sha256 of canonical {assertion, kind, contested, flags (sorted)}>",
  "anchors":   "<sha256 of canonical [{scene_id, start, end, excerpt, narration_sha256}, …]>",
  "evidence":  { "<link_id>": "<sha256 of canonical link content: id, role, quote, start, end, snapshot_id, explanation, source_type, evidence_root, is_translation, translator, original_language, translation_of>" },
  "snapshots": { "<snapshot_id>": "<text_sha256>, or for imported snapshots {text_sha256, provenance_sha256}" }
}
```

- **Flags are part of the claim component.** `quotation` and `contested` change the engine's rules, and the others (date, number, attribution, causation, uncertain, question, named subject, source needed) change what the reviewer must check.
- **`research-check` recomputes every component.** On any difference it reports a blocking `review_outdated` item listing the changed components: `claim`, `anchors`, `evidence.added`, `evidence.removed` and `evidence.changed` (with link IDs), and `snapshots.changed` (with IDs). The claim is then treated as `unverified`.
- **A review without a `basis` counts as outdated**, whether hand-written or written before this policy. A previous `verified` decision never carries over to changed wording, flags, anchors, evidence or snapshots.
- **`research-check` never writes.** An outdated review stays in place, marked outdated, until a reviewer replaces or clears it.

**Completeness is bound to the narration and the claim inventory.**
- `completeness.set` stores `narration_fingerprint` and `inventory_fingerprint`. The inventory fingerprint is the sha256 of the canonical, sorted list of every claim's `{id, assertion, kind, contested, flags, anchors}`, plus the leads and the uncovered-sentence set.
- Adding, removing or changing a claim, or a change in coverage, gives `completeness_stale`, which blocks.

**Review history: durable and append-only.** `research-review.json` (schema `m5-review-0.2`) gains `history[]`:

```json
{
  "id": "hist-<16 hex>",
  "seq": 1,
  "prev_sha256": "<sha256 of the previous entry's canonical JSON, or null for the first>",
  "kind": "claim_review | source_recheck | completeness | primary_source_attestation | migration",
  "subject_id": "<claim_id | recheck_id | snapshot_id | null>",
  "action": "replaced | cleared | updated | removed | migrated",
  "at": "<engine time, timezone-aware>",
  "by_reviewer": "<the reviewer performing the action>",
  "reason": "<required for cleared/removed, optional otherwise>",
  "previous": { "...": "the full previous record, including its basis or fingerprints" },
  "outdated_components": ["claim", "evidence.changed:ev-…"]
}
```

- **Write rules.** Every replacement, clearing, update or removal appends exactly one entry with the full previous record. Entries are never modified, reordered or deleted by any command.
- **Integrity.** `seq` is contiguous and `prev_sha256` forms a hash chain. A gap, a reorder or an edit gives the blocking `history_tampered` item.
- **Retention.** History is kept for the life of the project. There is no cap and no pruning. `research-plan --replace-plan` rewrites only `research-plan.json`, so the history stays.
- **Size.** `research-check` warns (non-blocking `history_large`) above 10,000 entries. An archival command is a possible later addition and not part of M3.
- **Binding.** History is part of the G2-bound bytes of `research-review.json`.

**Source rechecks per cited snapshot.** Different claims may cite different snapshots of the same source, and one claim may cite more than one. A recheck is therefore identified by the triple **(`source_id`, `cited_snapshot_id`, `current_snapshot_id`)**, matching how the engine already looks rechecks up (`checks.py:425`).
- **`source_rechecks.add`.**
  - It names the cited snapshot explicitly; the engine never infers it.
  - `expected_current_snapshot_id` must equal the source's current snapshot, or the operation is refused with `recheck_target_changed`.
  - Every listed claim must have at least one link to `cited_snapshot_id`. A claim citing another snapshot of the same source needs its own recheck for that snapshot.
- **One active recheck per triple.** Adding a second is refused (`recheck_exists`, with its ID), and `source_rechecks.update` adds or removes claims instead.
- **Report.** `research-check` reports `source_changed` and `source_recheck_stale` per (claim, cited snapshot), and the item carries `source_id`, `cited_snapshot_id` and `current_snapshot_id`. The UI groups the items by (source, cited snapshot) and offers one recheck per group.
- **When the source changes again,** a recheck becomes stale: it stays in the file, and the item asks for a new recheck for the new triple. Replacing it moves the old one to history.

**Legacy review migration (`m5-review-0.1` → `m5-review-0.2`).**
- **Reading is unchanged.** The engine keeps reading `0.1` files as they are and never rewrites them implicitly. Under policy `m5-research-3`, every `0.1` review lacks a `basis` and so counts as outdated, and the `0.1` completeness attestation lacks an `inventory_fingerprint`, so it counts as `completeness_stale`.
- **Writing needs migration first.** On a `0.1` file, `research-edit` refuses every operation except `migrate_review_file` and `migrate_ids`, with `migration_required`.
- **`migrate_review_file`** rewrites the file as `0.2`, in one publication:
  - every review is kept verbatim (status, reviewer, `reviewed_at`, rationale and all other fields) with `basis: null`. It stays outdated, with the component `basis_missing`;
  - the completeness attestation is kept with `inventory_fingerprint: null`, so it is stale;
  - rechecks are kept and get `rc-` IDs (it implies `migrate_ids` for rechecks);
  - `history` starts with one entry: `kind: "migration"`, `action: "migrated"`, `previous: {schema_version: "m5-review-0.1", sha256: <the old file's bytes>}`.
- **Re-confirming decisions.** Nothing is lost, and no decision becomes current without a person. The UI offers **Confirm again** on an outdated review. That is a `reviews.set` with the same fields, which records a fresh `basis` and moves the migrated record to history.
- **G2.** Migration changes the file, so an existing G2 becomes stale. The UI says so before the reviewer confirms.

**Other policy.**
- Review text fields are capped at ≤4000 characters.
- The only way to set a status is an explicit `reviews.set`. Status is never derived from evidence.

**Report:** `status` (`published`, `already_current` or `would_publish`), `previous_revision`, `revision`, `changed_files`, `check`, `approval_status`, plus `occurrences` for a dry run.

### E3 — imported documents and narration lineage (needs E2)
**`research-add-document`**, with the document text on stdin: `research-add-document --project-root=P --title=T --language=L --citation=C --imported-by=NAME [--edition=E] [--declared-url=U] [--original-published-at=D] [--license=L] [--note=N] [--new-version-of=doc-…] --expect-revision=R --json`.
- The text is plain only, ≤400,000 characters after NFC.
- The engine records a source with `source_type: user_supplied`, and a snapshot with `acquisition: "imported"` and its own **edition provenance**:

  | Field | Required? | Set by |
  |---|---|---|
  | `title`, `language` | required | reviewer |
  | `citation` | required: a bibliographic citation or archive reference for **this** edition | reviewer |
  | `imported_by` | required, `real_person` | reviewer |
  | `imported_at` | | engine |
  | `edition`, `declared_url`, `original_published_at`, `license`, `note` | optional | reviewer |
  | `supersedes_snapshot_id` | set when imported with `--new-version-of` (the source's previous current snapshot) | engine |

- No network is used.
- Every snapshot then carries `acquisition`: `"retrieved"` (fetched by the engine), `"imported"` or `"fixture"`. Reports and link references include it.

**Identity of imported documents.** Today `Source.url` is required and is the source's identity (`id = "src-" + sha256(normalised url)[:12]`), and `SourceSnapshot.requested_url` and `final_url` are required. Offline documents need these schema changes:
- **`research.json` → `m5-research-0.2`.** `Source` gains `kind: "web" | "document"` (default `web`).
  - **Web sources** are unchanged: `url` is required and is the identity.
  - **Document sources:**
    - `url` is `null`;
    - `id = "doc-" + 16 hex`, assigned once at import and never reused;
    - no provenance on the source itself: provenance belongs to each edition (snapshot) below. The source keeps only its snapshot list, as web sources do.
  - A validator enforces "web ⇔ `url` present"; a document source has `url: null`.
- **`snapshots.json` → `m5-snapshots-0.2`.** `SourceSnapshot` gains `acquisition`, plus `document_provenance` for imported snapshots: `{title, language, citation, imported_by, imported_at, edition?, declared_url?, original_published_at?, license?, note?, supersedes_snapshot_id?}`.
  - `requested_url` and `final_url` become optional. They are required when `acquisition` is `retrieved` and `null` for `imported`.
  - `document_provenance` is required exactly when `acquisition` is `imported`, and forbidden otherwise.
  - For imported snapshots: `retrieved_at = imported_at`, `http_metadata = {}`, `extraction_version = "import-1"`, and the snapshot `id` is `snap-` plus 16 hex of sha256(source ID | `text_sha256` | the canonical provenance hash), so that every edition has its own ID.
  - `declared_url` is data only. It is never fetched, never a source identity, and never merged with a web source that has the same URL.
- **Editions keep their own provenance.**
  - **Immutable per edition.** Each snapshot is one edition, with its own provenance, fixed at import. No command edits it.
  - **Correcting a citation or any other provenance field** means importing a new edition with `--new-version-of=doc-…`. That needs a complete provenance of its own; nothing is inherited silently. The UI may pre-fill the form from the previous edition, but the reviewer submits every field.
  - **The new edition** records `supersedes_snapshot_id`, becomes the source's current snapshot, and gives claims citing the older edition `source_changed`, exactly as for web sources. The older edition and its provenance stay unchanged and citable.
  - Re-importing identical text, as a new document or as a new edition with identical provenance, is refused (`document_exists`, with the ID).
  - A new edition with identical text but corrected provenance is allowed. Its snapshot ID differs because the edition record differs; it is computed from the source ID, `text_sha256` and the provenance hash.
- **Never fetched.** Document sources are excluded from every network path:
  - `research-collect` never selects them (not in `to_fetch`, not in the preview's `known_targets`, never counted against `--max-pages`);
  - `research-add-url` cannot target them;
  - `--allow-host` is irrelevant to them.
- **Upgrading older files.**
  - Engines with E3 read `0.1` files as all-web, with `acquisition` derived (`fixture` when the record is fixture, otherwise `retrieved`). They write `0.2` on the next tool write.
  - The G2 binding hashes cited snapshot records in a canonical form where `acquisition` is the derived default, so a pure schema upgrade does not make G2 stale.
- **G2 binds cited provenance.**
  - For every cited imported snapshot, the G2 binding (`used_snapshots`) includes the sha256 of its canonical `document_provenance` alongside `text_sha256`. So does the research revision (through `snapshots.json`).
  - Any change to a cited edition's citation, attribution (`imported_by`, `license`), dates, edition, declared URL, note or `supersedes_snapshot_id` makes G2 stale.
  - Because provenance is immutable and tool-owned, such a change can only come from tampering. A hand-edited `snapshots.json` is untrusted (`invalid_file`, blocking).
  - The review basis's `snapshots` component for an imported snapshot is `{text_sha256, provenance_sha256}`, so the reviews citing it become outdated as well.
  - A primary-source attestation is bound to the attested edition's `text_sha256` and `provenance_sha256`, and is outdated if either changes.

**Imported evidence is not retrieved evidence.**
- An imported document never counts as an independent root.
- It may support a claim as user-supplied evidence. It counts as a **primary source** (a verbatim primary passage for a quotation, or an `exceptional_primary_basis`) only after a **primary-source attestation**: the `research-edit` operation `documents.attest_primary {snapshot_id, reviewer, statement}` (added by E3).
  - The attestation is stored in `research-review.json` under `primary_source_attestations[]` as `{snapshot_id, text_sha256, provenance_sha256, reviewer, statement, at}`. The engine records the two hashes of the attested edition.
  - It is bound by G2 and recorded in history when replaced or removed (`documents.revoke_primary {snapshot_id, reviewer, reason}`).
  - It applies to one edition (snapshot) only: a new edition needs its own attestation. It is outdated if that edition's `text_sha256` or `provenance_sha256` changes.
- The UI labels such evidence "Imported document — not retrieved by the engine", and separately marks attested primary sources.

**Narration lineage: fixture provenance that trivial edits cannot clear.**
- **The lineage record.** Tool-owned `render/llm/narration-provenance.json` (schema `m3-narration-provenance-1`) records one **segment** per narration sentence: `{segment_id: "seg-"+16hex, section_id, scene_id, text_sha256, origin: "fixture"|"fixture_derived"|"llm"|"human", derived_from: [segment_id…], attestation?, initialized_from?}`, plus per-section `tombstones[]` (deleted fixture segments, kept forever) and an append-only provenance history of attestations.
  - Every `draft` generation writes it for the sentences it produced.
  - Every `draft-edit` updates it in the same atomic publication.
- **How edits are tracked.** Lineage follows sentences, not scenes, so it survives scene splits, merges, additions, removals and section reordering.
  - `draft-edit` diffs the old and new sentences of each section into hunks.
  - Every sentence inserted by a hunk records **all** sentences that hunk deleted in `derived_from`. That is replacement ancestry: a fully replaced paragraph derives from the whole paragraph it replaced, even when no single sentence aligns.
  - A deleted fixture segment is kept as a **tombstone** of its section. Text inserted by a later edit, with no deletion in the same hunk, derives from the section's tombstones, so deleting in one save and writing in another does not escape ancestry.
  - Origins: `fixture` (generated by the fixture provider), `fixture_derived` (any sentence whose ancestry, transitively, includes a fixture segment or tombstone), `llm`, and `human`.
  - **In a project whose draft was ever fixture-generated, no edit produces `human` by itself.** Every new or changed sentence is `fixture_derived` until attested, whether or not it aligns with a predecessor.
  - A sentence whose normalised text equals any fixture sentence or tombstone anywhere in the project is `fixture`, wherever it appears. Normalisation is NFC, casefold, collapsed whitespace, and punctuation and digits removed.
- **Clearing fixture restrictions needs both lineage and an attestation.** A `fixture_derived` segment becomes `human` only when:
  1. its normalised text differs from every fixture ancestor, every tombstone of its section, and every fixture sentence in the project; and
  2. a reviewer attests the rewrite with `narration-attest --project-root=P --reviewer=NAME --statement=S --segment=ID… --expect-revision=R --json` (E3; `real_person` reviewer, substantive statement).

  The attestation is stored on the segment and recorded in the provenance history. Similarity is never sufficient on its own. A segment still very similar to its fixture ancestor (token Jaccard ≥ 0.5) cannot be attested, and gets the message "still close to the fixture text; rewrite it".
- **What blocks.** `fixture_narration` blocks while any current sentence has fixture origin, naming the scenes and segments.
- **Fail closed.**
  - A missing, unreadable, schema-invalid or hand-edited provenance file blocks (`narration_provenance_invalid`) for any project whose draft was ever generated by the fixture provider (per `generated_by` or the generation manifest).
  - So does a provenance file that does not cover every current sentence.
  - Projects drafted before E3 by a non-fixture provider have no provenance file; they fall back to today's `generated_by` rule.
- **Legacy fixture projects (drafted before E3).**
  - They have no provenance file, so they block with `narration_provenance_missing`, without being refused outright.
  - The explicit command `narration-provenance-init --project-root=P --expect-revision=R --json` (E3) initialises lineage, failing closed:
    1. **Recover the fixture originals.** From the engine's verified draft cache (`render/llm`) when present. Otherwise by deterministic offline regeneration with the fixture provider from the recorded `input.json` and draft settings, accepted only if the regenerated draft's recorded hashes match the manifest.
    2. **Mark every current sentence.** Unchanged sentences become `fixture`. Changed or new sentences become `fixture_derived`, with replacement ancestry against the recovered originals and the recovered sentences kept as tombstones.
    3. **If the originals cannot be recovered and verified,** every current sentence is recorded as `fixture` with `initialized_from: "legacy_unrecoverable"`. The current text itself counts as the fixture ancestor, so the reviewer must rewrite each sentence to differ from it, and then attest.
  - The command never marks anything `human`. It is a mutating, revision-checked command, and the result is bound by the research revision and G2.
- **Binding.** The file's sha256 is part of the research revision (E1) and of the G2 binding. Any change makes G2 stale.

## User journeys
1. **Start research.**
   - With a current G1, the workspace offers **Start research**.
   - **Prepare claims** runs `research-plan` as a job, with no LLM and no network.
   - The Research page shows the claims, the outline leads and the uncovered sentences.
2. **Classify claims.**
   - Edit the assertion, kind, flags, contested flag and notes.
   - Add a claim for an uncovered sentence or a selected excerpt, or remove an unreferenced claim.
   - Each save runs `research-edit` under the loaded revision.
3. **Find sources**, where network use is always explicit.
   - **Search Wikipedia.** The backend runs the fetch-plan preview with the loaded revision, and the dialog lists every host in it (search hosts, result hosts, and the hosts of queued and discovered targets). The reviewer confirms that exact list, and collection runs as a job with live logs.
   - **Add a URL.** Queue it (no network), or fetch it now after confirming its host.
   - **Import a document.** Paste the text of an offline source with its citation; no network.
4. **Link evidence.**
   - Open a snapshot (plain text and metadata, labelled retrieved, imported or fixture).
   - Select a passage and choose **Link to claim**. A dry run shows the occurrences, and the reviewer picks one.
   - Set the role, explanation, source type and evidence root. Links can be edited or removed later.
5. **Trace translations.** Mark a link as a translation and pick the original passage (snapshot and occurrence), its language, the speaker, an equivalence note and the translator. A legacy untraced translation shows "not traced" with **Trace to original**.
6. **Attest primary sources** for imported documents that must count as primary, with a statement.
7. **Decide.**
   - Per claim: status (no default), reviewer, rationale, and the conditional fields.
   - `verified` needs an extra confirmation that lists the engine's rules.
   - An outdated review shows "Needs a new decision", what changed, and the history.
8. **Attest completeness, and recheck changed sources.** Correct or remove rechecks when needed.
9. **Validate and approve G2.**
   - **Validate Research** shows the engine's items.
   - **Approve Research (G2)** runs `research-approve --expect-revision` with the revision the reviewer validated.
10. **Apply, approve G1 again, export.**
    - **Apply claim IDs to scenes** warns first that G1 will go out of date, then links to G1 re-approval.
    - **Export** is offered after apply.
11. **Fixture-drafted projects.**
    - The draft page shows which segments are still fixture or fixture-derived.
    - Legacy projects first run **Initialise narration provenance** (`narration-provenance-init`).
    - After rewriting, the reviewer attests the rewrite (`narration-attest`) before research can be approved.
12. **Upgrade legacy research records.** A project whose review file is `m5-review-0.1` shows **Upgrade research records** (`migrate_review_file` plus `migrate_ids`). Decisions are kept, shown as outdated, and offered for **Confirm again**.
13. **Use the CLI** at any step. A change made there appears as a revision conflict or a new state, never as a silent overwrite.

## M3-01 — Compatibility and engine contract
- Record the verified engine facts at `573ebdd` in `docs/engine-compatibility.md`, and re-verify at each engine merge.
- E1, E2 and E3 are separate engine PRs, reviewed and merged in that order. Each UI PR pins its minimum engine in `ENGINE_REF`.
- **Engine tests:**
  - **Revisions:** a mismatch per command, including after the network phase and on `--dry-run`.
  - **Network:** allow-host on requests and redirects; the preview contacts nothing.
  - **JSON:** shapes and error codes.
  - **`research-edit`:** every operation, a byte-identical no-op, and `review_outdated` for each component (claim text, kind, each flag, anchors, added, removed or changed evidence, translation, snapshot).
  - **Completeness:** stale on an inventory change.
  - **History:** append-only on every operation, the hash chain, `history_tampered`, no pruning.
  - **IDs:** stability and `migrate_ids`.
  - **Review migration:** `0.1` read without writes; `migration_required` for other operations; `migrate_review_file` keeps every decision verbatim, outdated (`basis_missing`); the migration history entry; Confirm again via `reviews.set`.
  - **Rechecks:**
    - add, update and remove;
    - two claims citing different snapshots of one source need two rechecks;
    - one claim citing two snapshots needs one recheck per snapshot;
    - `recheck_exists`, `recheck_target_changed`;
    - stale after the source changes again.
  - **Imported documents:**
    - ingestion: Vietnamese, NFC, size limit, required citation;
    - `doc-` identity with no URL, and the `kind`/`url` validator;
    - `declared_url` never fetched or merged;
    - excluded from collect, the preview, `--max-pages` and add-url;
    - `document_exists`; `--new-version-of` giving `source_changed`;
    - per-edition provenance: each edition keeps its own provenance and ID; the older edition is unchanged and citable; `supersedes_snapshot_id` is set; a new edition requires complete provenance, with nothing inherited; identical text with corrected provenance is a new edition;
    - provenance in G2 and the revision: a tampered citation, `imported_by`, licence or date of a cited edition makes G2 stale and the file untrusted; the review basis and the primary attestation become outdated;
    - a `0.1` → `0.2` schema upgrade not making G2 stale;
    - `acquisition`; imported evidence never an independent root; primary attestation and revocation.
  - **Narration lineage:**
    - whitespace, punctuation, digit-only, single-word and reordering edits stay fixture;
    - a fully replaced paragraph with no aligned sentence becomes `fixture_derived` with replacement ancestry, and is never `human` without an attestation;
    - delete-then-insert across two saves still derives from the tombstones;
    - copy-paste of fixture text elsewhere stays fixture;
    - scene splits, merges, additions, removals and section reorder keep the lineage;
    - attestation is refused for unchanged or close text, and accepted for a genuine rewrite;
    - a missing or corrupt provenance file fails closed;
    - legacy init: originals recovered from the cache, or by verified regeneration; the unrecoverable path marks everything fixture; nothing is ever marked `human` by init;
    - provenance changes make G2 stale.
  - **End to end:** an offline CLI path to a successful `research-approve` with a genuinely sourced imported document.

## M3-02 — Backend API (`/api/v1`; CSRF and origin on every mutation)
**Common rules.**
- Paths come only from the validated slug; there are no path or file parameters.
- Mutations hold the project (`JobManager.exclusive`): `409 job_conflict` during a job, `409 project_busy` during another mutation.
- Errors are `{"error": {"code", "message", "details"}}` and never include absolute paths.

**Reads**
- **`GET /projects/{id}/research`** returns:
  - `report`: the `research-check --json` output (`revision`, `items`, `claims`, `coverage`, `approval_status`, `approvable`, `applied`);
  - from `research.json`: `sources[]` with `{id, url, host, state, user_supplied, discoveries, fetches, snapshot_ids}`;
  - from `snapshots.json`: `snapshots[]` with metadata, `acquisition`, and for imported editions `document_provenance` (including `supersedes_snapshot_id`);
  - `evidence[]` with persistent `id`s (`null` for legacy links);
  - `reviews[]` (the current records, with `outdated_components` from the report);
  - `primary_source_attestations[]`;
  - `history_summary`: `{count, last_seq, chain_ok}`;
  - `gate` (G2 from `production-status`), `network: {enabled, providers}`, `editing: {supported, revision, limits}`, `active_job_id`.
- **`GET /projects/{id}/research/snapshots/{snapshot_id}`**:
  - `^snap-[0-9a-f]{16}$` only; the path comes from the index and must stay inside the project;
  - `text_sha256` is verified (409 `snapshot_tampered`);
  - returns the metadata and plain text (≤400k characters).
- **`GET /projects/{id}/research/history?kind=&subject_id=&after_seq=&limit=`**: the review-history read contract.
  - It reads `research-review.json` (a documented human file) without writing, and validates `schema_version` `m5-review-0.2`. An unknown schema gives 502 `engine_unsupported`.
  - It returns `{entries: [...], next_after_seq, has_more, chain_ok}`, ordered by `seq`, with `limit` ≤ 200.
  - `chain_ok` and `history_tampered` reflect the engine's check from the same revision.
  - Read-only: the UI never edits history.

**Jobs** (202 with the job)
- **`POST /projects/{id}/research/plan {expected_revision}`** → `research-plan --expect-revision --json --claim-provider=none`.
- **`POST /projects/{id}/research/collect/preview`** with `{expected_revision, languages ⊂ {vi,en}, claim_ids, max_queries, max_results_per_query, max_pages}`.
  - Synchronous; no network.
  - Runs `research-collect --dry-run --expect-revision --json`.
  - Returns the preview (`revision`, `hosts`, `known_targets`, `plan_sha256`).
- **`POST /projects/{id}/research/collect`** with `{expected_revision, the same parameters, network: true, plan_sha256, allow_hosts: [...]}`.
  - The backend re-runs the preview under the same expected revision immediately before starting.
  - It refuses with 409 `revision_conflict` if the revision changed, or 422 `network_not_confirmed` (with the new preview) if `plan_sha256` or the host set differs from what the reviewer confirmed.
  - Otherwise it runs `research-collect --search-provider=wikipedia --fetch=auto --expect-revision --json` with one `--allow-host` per confirmed host. The engine re-checks the revision after the network phase.
- **`POST /projects/{id}/research/sources`** with `{expected_revision, url, claim_id?, fetch: "queue"|"live", network?: true, allow_hosts?: [host]}`.
  - `live` requires `network: true` and exactly the URL's host.
  - Runs `research-add-url --fetch=queue|live [--allow-host=H] --expect-revision --json`.

**Short engine calls**
- **`POST /projects/{id}/research/documents`**: the document-import API.

  ```json
  { "expected_revision": "<hex64>", "title": "…", "language": "vi", "citation": "…", "imported_by": "Trần Thị B",
    "edition": "2nd edition (optional)", "declared_url": "https://… (optional)",
    "original_published_at": "1945-09-02 (optional, as stated)", "license": "CC BY-SA 4.0 (optional)",
    "note": "… (optional)", "new_version_of": "doc-<16 hex> (optional)", "text": "…" }
  ```

  - Field names match the engine contract (`--declared-url`, `--edition`, `--new-version-of`). There is no `url` field: an imported document is never a fetch target.
  - Limits: `title` ≤300, `citation` 1–2000, `imported_by` as the G1 reviewer, `edition` ≤200, `license` ≤200, `note` ≤4000, `text` 1–400,000 characters.
  - `declared_url`, if given, is https and ≤2000 characters, and is stored as data only (never fetched).
  - `new_version_of` must match `^doc-[0-9a-f]{16}$` and name an existing document source of this project; otherwise 422 before the engine runs. Every provenance field is still required for the new edition.
  - Text is NFC-normalised, and control characters other than newlines and tabs are rejected.
  - Runs `research-add-document` with the text on stdin. Returns `{source_id, snapshot_id, supersedes_snapshot_id, revision}` and the research view.
- **`POST /projects/{id}/research/edit {expected_revision, dry_run, operations: [...]}`**.
  - Strict models mirror E2/E3 (no nulls, no unknown fields, engine limits), and text is NFC-normalised.
  - Runs `research-edit` with the patch on stdin. Returns `{result, research}`, where `research` is omitted for a dry run.
- **`POST /projects/{id}/draft/narration/attest {expected_revision, reviewer, statement, segment_ids}`** → `narration-attest --expect-revision --json` (E3).
- **`POST /projects/{id}/draft/narration/provenance-init {expected_revision, confirm: true}`** → `narration-provenance-init --expect-revision --json` (E3). Only offered for legacy fixture projects.
- **`POST /projects/{id}/research/approve {expected_revision, reviewer, comment?, confirm: true}`** → `research-approve --expect-revision --json`.
- **`POST /projects/{id}/research/apply {expected_revision, confirm: true}`** → `research-apply --expect-revision --json`. Returns the research view and the draft's G1 status.
- **`POST /projects/{id}/research/export {expected_revision}`** → `research-export --expect-revision --json`. Returns the written files as relative paths.

**Error mapping** (the pattern of M2's `_edit_failure`)

| Code | HTTP | Cause |
|---|---|---|
| `revision_conflict` | 409 | the engine reported `revision_mismatch`; `details.current_revision`. Nothing was written. Never retried automatically. |
| `network_disabled` | 403 | `YTA_RESEARCH_NETWORK=false` |
| `network_not_confirmed` | 422 | no `network: true`, or the confirmed `plan_sha256` or hosts differ from the current preview (`details.preview`) |
| `invalid_edit` | 422 | an engine-rejected operation (`details.errors[{loc, msg}]`), including `recheck_target_changed`, `recheck_exists` and `document_exists` |
| `migration_required` | 409 | the review file is `m5-review-0.1`; run the upgrade first |
| `human_edit_conflict` | 409 | the engine refused to overwrite hand edits; resolve in the CLI |
| `research_not_ready` | 422 | approval refused: blocking items (`details.items`) |
| `approval_stale` / `g1_not_current` | 409 | exit 12 |
| `snapshot_tampered` / `history_tampered` / `narration_provenance_invalid` / `narration_provenance_missing` | 409 | an integrity failure reported by the engine or the read checks |
| `engine_conflict` / `unresolved_publication` | 409 | lock held, or an interrupted publication needs the CLI |
| `job_conflict` / `project_busy` | 409 | as in M2 |
| `validation_error` | 422 | request validation |
| `engine_unavailable` / `engine_timeout` / `engine_unsupported` | 503 / 504 / 502 | as in M1 and M2 |

**Never exposed:** `--replace-plan`, `--force`, `--replace-output`, `--claim-provider=ollama|fixture` (fixture only with `YTA_ALLOW_FIXTURE_PROVIDER` in tests), and `resume`. `YTA_HTTP_CONTACT` is never set or passed.

**UI state.** Nothing authoritative. SQLite keeps jobs and events only, and network confirmations are not stored.

## M3-03 — Research workspace UI (`/projects/[projectId]/research`)
**Navigation.**
- **Research** in the sidebar is enabled for a project with a current G1. Otherwise it says why it isn't available.
- The workspace stepper and next action follow the engine's research row and G2 gate.

**Layout.** Tabs **Claims / Sources / Validation**, reusing M2's ARIA tabs, `SplitLayout` (about 28/72; stacked below 1024 px) and `SectionNav`.

**Claims tab**
- **Navigator:** grouped by scene, then section. Filters by status (unverified, needs decision, outdated, verified, disputed, insufficient, editorial), kind and flags. Status badges always carry a text label.
- **Claim panel:**
  - the assertion (project `lang`) and the excerpt highlighted inside its narration;
  - kind, flags and contested;
  - the engine's `suggested_status`, labelled "Tool suggestion — not a verdict";
  - evidence grouped Supports / Contradicts / Context, each link showing its quote, source, acquisition label, retrieval or import details, role, explanation, source type, evidence root and translation provenance (or "not traced").
- **Decision:**
  - the current decision, with an **Outdated** state listing the changed components;
  - a **History** disclosure, loaded from the history endpoint, showing each entry's action, time, reviewer, reason and previous record;
  - the decision form: status with no default; reviewer; rationale with the engine's minimum shown; and the conditional fields.
  - `verified` opens a confirmation listing the engine's requirements, and that the decision is the reviewer's own judgement. `suggested_status` is never pre-selected.
- **Edit controls:** claim fields, Add claim (from an uncovered sentence, or by selecting narration text), Remove.

**Sources tab**
- **Source list:** state (including "host not confirmed"), discoveries, fetch attempts with failure codes in words, snapshots, and the acquisition label.
- **Search Wikipedia:** parameters, then a confirmation listing every host from the preview. The confirmation is valid only for that preview and revision.
- **Add URL:** queue by default, or fetch now with a host confirmation.
- **Import document:** title, language, citation (required), the importer's name, and optional edition, declared URL, original date, licence and note; then the text. A note explains that imported evidence is labelled as such and is not an independent root.
- **Import a new edition** of an existing document: the same form, pre-filled from the previous edition, with every field submitted explicitly. A note says that claims citing the older edition will need a recheck and that G2 will go out of date.
- **Snapshot reader:**
  - plain text only (never HTML), with `lang`;
  - metadata, with the canonical URL marked "declared by the page";
  - for imported documents, this edition's provenance (citation, importer, import date, edition, licence, declared URL, note), a link to the edition it supersedes and to newer editions, plus **Attest as primary source** (per edition) or revoke;
  - selecting text gives **Link to claim…**, which opens a dialog with the dry-run occurrences. The same reader picks a translation's original passage.

**Validation tab**
- Engine items, blocking first, each linked to its claim, recheck or segment, with the engine's text.
- Coverage.
- **Completeness:** the attestation form, and the stale state with the reason (narration or inventory changed).
- **Source rechecks:** grouped by (source, cited snapshot), one recheck per group showing the cited and current snapshot side by side. Add, correct (update: claims or rationale) and remove, with a reason; history shown.
- **Upgrade banner:** for `m5-review-0.1` files, **Upgrade research records**, with a confirmation that decisions are kept but need confirming again and that G2 will be out of date.
- **G2 approval panel**, modelled on M2's `ApprovalPanel`:
  - the engine status, the reviewer and a comment;
  - the disclaimer: "G2 attests that the research was reviewed. It does not make the documentary true, and it starts nothing";
  - the blocker list in the confirmation dialog;
  - disabled with a reason while edits are unsaved, while validating, during a job, or when not approvable.
- **Apply panel:** a warning that G1 will become out of date, then a link to approve the draft again.
- **Export panel:** the written files, or "up to date".

**Draft page addition (E3).** For fixture-drafted projects, a "Fixture text" panel:
- lists the `fixture` and `fixture_derived` segments by scene, with their ancestry;
- offers **Attest rewrite** for eligible segments, and shows the engine's reason when a segment is ineligible (unchanged, too close, or equal to fixture text elsewhere);
- for legacy projects, offers **Initialise narration provenance** first, and says when the originals could not be recovered.

**From M2:**
- edits kept against the loaded revision;
- the conflict dialog (Copy / Keep editing / Reload latest);
- per-tab unsaved-edit recovery with the storage warning;
- typing during a pending save is kept;
- job cards with live engine logs and cancel, and no progress percentages;
- Vietnamese `lang`, NFC handling, and no client-side offset arithmetic: the browser sends quote text, and the engine computes code-point offsets.

## M3-04 — Validation, G2 approval, apply and export
- **Approval** sends the revision the reviewer last validated. Any change in between, from the UI, the CLI or a job, is refused by the engine. A stale G2 is never shown as approved.
- **Nothing runs automatically.** Apply and export are explicit, and nothing advances to visuals.
- **After apply**, G1 shows as out of date until `draft-approve` runs again, using M2's flow.
- **Draft editing.** Once research exists, M2's editor is read-only with the engine's `downstream_artifacts` reason. The research page explains that narration changes need the CLI and make the plan stale.

## M3-05 — Security
- **Unchanged:** loopback binding, host and origin checks, CSRF on every mutation.
- **Argv:** allowlisted per operation. No `shell=True`, no user-supplied flag, path or executable, no force or replace flags. User text travels as separate argv elements or on stdin.
- **Network.**
  - A network request goes only to a host the reviewer confirmed for that action, from an engine preview at the same revision. The engine enforces this with `--allow-host` on every request and redirect.
  - `YTA_RESEARCH_NETWORK=false` disables every network action.
  - The backend never fetches anything itself. No paid services.
  - `YTA_HTTP_CONTACT` is never set or passed, so no personal contact details are sent.
- **Untrusted content.** Snapshot text, imported documents, titles and metadata are untrusted. They are rendered as text only (never HTML or Markdown), links carry `rel="noopener noreferrer"`, and none of it is ever used in a command line.
- **Limits.**
  - Edits ≤1 MiB.
  - Documents ≤400k characters.
  - URL ≤2000 characters, https only.
  - ID patterns validated; history page size ≤200.
- **Reviewer names** are validated as for G1; the engine's `real_person` check is authoritative.

## M3-06 — Tests, CI and handoff
**Backend.**
- **Argv:** builders, the allowlist and the excluded flags.
- **Network:** preview-bound confirmation (stale revision, changed plan or hosts); network disabled.
- **Reads:** the snapshot endpoint (pattern, traversal, tamper); the history endpoint (pagination, schema check, `chain_ok`).
- **Requests:** document import (limits, citation required, NFC, control characters, `declared_url` https-only, `new_version_of` pattern and existence, no `url` field accepted); edit models.
- **Errors:** mapping for every code; `exclusive` holds.
- **Fake engine:** extended with E1–E3 JSON, errors and race modes.

**Real-engine integration (required, offline).** A successful G2 on non-fixture data:
1. create;
2. draft (fixture);
3. rewrite every scene's narration with `draft-edit` and attest the rewritten segments with `narration-attest`;
4. G1;
5. `research-plan`;
6. import a **genuinely sourced document** (below);
7. evidence, including a traced translation where the document provides one;
8. reviews and the completeness attestation;
9. `research-check` approvable;
10. `research-approve` succeeds;
11. `research-apply` (G1 now out of date);
12. `draft-approve`;
13. `research-export`.

The CLI then reports G2 approved and applied.
- **The test document** is a real, openly licensed or public-domain text: for example an excerpt of a Vietnamese Wikipedia article at a fixed `oldid` (CC BY-SA 4.0, attributed), or a public-domain historical document.
  - It is committed under `backend/tests/fixtures/research/` with a `SOURCE.md` giving the URL or archive reference, the revision or edition, the retrieval date, the licence and the attribution.
  - The test narration is human-written, and its claims are actually supported by that text.
  - Nothing is invented, and there is no fixture host.
- **Negative paths:**
  - a stale revision on every mutation, including collect and add-url after the network phase (fixture providers);
  - `review_outdated` per component;
  - `completeness_stale` after an inventory change;
  - `history_tampered`;
  - `fixture_evidence` (exit 14);
  - `fixture_narration` after only trivial edits;
  - an attestation refused for close text;
  - `narration_provenance_invalid`, and `narration_provenance_missing` for a legacy fixture project until init;
  - `migration_required` on a `0.1` review file, then the upgrade and Confirm again;
  - rechecks for two claims citing different snapshots of the same source;
  - `host_not_allowed`;
  - a CLI hand edit producing a UI conflict.

**Frontend component tests.**
- **Decisions:** no status is set without an explicit choice; `verified` needs its extra confirmation; `suggested_status` is never pre-selected; outdated reviews are never shown as current; history renders.
- **Network:** the dialog lists exactly the preview's hosts and is invalidated by a new preview.
- **Sources:** document import validation; acquisition labels.
- **Flows:** occurrences, translations, conflict and recovery.
- **Language:** Vietnamese with `lang`.

**E2E (fake and real engine).** The journey above, plus axe WCAG 2.2 AA on every tab and dialog, 1440, 768 and 375 px, 200% zoom and reduced motion.

**CI.**
- The minimums in `scripts/test-real-engine.sh` rise as tests are added.
- `ENGINE_REF` is bumped per UI PR.
- A live Wikipedia and Ollama smoke test is recorded by hand in `docs/m3-verification.md`, not in CI.

## Delivery plan (independently reviewable PRs; none merged automatically)

```
UI-0 (this spec) ─► E1 engine: research CLI contract ─► E2 engine: research-edit, review policy, history ─► E3 engine: imported documents, narration lineage
                      └─► UI-A read-only workspace + plan / previewed collect / add-URL jobs   (needs E1)
                                                    E1 + E2 + E3 ─► UI-B claims, evidence, translations, decisions, history, documents, attestations
                                                                       └─► UI-C validation, G2, apply, export, G1 again (real-engine G2 success)
```

| PR | Repository | Depends on | Content | Verified by |
|---|---|---|---|---|
| UI-0 | UI | none | this specification, the compatibility section, the API contract, the roadmap | review |
| E1 | engine | UI-0 reviewed | revision (including the storyboard's narration fingerprint); `--expect-revision` (including dry-run, and collect/add-url after the network phase); the fetch-plan preview; `--allow-host` (including Wikipedia and `robots.txt` redirects); `--json` and the error envelope; progress; the read contract. **Merged: engine PR #12, `8b1a766`.** | engine pytest, run locally while engine CI is blocked by billing |
| E2 | engine | E1 | `research-edit`, persistent link and recheck IDs, `migrate_ids`, `migrate_review_file`, per-cited-snapshot rechecks, translation operations, recheck update/remove, component review basis, `review_outdated`, inventory-bound completeness, append-only hash-chained history, policy `m5-research-3`. **Merged: engine PR #13, `de1e876`.** | engine pytest |
| E3 | engine | E2 | `research-add-document` (`doc-` sources, schemas `m5-research-0.2`/`m5-snapshots-0.2`, excluded from network paths) with provenance and `acquisition`, `narration-provenance-init`, replacement ancestry, primary-source attestation and revocation, narration lineage, `narration-attest`, fail-closed provenance, provenance in the revision and the G2 binding. **Merged: engine PR #14, `fb6bffc`.** | engine pytest |
| UI-A | UI | E1 | research reads, the snapshot reader, plan jobs, the **engine fetch-plan preview with expected revision and an explicit confirmed-host allowlist** for collect and add-URL, Research navigation. **Merged: UI PR #7, `3b6eb8f`; pins `ENGINE_REF` `fb6bffc`.** | backend, frontend, E2E, real-engine script, CI |
| UI-B | UI | E1, E2, E3 | the upgrade banner and Confirm again, recheck grouping, provenance init, claim edits, evidence with occurrences, translations, decisions, the history read contract and view, completeness, recheck add/update/remove, the document-import API and form, primary-source attestation, the narration attestation panel, conflict and recovery. **Merged: UI PR #8, `1fb1e45`.** | same |
| UI-C | UI | UI-B | the validation tab, G2 approval, apply, export, G1 re-approval; the required real-engine G2 success test with the genuinely sourced document. **Merged: UI PR #9, `958aeb1`; manual live smoke test recorded in UI PR #10, `3f03878`.** | same, plus the manual live smoke test |

## Non-goals
- Visual selection (M4), narration audio, rendering, publishing.
- Paid search or fetch providers, API keys, accounts, cloud.
- Automatic verification, LLM verdicts or claim suggestions in the UI (`--claim-provider` stays `none`).
- Editing tool-owned files, snapshot text, history entries or the draft from the research page.
- Bypassing robots.txt, paywalls or access controls.
- Force or replace flags, and `resume`.

## Definition of done
- [x] E1, E2 and E3 are merged in the engine and recorded in `engine-compatibility.md`. `ENGINE_REF` pins the minimum.
- [x] The browser performs every research action only by invoking supported engine commands. The UI and backend never write, move or delete engine-owned files directly; reading documented artifacts is the only direct file access.
- [x] Network requests go only to hosts the reviewer confirmed for that specific action, from an engine fetch-plan preview at the same revision. The engine enforces this with `--allow-host` on every request and redirect. With `YTA_RESEARCH_NETWORK=false` there are none.
- [x] Every mutation, including collect and add-url after their network phase, is checked against the revision the reviewer loaded. Conflicts never overwrite.
- [x] A changed assertion, kind, flag, anchor, evidence link, translation or cited snapshot makes the affected review outdated. No claim is ever marked verified automatically or carried over. History is append-only, hash-chained and retained for the life of the project.
- [x] Completeness goes stale when the narration or the claim inventory changes.
- [x] Imported documents are labelled, with immutable provenance per edition (including corrected editions created with `--new-version-of`). Cited provenance is bound by G2. They never count as independent roots, and count as primary only with a per-edition attestation.
- [x] Fixture restrictions are cleared only by lineage, including replacement ancestry and tombstones, plus a reviewer attestation. They survive scene restructuring, fail closed when provenance is missing or corrupt, and are bound by the research revision and G2. Legacy fixture projects need an explicit, fail-closed provenance initialisation.
- [x] Legacy `m5-review-0.1` files are upgraded only explicitly; every decision is preserved and is outdated until confirmed again.
- [x] Offline documents are `doc-` sources without a URL, excluded from every network path. Source rechecks are unambiguous per (source, cited snapshot, current snapshot).
- [x] Research validation shows the engine's items with actionable links. G2 is approved only through `research-approve --expect-revision` and never appears current when stale. Apply makes G1 out of date, and the UI leads to re-approval; export works after apply.
- [x] The required real-engine test completes a successful G2 approval offline with a genuinely sourced, attributed document. M1 and M2 flows still pass, and CI and the real-engine script pass.
- [x] Vietnamese claims, passages, documents and translations work end to end.
- [x] Each PR is reviewed, with no automatic merge.

All items are verified (2026-11-23) by the tests and records in [m3-verification.md](../m3-verification.md):
- the engine facts at `fb6bffc` in [engine-compatibility.md](../engine-compatibility.md), which is the pinned `ENGINE_REF`;
- the backend unit tests, Vitest and Playwright, on both the fake and the real engine;
- the required real-engine G2 success test, offline, with the 1945 *Tuyên ngôn Độc lập* and the 1776 US Declaration (`backend/tests/fixtures/research/SOURCE.md`);
- the manual live Wikipedia and Ollama smoke test.

CI passed on `main` for the merged UI-C code (`958aeb1`). One pull-request run of the same code failed in the UI-B review E2E test: waiting on a cancelled toast animation raised `AbortError`. That is a flaky wait in the test, not a product failure, and the same test passed on `main` and in the local real-engine runs. Each PR was reviewed and merged only at the owner's request; PR #9 and the docs PR #10 were merged before their CI finished, at the owner's request.

## Claude Code handoff
- **Read first:** `CLAUDE.md`, `docs/architecture.md`, `docs/engine-compatibility.md` (the M3 section), `docs/api-contract.md`, `docs/ui-design.md` and this file.
- **Order:** E1, E2, E3 on engine feature branches, then UI-A, UI-B, UI-C.
- **Verify engine facts** again at the current engine `main` before relying on them, and never invent adapter flags the engine lacks.
- **Process:** each PR is a draft with its own tests and docs, merged only on the owner's explicit request.
