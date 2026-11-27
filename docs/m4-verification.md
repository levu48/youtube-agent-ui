# Milestone 4 — manual verification

Records of checks that CI does not run. Each entry names the date, the UI and engine revisions, who ran it, and what was observed.

## Live Wikimedia smoke test (M4-06)

**Status: not run yet.** CI never contacts the network: the required real-engine tests use the fixture search provider and committed public-domain images. This test is run by hand, once per M4 release candidate.

Steps:
1. Start the app with `YTA_VISUALS_NETWORK=true` (the default) and the pinned engine (`ENGINE_REF`).
2. Create a project, generate a draft, and approve it (G1).
3. On the Visuals page, plan visuals, then **Search Wikimedia Commons…**. Check what would be searched: the dialog must list only Wikimedia hosts. Confirm and start.
4. Check that candidates appear with the engine's licence evidence, and that nothing was contacted before the confirmation (the job log starts after it).
5. Select an `accepted` candidate for a scene, validate, apply, and re-approve the draft. Check that the scene shows "Applied and current" and that its applied image is served.

Record: date, UI commit, engine commit, hosts listed, number of candidates, any refusals, and the outcome.

## Manual accessibility acceptance (M4 definition of done)

**Status: not run yet.** Automated axe scans (WCAG 2.2 AA) pass at 1440, 768 and 375 px and at 200% zoom, but axe cannot establish full conformance. This pass is done by hand on the visuals workspace.

Checks:
1. **Keyboard only:** plan, search confirmation, import, choosing and reordering shots, the clearance and revoke dialogs, validate and apply. Every control is reachable, the focus order follows the layout, focus is visible, and focus returns to the opener when a dialog closes.
2. **Screen reader (VoiceOver, Safari or Chrome):** tab names and states, `aria-pressed` on shot toggles ("Shot n"), status and alert messages (saves, conflicts, refusals), image alternatives, and the clearance statement read in full.
3. **Reflow:** 200% and 400% browser zoom with no loss of content or two-dimensional scrolling, apart from the readiness table (a focusable region).
4. **Reduced motion and contrast:** no motion with reduced motion on, and status colours never the only cue.

Record: date, UI commit, browser and assistive technology versions, issues found (with WCAG criterion), and the outcome.
