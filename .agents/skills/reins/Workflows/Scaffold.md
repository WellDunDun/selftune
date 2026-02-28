# Reins Scaffold Workflow

Set up a repository with Reins harness-engineering structure.

## Default Command

Use Reins before manual scaffolding:
- Local source: `cd cli/reins && bun src/index.ts init <path>`
- Package mode: `npx reins-cli@latest init <path>`

## Output Format

```json
{
  "command": "init",
  "project": "project-name",
  "target": "/abs/path/to/project",
  "requested_automation_pack": null,
  "automation_pack": null,
  "automation_pack_reason": "No optional automation pack selected.",
  "created": [
    "docs/design-docs/",
    "docs/exec-plans/active/",
    "docs/exec-plans/completed/",
    "docs/generated/",
    "docs/product-specs/",
    "docs/references/",
    "AGENTS.md",
    "ARCHITECTURE.md",
    "risk-policy.json",
    "docs/golden-principles.md",
    "docs/design-docs/index.md",
    "docs/design-docs/core-beliefs.md",
    "docs/product-specs/index.md",
    "docs/exec-plans/tech-debt-tracker.md"
  ],
  "next_steps": [
    "Edit AGENTS.md — fill in the project description",
    "Edit ARCHITECTURE.md — define your business domains",
    "Review risk-policy.json — set tiers and docs drift rules for your repo",
    "Edit docs/golden-principles.md — customize rules for your project",
    "Run 'reins audit .' to see your starting score"
  ]
}
```

Notes:
- `created` includes both directories (with trailing `/`) and files.
- Existing scaffolding is refused unless `--force` is used.
- `automation_pack` is `null` by default, `"agent-factory"` when explicitly requested, or selected adaptively when `--pack auto` is used.

## Flags

| Flag | Purpose | Example |
|------|---------|---------|
| `--name <name>` | Set project name (default: directory name) | `reins init . --name MyProject` |
| `--force` | Overwrite existing files | `reins init . --force` |
| `--pack <name>` | Optional automation templates (`auto`, `agent-factory`) | `reins init . --pack auto` |

## Steps

1. Run `reins init <path>`.
2. Parse `created` to verify scaffold results.
3. Customize generated `AGENTS.md`, `ARCHITECTURE.md`, and `docs/golden-principles.md`.
4. Tune `risk-policy.json` for real watch paths/docs drift rules.
5. Run `reins audit <path>` and `reins doctor <path>`.
