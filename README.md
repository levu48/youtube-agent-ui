# youtube-agent-ui — Claude Code handoff

Local-only web UI for the separate [`youtube-agent`](https://github.com/levu48/youtube-agent) production engine.

## Read in this order
1. `CLAUDE.md` — coding instructions and boundaries
2. `docs/architecture.md` — architecture and decisions
3. `docs/engine-compatibility.md` — integration contract and verification tasks
4. `docs/api-contract.md` — proposed HTTP API
5. `docs/milestones/README.md` — roadmap
6. `docs/ui-design.md` — layouts, components, interactions, accessibility
7. `docs/milestones/milestone-1.md` — actionable M1 backlog, tests, and definition of done

These files are a **specification**, not an implemented application. Claude Code should create the frontend, backend, tests, and scripts in this repository. Do not modify the separate engine repository.

## Target local layout
```
~/dev/youtube-agent/       # engine repo
~/dev/youtube-agent-ui/    # this repo
~/Documents/YouTubeAgent/projects/  # engine projects
~/Library/Application Support/youtube-agent-ui/ # UI SQLite and logs
```

## Initial handoff
Open Claude Code from the root of this folder and say:

> Read CLAUDE.md and every file under docs/. Implement Milestone 1 incrementally. First inspect the local sibling youtube-agent repository and confirm CLI behavior. Do not modify that repository. Run offline tests and lint. Commit logical increments and open a draft PR; do not merge.
