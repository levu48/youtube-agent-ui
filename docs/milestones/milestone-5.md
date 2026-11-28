# Milestone 5 — Narration studio: voices, pauses, per-scene preview, timing

**Status:** specification (UI-0), drafted 2026-11-28. **The owner decisions below are proposed and not yet approved.** The engine needs prerequisite PRs (N1, and N2 if decisions 2 and 3 are approved) before the UI can drive this stage.
- The baseline below was surveyed read-only at the pinned engine `26c608f`. The fixture provider was run in a throwaway folder. The local Piper voice was not exercised, because the `local-tts` extra is not installed in the survey environment.
- Numbering: UI M5 is about the engine's narration, which is its Milestone 2 (TTS, D-116 pauses) and the narration stage of its Milestone 6. The engine's own "Milestone 5" is research, which is UI M3.

**Goal:** a reviewer can narrate the approved script in the browser, with the engine as the only authority:
- choose a voice the engine knows, and see its rights status;
- set the speed and the pauses (D-116);
- preview one scene before narrating everything;
- narrate (regenerating only what changed), and listen to each scene's published audio;
- see timing per scene and for the whole video against the target;
- see voice-rights status, and record a voice clearance where the voice needs one.

Nothing here renders video or releases anything (M6).

## Existing baseline (engine `26c608f`, verified read-only)

| Area | What exists | Where |
|---|---|---|
| `narrate` | `--storyboard` (required), `--provider fixture\|local` (default `local`), `--voice`, `--speed` 0.5–2.0, `--scene ID` (repeatable; forces those scenes), `--force`, `--replace-modified`, `--replace-output`, `--project-root`, `--audio-dir`, `--work-dir`, `--voices-dir`, `--loudness`, and `--pause-{sentence,paragraph,comma,semicolon}-ms`. **No** `--json`, `--expect-revision` or `--dry-run`; text output only | `cli.py` |
| What it reads | Any `Storyboard` file in which every scene has shots. It checks no gate itself. `storyboard.json` exists only after `draft-export` (current G1). `resume --through narration` narrates the preview adapter storyboard (`--mode preview`, from an approved draft) or `storyboard.json` (`--mode release`, after the release checks) | `drafting.py`, `orchestrator.py` |
| What it writes | Content-addressed scene WAVs `assets/audio/<scene>-<sha12>.wav` (48 kHz stereo, 16-bit); `<stem>.narrated.json` (`audio_path`, `actual_duration_seconds` per scene); `render/tts/manifest.json` (schema 0.4, one `SceneAudioRecord` per file); `render/tts/generation-report.json`. The source storyboard is never changed | `narration.py`, `tts_cache.py` |
| Scene record | `cache_key`, `audio_sha256`, `duration_seconds`, `integrated_lufs`, `true_peak_dbtp`, `provider`, `model_id`, `voice_id`, `language`, `speed`, `rights`, `synthetic_placeholder`, `text_sha256`, `segments[{words, boundary, start_seconds, end_seconds, pause_after_ms}]`, `inserted_pause_seconds`, `generated_at`, `run_id` | `tts_cache.py` |
| Caching | The per-scene key covers the text, language, voice, speed, provider, model (weights hash), settings, and the pauses the scene uses. Every run walks every scene and reuses matching audio. Publication is all or nothing: one failed scene publishes nothing | `tts_cache.py`, `narration.py` |
| Publication | Under `render/tts/manifest.lock`: re-hash the source, an optimistic check, re-verify every WAV, a `pending` journal, staged write and `os.replace`, then garbage collection. Recovered by the next lock holder. **Not** the project lock that `resume` holds | `narration.py`, `tts_cache.py`, `orchestrator.py` |
| Human edits | A generated WAV changed afterwards (by SHA-256, format and sample count) is kept, and its scene fails unless `--replace-modified` is passed. Untracked files and symlinks are never replaced | `tts_cache.py`, `narration.py` |
| Pauses (D-116) | Each value is the exact silence heard, after the voice's own edge silence is trimmed. Defaults: sentence 400 ms, paragraph 800 ms (also at every scene end), comma 50 ms, semicolon 0; range 0–3000 ms (paragraph up to 5000). 0 turns a boundary off. The CLI help wrongly says the comma default is "off" | `models.py`, `pauses.py`, `cli.py` |
| Loudness | EBU R128, −16 LUFS ±1 LU, true peak −1.5 dBTP. Scenes under 1 s are exempt from the tolerance | `models.py`, `narration.py` |
| Voices | `voices` prints the catalogue as text (id, default, language, installed, rights, licence, notes). The catalogue is fixed in code: English `ljspeech-high/medium` **accepted**, `lessac` **rejected**; Vietnamese `vais1000` (the **default**) **manual_review**, `25hours` **rejected**. Models are `<voices-dir>/<id>.onnx` plus `.onnx.json`. Fixture voices produce tones (`not_applicable`) | `local.py`, `base.py` |
| Voice clearance | `voice-clearance.json` at the project root, **written by hand**, never by the tool. It records the voice, the provider, the full weights SHA-256, evidence, the decision, the reviewer, the dates, a rationale of at least 12 words and 80 characters, and the exact acknowledgement "I understand this is my rights attestation, not tool-verified legal advice." | `models.py`, `gates.py` |
| Voice gate | Release only (`gates.voice`). A placeholder voice gives `voice_placeholder`; `rejected` gives `voice_rights_rejected` and cannot be overridden; `accepted` passes; `manual_review` gives `voice_rights_not_cleared` or `voice_clearance_invalid` unless a valid clearance binds the exact weights | `gates.py` |
| Timing | Per scene: `estimated_duration_seconds` (draft) vs `actual_duration_seconds` / `duration_seconds` (narration). Whole video: duration QA against the target (±10% blocks, ±5% warns; at 20 minutes or more, ±60 s / ±30 s), a release blocker. **No per-scene check** | `longform.py`, `orchestrator.py` |
| Fixture text (D-120) | `narrate` ignores narration lineage. Remaining fixture text blocks release (`fixture_narration`), not preview | `gates.py` |
| Providers | `fixture` or `local` (Piper, offline, GPL extra `local-tts`), with no fallback. No network, no cost. `voices` prints a `piper.download_voices` hint, which the UI must never run. A missing model gives `UnsupportedVoiceError` (exit 2); Piper missing or unable to load gives `ProviderUnavailableError` (exit 7). ffmpeg is required (exit 4) | `local.py`, `tts/__init__.py` |
| Exit codes | 2 invalid input or voice, 3 media, 4 ffmpeg, 7 provider unavailable, 8 TTS/narration failure (including a modified WAV), 9 concurrency. No stable JSON codes for narration | `errors.py`, `cli.py` |

