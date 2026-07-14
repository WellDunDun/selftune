# selftune Skill Portfolio Workflow

Audit every installed skill, distinguish missing evidence from inactivity, and
quarantine a skill reversibly after explicit user approval.

## When to Use

- The user asks which skills are unused, stale, redundant, or safe to remove
- The user wants to reduce the active skill catalog
- A skill family appears overlapping or confusing
- The user wants to quarantine or restore an installed skill

## Default Command

```bash
selftune skills audit --json
```

Treat the audit as a recommendation surface. Never describe an `unobserved`
skill as unused: zero observations do not establish that the skill has no value.

## Commands

```bash
selftune skills audit [--min-sessions N] [--inactive-days N] [--search-dir PATH] [--json]
selftune skills quarantine --skill NAME [--skill-path PATH] --yes [--dry-run] [--json]
selftune skills quarantined [--json]
selftune skills restore --id ID [--dry-run] [--json]
```

## Audit Classifications

| Classification            | Meaning                                                | Default recommendation   |
| ------------------------- | ------------------------------------------------------ | ------------------------ |
| `protected`               | SelfTune, system, or administrator-managed skill       | Keep                     |
| `unobserved`              | Installed, but no trustworthy usage evidence exists    | Measure before deciding  |
| `under_observed`          | Some evidence exists, but the sample is too small      | Keep collecting evidence |
| `routing_problem`         | Repeated contextual reads are not becoming invocations | Repair routing           |
| `active`                  | Recently invoked with sufficient evidence              | Keep                     |
| `inactive_candidate`      | No recent invocation across enough subsequent sessions | Review for quarantine    |
| `consolidation_candidate` | Sibling surfaces or telemetry suggest overlap          | Review consolidation     |

An `inactive_candidate` is not an automatic deletion decision. Rare safety,
incident-response, compliance, and recovery skills may be valuable precisely
because they are seldom invoked.

## Quarantine Safety

Before running a mutating command:

1. Show the audit evidence to the user.
2. Ask for explicit approval to quarantine the named skill.
3. Run `selftune skills quarantine --skill NAME --yes` only after approval.
4. Return the command's `undo_command` to the user.

Quarantine moves the complete skill package out of active agent registries and
stores a receipt under SelfTune's local config directory. It does not delete
files. The operation is idempotent. SelfTune itself and system/admin skills are
protected.

Use `--skill-path` when multiple installed packages share the same skill name.

## Restore

List active quarantines:

```bash
selftune skills quarantined --json
```

Restore the package to its exact previous registry path:

```bash
selftune skills restore --id <quarantine-id> --json
```

Restore refuses to overwrite an occupied destination. A repeated restore is an
idempotent no-op and reports `already_restored`.

## Structured Output

All portfolio commands support `--json`. Mutating receipts include:

- `status`
- `skill_name`
- `quarantine_id`
- source and quarantine paths
- package version hash when available
- `dry_run`
- `undo_command`

## Troubleshooting

| Symptom                    | Cause                                               | Next action                                                                         |
| -------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Skill is `unobserved`      | No trustworthy local observations exist             | Run `selftune sync`, then continue normal use                                       |
| Skill is `routing_problem` | Contextual reads rarely become invocations          | Run `selftune improve --skill NAME --skill-path PATH --scope description --dry-run` |
| Quarantine is ambiguous    | Multiple registries contain the same skill name     | Rerun with `--skill-path PATH`                                                      |
| Quarantine is blocked      | Skill is SelfTune, system-managed, or admin-managed | Keep it active or use its platform-specific administrator workflow                  |
| Restore destination exists | Another package now occupies the original path      | Resolve the conflict; do not overwrite either package                               |
