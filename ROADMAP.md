# selftune Roadmap

## Done
- Two-layer sandbox architecture (Layer 1 local + Layer 2 Docker)
  → [Design: sandbox-architecture.md](docs/design-docs/sandbox-architecture.md)
- Claude Code sandbox (Layer 1 + Layer 2 with `claude -p`)
  → [Design: sandbox-claude-code.md](docs/design-docs/sandbox-claude-code.md)
- Replay and contribute commands (v0.7)
- Skill Health Badges — 3-phase implementation complete:
  - Phase 1: CLI badge generation (`selftune badge --skill X`)
  - Phase 2: Dashboard server `/badge/:skill` and `/report/:skill` routes
  - Phase 3: Hosted service at `selftune.dev` with SQLite storage, community contribution aggregation, and Fly.io deployment
  - CLI `contribute --submit` posts directly to hosted service with GitHub fallback

## In Progress
- Agent-first skill restructure (init command, routing + workflows)
  → [Exec Plan](docs/exec-plans/active/agent-first-skill-restructure.md)
- Multi-agent sandbox expansion
  → [Exec Plan](docs/exec-plans/active/multi-agent-sandbox.md)

## Planned

### Sandbox Expansion
- Codex sandbox (Layer 1 + Layer 2)
- OpenCode sandbox (Layer 1 + Layer 2)
- CI integration (Layer 1 on every PR, Layer 2 on release)
- Fixture expansion with codex/opencode skill profiles

### Skill Quality Infrastructure
- Auto-evolve mode — skills improve without manual intervention
- Marketplace integration — selftune metrics displayed on skills.sh / ClawHub
- Multi-skill conflict detection — identify competing skills for the same query

## Agent Support Matrix

| Agent | Ingestor | Layer 1 | Layer 2 | Design Doc |
|-------|----------|---------|---------|------------|
| Claude Code | ✅ | ✅ | ✅ | sandbox-claude-code.md |
| Codex | ✅ | Planned | Planned | — |
| OpenCode | ✅ | Planned | Planned | — |
