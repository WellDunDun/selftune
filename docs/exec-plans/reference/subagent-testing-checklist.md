# Subagent Testing Checklist

Use this checklist when changing any bundled selftune subagent in
`skill/agents/` or the specialized-agent summary in `skill/SKILL.md`.

## 1. Static Validation

- Run `bun run validate:subagents`.
- Confirm the validator passes with no stale phrases or missing sections.
- Confirm the changed agent file still has delegation-oriented frontmatter:
  `name`, `description`, `tools`, `model`, `maxTurns`.
- Confirm read-only agents still deny edits and hands-on agents expose edit
  tools intentionally.

## 2. Parent-Skill Routing Smoke Tests

Test through the parent selftune skill, not just by reading the markdown.

- Diagnosis prompt: `diagnose why my Research skill is failing`
- Review prompt: `review this evolution proposal before deploy`
- Integration prompt: `set up selftune in this monorepo`
- Pattern prompt: `which of my skills overlap`

Pass criteria:

- the parent chooses the correct bundled agent
- the parent provides the required inputs
- the subagent returns a structured worker report
- the subagent does not ask the user basic setup questions the parent already
  knows the answer to

## 3. Behavior Checks

- `diagnosis-analyst` stays read-only and cites evidence.
- `pattern-analyst` stays read-only and returns a conflict matrix or concrete
  ownership recommendations.
- `evolution-reviewer` stays read-only and returns `APPROVE`,
  `APPROVE WITH CONDITIONS`, or `REJECT`.
- `integration-guide` defaults to inspect-plus-plan unless explicitly told to
  run in hands-on mode.

## 4. Contract Checks

- No subagent claims `selftune status`, `selftune last`, or
  `selftune eval generate --list-skills` are JSON contracts.
- No subagent tells the parent to manually merge `settings_snippet.json` as the
  default setup path.
- No subagent refers to invalid evolution targets like `routing_table` or
  `full_body`.
- `skill/SKILL.md` still describes the bundled agents as worker-style
  subagents and matches the updated usage guidance.

## 5. Optional Native Subagent Test

If you also want to verify native Claude Code compatibility:

- run `selftune init` to sync the bundled selftune agents into `.claude/agents/`
- invoke it directly or let Claude auto-delegate
- verify the tool restrictions and output shape match the file contract

## 6. Minimum Evidence To Record In Review

- the exact command output from `bun run validate:subagents`
- which smoke-test prompts were tried
- whether the correct agent was chosen
- whether the return format matched the contract
- any remaining gaps or ambiguous behavior
