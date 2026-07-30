# selftune Skill Portfolio Workflow

Audit every installed skill, distinguish missing evidence from inactivity, and
quarantine a skill reversibly after explicit user approval.

## When to Use

- The user asks which skills are unused, stale, redundant, or safe to remove
- The user wants to reduce the active skill catalog
- A skill family appears overlapping or confusing
- The same skill is installed globally and inside several projects
- Project copies are outdated or diverge from the source-current revision
- The user wants to quarantine or restore an installed skill

## Default Command

```bash
selftune skills audit --json
```

Treat the audit as a recommendation surface. Never describe an `unobserved`
skill as unused: it has not yet accumulated enough time and subsequent-session
evidence for archive review. Even a never-invoked `inactive_candidate` is a
review prompt, not proof that the skill has no value.

## Commands

```bash
selftune skills audit [--min-sessions N] [--inactive-days N] [--search-dir PATH] [--json]
selftune skills consolidate (--skill NAME | --all-safe) [--search-dir PATH] [--yes] [--dry-run] [--json]
selftune skills consolidation-rollback --id ID [--yes] [--dry-run] [--json]
selftune skills quarantine --skill NAME [--skill-path PATH] --yes [--dry-run] [--json]
selftune skills quarantined [--json]
selftune skills restore --id ID [--dry-run] [--json]
```

## Audit Classifications

| Classification            | Meaning                                                | Default recommendation   |
| ------------------------- | ------------------------------------------------------ | ------------------------ |
| `protected`               | SelfTune, system, or administrator-managed skill       | Keep                     |
| `unobserved`              | No trusted invocation and insufficient exposure        | Measure before deciding  |
| `under_observed`          | Some evidence exists, but the sample is too small      | Keep collecting evidence |
| `routing_problem`         | Repeated contextual reads are not becoming invocations | Repair routing           |
| `active`                  | Recently invoked with sufficient evidence              | Keep                     |
| `inactive_candidate`      | No invocation across enough time and later sessions    | Review for quarantine    |
| `consolidation_candidate` | Sibling surfaces or telemetry suggest overlap          | Review consolidation     |

The inactivity window starts at the latest trusted invocation, or at package
modification time when no invocation has ever been recorded. By default, both
30 days and 20 distinct subsequent sessions must pass. An
`inactive_candidate` is not an automatic deletion decision. Rare safety,
incident-response, compliance, and recovery skills may be valuable precisely
because they are seldom invoked.

After desktop onboarding processes selected history, the overview may show a
**Cleanup ready** checkpoint. Its review action opens the Skills Library with
only `inactive_candidate` packages visible and preselected. `unobserved`,
`under_observed`, routing, consolidation, and active classifications are never
preselected as archive recommendations.

## Duplicate Installation Consolidation

The Skills Library separately detects a logical skill installed in multiple
global or project registries. This recommendation is based on exact package
content hashes and source-update state, not on usage frequency. It therefore
distinguishes identical duplicates from divergent or outdated revisions.

Existing users can open the recommendation from the Overview **Cleanup ready**
checkpoint without repeating onboarding. Open **Duplicate installations** from
the Library recommendation filter for individual review, or choose **Review
all** to open the bulk cleanup review. The review shows:

- the proposed canonical revision and whether its source confirms it is current;
- every installation that will move to SelfTune-owned quarantine;
- every project path that will become a symlink to the immutable SelfTune
  Library package; and
- the rollback behavior and the fact that nothing is permanently deleted.

Bulk review preselects only recommendations whose canonical revision is
source-confirmed current. It keeps ambiguous revisions unselected and routes
them to the same per-skill hash and path comparison. Before approval, the
footer totals the packages that will be archived and the project links that
will be created. Each selected skill is then applied as its own durable
decision; a failure is reported next to that skill without stopping the
remaining selections. Results link to Decisions for independent rollback.

The agent-facing CLI exposes the same detector and durable filesystem operation.
Always preview before mutation:

```bash
selftune skills consolidate --skill <name> --dry-run --json
```

After showing the canonical hash, every archive target, and every project link
to the user, apply the reviewed skill with explicit approval:

```bash
selftune skills consolidate --skill <name> --yes --json
```

For a portfolio-wide cleanup, `--all-safe` selects only source-confirmed current
revisions. Ambiguous recommendations remain in the result as `review_required`
and are not mutated:

```bash
selftune skills consolidate --all-safe --dry-run --json
selftune skills consolidate --all-safe --yes --json
```

`--search-dir` may be repeated with additional skill registry directories. The
default scan already includes global registries and known project workspaces.
Each applied item returns an `undo_command`. Preview and execute that rollback
with the decision ID from the receipt:

```bash
selftune skills consolidation-rollback --id <decision-id> --dry-run --json
selftune skills consolidation-rollback --id <decision-id> --yes --json
```

Approval first copies the canonical package into SelfTune's immutable Library.
It then archives each displaced installation and replaces only project-scoped
targets with managed symlinks. Global duplicate copies are archived rather than
linked. A durable receipt records every original hash, original path, archive
destination, and created link. The Decisions screen can roll the operation back
by removing those links and restoring the exact archived packages.

If any package changes after the review is prepared, approval becomes `stale`
and performs no cleanup. A project path that already points to the proposed
Library package is left unchanged and is not recommended again. SelfTune,
system-managed, and administrator-managed packages are protected.

Permanent deletion is intentionally separate from consolidation. Do not delete
the archived receipts or packages while rollback is still required.

Consolidation is idempotent: already-managed project links are omitted from new
plans, rolled-back decisions remain rolled back, and every apply revalidates all
reviewed hashes before moving a package. A stale or changed plan performs no
cleanup for that skill.

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

In the dashboard, **Restore archived skills** opens the archived Library view;
each archived row retains its restore receipt and exact original path.

## Structured Output

All portfolio commands support `--json`. Mutating receipts include:

- `status`
- `skill_name`
- `quarantine_id`
- source and quarantine paths
- package version hash when available
- `dry_run`
- `undo_command`

Consolidation output additionally includes `dry_run`, `mode`, aggregate
`counts`, canonical content and package paths, every target action, per-skill
status, durable decision IDs, receipt IDs, and per-item failures. Bulk failure
is isolated: a failed skill does not prevent later source-confirmed skills from
being attempted.

## Troubleshooting

| Symptom                    | Cause                                                | Next action                                                                         |
| -------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Skill is `unobserved`      | Not enough time or later sessions for archive review | Run `selftune sync`, then continue normal use                                       |
| Skill is `routing_problem` | Contextual reads rarely become invocations           | Run `selftune improve --skill NAME --skill-path PATH --scope description --dry-run` |
| Quarantine is ambiguous    | Multiple registries contain the same skill name      | Rerun with `--skill-path PATH`                                                      |
| Quarantine is blocked      | Skill is SelfTune, system-managed, or admin-managed  | Keep it active or use its platform-specific administrator workflow                  |
| Restore destination exists | Another package now occupies the original path       | Resolve the conflict; do not overwrite either package                               |
| Consolidation is stale     | A reviewed source or target changed before approval  | Refresh the Library and review the new hashes                                       |
| Canonical needs review     | No source-confirmed current revision is available    | Compare revisions before approving the proposed canonical package                   |
