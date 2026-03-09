# selftune Skill Version History

This file is maintainer-facing. Keep operational instructions in
`../SKILL.md`; record version history here so the main skill stays focused on
agent execution.

## Versioning Rules

- Bump the version when command coverage, routing, or user-facing workflow
  guidance changes in a meaningful way.
- Update the `metadata.version` and `metadata.last_updated` fields in
  `../SKILL.md` at the same time.
- Record a short, high-signal summary here. Avoid duplicating the full skill
  body.

## Change Log

### 0.2.1 — 2026-03-09

- Added first-class routing and quick-reference coverage for
  `selftune workflows`
- Added a dedicated `Workflows/Workflows.md` guide for workflow discovery and
  codification
- Updated composability guidance to reflect synergy, conflicts, and workflow
  candidates
- Synced workflow save documentation with the shipped
  `<workflow-id|index>` behavior
