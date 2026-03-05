# selftune Roadmap

## Done
- Two-layer sandbox architecture (local + Docker isolation)
- Claude Code sandbox with `claude -p` integration
- Replay and contribute commands (v0.7)
- Skill Health Badges:
  - CLI badge generation (`selftune badge --skill X`)
  - Dashboard server with `/badge/:skill` and `/report/:skill` routes
  - Hosted badge service at `badge.selftune.dev`
  - CLI `contribute --submit` for sharing skill data
- Agent-first skill restructure (init command, routing + workflows)

## In Progress
- Multi-agent sandbox expansion

## Planned

### Sandbox Expansion
- Codex sandbox support
- OpenCode sandbox support
- CI integration (sandbox on every PR)
- Fixture expansion with codex/opencode skill profiles

### Badge Showcase
- Showcase skill health badges for top community skills in the README
- Generate branded SVG badges from real eval results

### Skill Quality Infrastructure
- Auto-evolve mode — skills improve without manual intervention
- Marketplace integration — selftune metrics on community skill hubs
- Multi-skill conflict detection — identify competing skills for the same query

## Agent Support Matrix

| Agent | Ingestor | Local Sandbox | Docker Sandbox |
|-------|----------|---------------|----------------|
| Claude Code | Yes | Yes | Yes |
| Codex | Yes | Planned | Planned |
| OpenCode | Yes | Planned | Planned |
