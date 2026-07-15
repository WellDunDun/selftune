# Skill Library

Use the Library when the user wants one inventory of skills across harnesses,
projects, the immutable local cache, and reversible archive storage.

```bash
selftune library
selftune library configure --url <remote-url> --api-key <device-key>
selftune library preview
selftune library sync
selftune library diagnostics
selftune library export --output <backup.json>
selftune library restore --target <clean-config-directory>
selftune library synthesize scan
selftune library synthesize list
selftune library synthesize review --candidate-id <id> --action <accept|reject|snooze|edit> --reason <text>
selftune library synthesize draft --candidate-id <id> [--output-dir <directory>]
selftune library synthesize evaluate --candidate-id <id>
selftune library synthesize release --candidate-id <id>
```

The command emits a deterministic JSON snapshot. A logical skill may contain
multiple revisions and multiple physical locations. Treat `library` as stored
but inactive, `draft` as awaiting review, and `archived` as reversibly removed
from active harness search paths. Do not interpret missing observations as
proof that a skill is unused; use `selftune skills audit` for evidence-backed
recommendations.

Remote Library commands are optional. Sync uploads one canonical immutable
revision for each selected skill, Skill Sets, catalog metadata, and decision
history according to local preferences. Every Skill Set forces its complete
pinned skill-revision closure into the same snapshot, even when general skill
backup is disabled. Draft backup is opt-in. `preview` reports every artifact, file
name, byte count, SHA-256 hash, and bounded text preview before upload. Draft
and eval provenance uses pseudonymous session identifiers, free-form review
reasons are conservatively redacted, and invalid provenance or credential-like
package content blocks sync. Raw transcripts are not a supported sync artifact.
`restore` writes only to the selected config directory and never activates
skills in a harness; apply a reviewed Skill Set separately.

The desktop Settings screen exposes the same preview, sync, export, restore,
integrity, storage, and artifact-preference controls. It also creates
recipient-scoped private grants for immutable skills and complete Skill Sets;
recipients explicitly accept and import a copy into their own organization,
and senders can revoke grants that have not been imported. The supervised
desktop service syncs shortly after startup and every four hours. The menu bar
can still run an explicit sync and reports pending reviews, schedule state, and
Remote Library health without opening the full window.

## Synthesis Inbox

`synthesize scan` analyzes normalized local session records and writes only
redacted excerpts into a deterministic evidence snapshot. It separates
supporting sessions from held-out validation sessions before draft creation.
Successful repeated uncovered work may become a coverage candidate; stable
ordered combinations additionally require marginal co-usage lift and order
consistency. Repeated failure loops do not become positive skill candidates.

Every candidate requires a human decision. Rejections and reasons remain in
decision history so repeated scans do not re-recommend the same finding.
Acceptance only permits `synthesize draft`; it never releases, installs,
archives, or activates a package. Drafts contain workflows, provenance, and
positive, negative near-neighbor, boundary, and execution eval cases. Package
validation, replay, held-out baselines, and regression checks remain required
before release can be recommended. `evaluate` runs those package gates and
binds the result to the candidate, evidence snapshot, and immutable draft hash.
`release` succeeds only for the unchanged draft covered by a recommended gate;
it copies that revision into the immutable Library and does not install it.

| Flag                        | Applies to                               | Meaning                                    |
| --------------------------- | ---------------------------------------- | ------------------------------------------ |
| `--candidate-id <id>`       | `review`, `draft`, `evaluate`, `release` | Candidate selected for the explicit action |
| `--action <action>`         | `review`                                 | `accept`, `reject`, `snooze`, or `edit`    |
| `--reason <text>`           | `review`                                 | Decision rationale retained in history     |
| `--snooze-until <ISO time>` | `review`                                 | Optional end time for a snooze             |
| `--title <text>`            | `review --action edit`                   | Reviewed replacement title                 |
| `--summary <text>`          | `review --action edit`                   | Reviewed replacement summary               |
| `--output-dir <directory>`  | `draft`                                  | Local draft package root                   |
