# Portable skill evaluation contract

**Status:** Current
**Verified:** 2026-08-25

**Authority:** [Agent Skills — Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills)

## Decision

Evaluation definitions belong to the skill package they specify:

```text
skill-name/
├── SKILL.md
└── evals/
    ├── evals.json
    ├── routing.json
    └── files/
```

- `evals.json` follows the Agent Skills evaluation contract: `skill_name` plus
  cases containing `id`, a realistic `prompt`, a human-readable
  `expected_output`, optional `files`, and later objective `assertions`.
- `routing.json` is a SelfTune extension containing positive and negative
  routing cases. It answers whether the harness should invoke the skill for a
  prompt; it does not replace the standard output-quality contract.
- `files/` contains optional checked-in inputs referenced by eval cases.

These files are portable product source. They travel with forks, releases,
exports, and local edits, and can be reviewed in the same change as `SKILL.md`.

SQLite remains the local index for readiness queries and run history. The
legacy files under `~/.selftune/eval-sets` and `~/.selftune/unit-tests` remain
compatibility mirrors. A cached definition must not override a non-empty
package definition.

Run results do not belong in the package. They remain in SQLite and in a sibling
`<skill-name>-workspace/iteration-N/` tree because they are machine-, model-,
and time-specific. Each case separates `with_skill` from `without_skill` (or
`old_skill`), including outputs, timing, and evidence-backed grading. Aggregated
statistics live in that iteration's `benchmark.json`.

## Resolution rules

1. When `--skill-path` is available, generation writes the package contract.
2. Readiness checks prefer the package contract over SQLite and legacy mirrors.
3. An explicit `--output` or `--tests` path produces an additional copy or
   selects an explicit input; it does not silently change package ownership.
4. When no skill path can be resolved, the legacy cache remains a supported
   fallback so existing installations continue to work.

## Expected-result model

Behavior cases begin with a prompt and expected output. Start with two or three
varied, realistic cases including an edge condition. Add objective,
human-readable assertions after inspecting the first outputs. SelfTune stores
typed checks in the optional `selftune_assertions` extension so its local runner
can execute `contains`, `not_contains`, `regex`, `json_path`, `tool_called`, and
`tool_not_called` checks without replacing the standard fields. Exact prose
snapshots are intentionally not the default because they are brittle across
models.

## Consequences

- Skills can ship with reproducible evidence instead of acquiring tests only
  after installation.
- Changes to instructions and their evaluation contract can be code-reviewed
  together.
- Readiness no longer depends on one machine's hidden home-directory state.
- Local run history remains private and does not create noisy package diffs.
