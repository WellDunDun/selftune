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
- Local Dashboard SPA:
  - React + Vite + TypeScript SPA with shadcn/ui and Tailwind v4
  - Overview page with KPI cards, skill health grid, evolution feed
  - Per-skill drilldown with evidence viewer, evolution timeline
  - SQLite v2 API endpoints (`/api/v2/overview`, `/api/v2/skills/:name`)
  - Dark/light theme toggle with selftune branding
  - SPA served at `/` as the supported local dashboard

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

### Personalization SDK (Vision)

- **SDK for skill creators** — `selftune.config.ts` lets creators declare tunable surfaces (descriptions, workflows, parameters) vs fixed surfaces (core logic, tools)
- **Per-user adaptation** — Skills evolve locally to match each user's language and workflow patterns, while preserving the author's canonical version
- **Workflow personalization** — Auto-generated multi-skill sequences based on individual usage patterns
- **Creator telemetry** — Opt-in anonymized signal from consumer-side adaptations back to skill authors

## Agent Support Matrix

| Agent       | Ingestor | Local Sandbox | Docker Sandbox |
| ----------- | -------- | ------------- | -------------- |
| Claude Code | Yes      | Yes           | Yes            |
| Codex       | Yes      | Planned       | Planned        |
| OpenCode    | Yes      | Planned       | Planned        |
