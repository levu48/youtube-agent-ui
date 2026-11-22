# Milestone Roadmap

| Milestone | Scope | Status |
|---|---|---|
| M1 | Local foundation, projects, engine adapter, draft jobs, read-only viewer | Done |
| M2 | Script/outline editing, validation and editorial approval (G1) | Done (UI PRs #3 and #4; engine `draft-edit`, youtube-agent PR #11) |
| M3 | Research claims, sources, evidence review and approval (G2) | Specified ([milestone-3.md](milestone-3.md)); needs engine PRs E1–E3 |
| M4 | Visual planning, candidate gallery, licensing and selection (G3) | Planned |
| M5 | Narration studio: voices, pauses, per-scene preview, timing | Planned |
| M6 | Rendering, captions, production metrics, video preview and final G4 review | Planned |
| M7 | Reliability, packaging, optional secure remote deployment evaluation | Future |

## Rules for milestone progression
- Every milestone gets its own detailed `milestone-N.md`, tests and acceptance criteria before implementation.
- Preserve engine authority and approvals; never replace engine logic with UI logic.
- Complete and verify M1 before expanding into research or rendering features.
- Each milestone is delivered through a reviewed PR; do not merge automatically.

See `milestone-1.md` for the complete M1 backlog.