## Gaps for a browser studio

| Need | Today |
|---|---|
| One read-only snapshot of the narration: per scene current / stale / missing / modified, durations, loudness, voice used; publication state; a revision token | **missing** (`production-status` gives the stage only; the engine's `TTSCache.snapshot()` takes the lock and is not exposed) |
| Voices as JSON: installed, default, rights, licence, weights hash, clearance status for this project | **partial** (text only) |
| `--json` results and error envelope with stable codes on narration writes | **missing** (only `narrate-text`) |
| `--expect-revision` on narration writes | **missing** |
| A dry run: which scenes would be regenerated, and why | **missing** |
| Narration settings shared by the CLI and the UI (voice, speed, pauses, loudness) | **missing** (flags per run only) |
| A single-scene preview that publishes nothing | **missing** (`--scene` forces a scene, and every scene must succeed) |
| Safe audio serving facts (path and full SHA-256 per published scene) | **partial** (in the manifest file, not in a sanctioned snapshot) |
| Voice clearance through a command, bound to the weights hash | **missing** (hand-written file) |
| Serialisation with `resume` and other project writers | **partial** (`narrate` holds only the TTS lock) |

## Owner decisions (proposed, not yet approved)
1. **What the studio narrates.** **Proposed:** the engine's preview source, the adapter storyboard built from the approved draft, exactly what `resume --through narration --mode preview` narrates, so narration needs no `draft-export` or release checks. Release narration of `storyboard.json` stays a production step (M6). *Alternative:* narrate `storyboard.json`, which needs an export after every G1 approval.
2. **Single-scene preview.** **Proposed:** an engine command that synthesises one scene into a separate preview cache, publishes nothing, and never counts as narration. The UI plays it by hash. *Alternative:* no preview; the reviewer narrates and listens to published audio only.
3. **Voice clearance in M5.** **Proposed:** an engine command records `voice-clearance.json` (as `visuals-edit` records image clearances), bound to the voice's exact weights hash, with the exact acknowledgement, kept in a hash-chained history, and with revocation. The UI never writes the file. *Alternative:* leave clearance to the CLI or M6. Then a Vietnamese project with the default voice cannot become releasable from the browser.
4. **Where settings live.** **Proposed:** an engine-owned `narration-settings.json` (voice, speed, pauses, loudness), written only through an engine command and read by `narrate` and `resume`, so the browser and the CLI narrate the same way. *Alternative:* the UI keeps its own defaults and passes flags on each run; then the CLI does not know them.
5. **Timing.** **Proposed:** show the engine's numbers only: per scene, estimated vs measured seconds and inserted pause time; for the video, the engine's duration QA against the target. The UI adds no per-scene thresholds of its own. If a per-scene judgement is wanted, the engine adds it.
6. **Regeneration controls.** **Proposed:**
   - offer "narrate" (reusing current audio) and "regenerate this scene" (`--scene`);
   - never offer `--force`, `--replace-modified` or `--replace-output`;
   - a scene whose audio was changed by hand is shown and left to the CLI.
7. **Fixture voices.** **Proposed:** as for other fixture providers, available only with `YTA_ALLOW_FIXTURE_PROVIDER`, labelled "test tones: never publishable".

## Critical dependency — engine prerequisites
### N1 — narration CLI contract (reports; no gate or policy change)
- **`narration-state --json`:** one consistent, read-only snapshot. No lock, directory, recovery or write, read and retried like `visuals-state` (D-122). It reports:
  - the source (decision 1) and its hash;
  - the settings in effect, from decision 4;
  - per scene: `state` (`current`, `stale` with reasons such as text, voice, speed, pauses or model, `missing`, `modified`), the published record (`audio_path`, full `audio_sha256`, `duration_seconds`, LUFS, true peak, `segments`, `inserted_pause_seconds`), and the estimated duration;
  - the total measured duration and the engine's duration QA against the target;
  - the pending TTS journal (`recovery_required`);
  - the voice in use with its rights, its weights hash and the release basis (`gates.voice` / `voice_basis` applied to the chosen voice, before any narration);
  - a `revision` over every input.
- **`voices --json`:** the catalogue with `installed`, `default`, `language`, `rights`, licence and notes, `weights_sha256` (when installed), and, with `--project-root`, the clearance status.
- **`narrate --project-root P --json --expect-revision R [--dry-run] [--scene …]`:** narrates the decision-1 source with the decision-4 settings. `--dry-run` lists the scenes it would synthesise, with reasons, and writes nothing. It takes the **project lock**, so it is serialised with `resume`, and checks the revision under the lock. It answers with the `--json` result or the error envelope, with stable codes:
  - `revision_mismatch`, `recovery_required`, `concurrency`;
  - `voice_not_installed`, `provider_unavailable`, `ffmpeg_missing`;
  - `audio_modified` (a WAV changed by hand);
  - `tts_failed`, `invalid_input`.
- **`narration-settings`** (if decision 4): set voice, speed, pauses and loudness with `--expect-revision`, validated as `narrate` validates them.
- **Progress:** one line per scene synthesised or reused, on a progress logger.
- **The comma-pause help text** is corrected.

### N2 — preview and voice clearance (if decisions 2 and 3 are approved)
- **`narrate-preview --scene S --json --expect-revision R`:** synthesises one scene with the current settings, or with overrides given for that preview, into `render/tts/preview/<sha256>.wav`. It publishes nothing and changes no narration state.
- **`voice-clearance --json --expect-revision R`:** `set` with `expected_weights_sha256` and the exact acknowledgement, and `revoke` with a reviewer and a reason. The history is hash-chained and part of the revision. It is refused (`target_changed`) if the weights are not the expected ones.

## Delivery plan (independently reviewable PRs; none merged automatically)
| PR | Repository | Depends on | Content |
|---|---|---|---|
| UI-0 | UI | none | this specification and the roadmap update |
| N1 | engine | UI-0 approved | the narration CLI contract above, with engine tests |
| UI-A | UI | N1 | a read-only narration studio (`narration-state`, voices and rights); the settings form; narrate as a job, with a dry-run confirmation and live logs; per-scene table and timing; hash-addressed audio playback; the recovery banner; `ENGINE_REF` bump |
| N2 | engine | N1 | preview and voice clearance, if approved |
| UI-B | UI | N2 | single-scene preview playback; the voice clearance dialog bound to the weights hash, with history and revocation; the real-engine test |

## UI design (summary; details in UI-A and UI-B)
- **Route:** `/projects/[projectId]/narration`. The sidebar's **Narration** entry becomes live. The project page's next step leads here once G1 is approved.
- **Layout:**
  - **Voice and settings:** the voice (with rights and installed status), speed, the four pauses and loudness, each with the engine's range.
  - **Scenes:** one row per scene with narration text, state, estimated vs measured seconds, loudness, and play buttons for the published and preview audio.
  - **Timing:** the total against the target, as the engine judges it.
  - **Voice rights:** the engine's basis, and the clearance with its history.
- **States are displayed, not derived.** Scene states, staleness reasons, timing verdicts and voice rights are the engine's, in fixed wording, with no frontend state machine.
- **Audio** is served by scene and expected SHA-256 from a record in a snapshot verified current, exactly as M4 serves images:
  - read with `O_NOFOLLOW`, size-capped, hashed, a WAV magic check, then served;
  - immutable cache headers; `audio_changed` for an outdated hash;
  - range requests answered from the verified bytes.
- **Accessibility:** WCAG 2.2 AA, as in M4. Every audio control has a text label. Scene state is never conveyed by colour alone. No autoplay.

## API (sketch; finalised in UI-A and UI-B)
| Method and path | Engine command |
|---|---|
| `GET /projects/{id}/narration` | `narration-state --json`, plus `voices --json --project-root` |
| `GET /projects/{id}/narration/scenes/{scene_id}/audio?sha256=H` | read, verified |
| `GET /projects/{id}/narration/preview/{sha256}` | read, verified (N2) |
| `POST /projects/{id}/narration/settings` | `narration-settings … --expect-revision --json` |
| `POST /projects/{id}/narration/plan` | `narrate --dry-run --expect-revision --json` |
| `POST /projects/{id}/narration/narrate` | `narrate --expect-revision --json [--scene …]`, as a job |
| `POST /projects/{id}/narration/preview` | `narrate-preview --scene … --expect-revision --json` (N2) |
| `POST /projects/{id}/narration/voice-clearance` | `voice-clearance set\|revoke --expect-revision --json` (N2) |

Every write holds the project, needs CSRF and origin, carries `expected_revision`, and is refused first by the backend while recovery is pending, as in M4.

## Security
- **Argv:** allowlisted only.
  - Never `--force`, `--replace-modified`, `--replace-output`, `--audio-dir`, `--work-dir` or `--voices-dir` from the browser.
  - The voices directory is backend configuration, never a request field.
  - The provider is `local`, or `fixture` only when fixture providers are allowed.
- **Network:** none. The backend never runs `piper.download_voices` or any install step. A missing voice or Piper is reported with the engine's message and a documentation link for the local operator.
- **Untrusted content:** narration text and engine messages are rendered as text. Audio is served only as verified WAV bytes, never by path.

## Tests (summary)
- **Backend:**
  - argv builders and excluded flags;
  - the snapshot freshness check;
  - the audio endpoint (outdated hash, symlink, size, magic, range);
  - every error code;
  - recovery refusals;
  - the fake engine extended with N1 and N2.
- **Frontend:**
  - every scene state and staleness reason;
  - the settings form with the engine ranges;
  - the dry-run confirmation;
  - audio controls with labels and no autoplay;
  - the voice-rights display;
  - the clearance dialog bound to the weights hash (UI-B).
- **E2E (fake and real engine):** the studio journey with axe at 1440, 768 and 375 px and at 200% zoom.
- **Real-engine integration (fixture provider, offline):** narrate the approved draft, change one pause, see only the affected scenes stale, narrate again, and play a scene's audio by hash. The CLI reports the same state.
- **Not in CI:** a local Piper voice. That run is recorded by hand in `docs/m5-verification.md`, because Piper and its GPL voices are not installed in CI.

## Non-goals
- Rendering, captions and video preview (M6). Release narration of `storyboard.json` (M6).
- Installing Piper or downloading voices. Adding voices to the engine catalogue.
- Pronunciation overrides for `narrate` (`narrate-text` has them; a later milestone may add them).
- Paid or network TTS providers.
- Editing audio in the browser. Replacing hand-modified audio.

## Definition of done
- [ ] N1 (and N2, if approved) merged in the engine, recorded in `engine-compatibility.md`, with `ENGINE_REF` pinning the minimum.
- [ ] The browser narrates only through allowlisted engine commands. No engine file is written by the UI, and no network or paid provider is reachable.
- [ ] Voice, speed, pauses and loudness are set through the engine and used identically by the CLI (decision 4).
- [ ] Per-scene state, staleness reasons, durations and loudness are the engine's, from one snapshot. Timing against the target is the engine's verdict.
- [ ] Every narration write is checked against the loaded revision. Conflicts never overwrite. Hand-modified audio is shown and never replaced from the browser.
- [ ] Audio is served only by scene and expected hash, from a verified current snapshot, on verified bytes. An outdated URL gets `audio_changed`.
- [ ] Voice rights are the engine's. A `rejected` or placeholder voice is never shown as publishable. A clearance (if decision 3) is bound to the exact weights and needs the exact acknowledgement.
- [ ] While a TTS publication is pending, the studio shows it and offers no narration action.
- [ ] The required real-engine test passes offline with the fixture provider. The manual Piper run is recorded.
- [ ] WCAG 2.2 AA by axe at all three widths and at 200% zoom; manual accessibility acceptance recorded.
- [ ] Each PR is reviewed, with no automatic merge.
