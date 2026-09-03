export const SKILLS_HELP = `selftune skills — Audit and manage the installed skill portfolio

Usage:
  selftune skills load --id ID [--search-dir PATH] [--json]
  selftune skills activate (--id ID | --set ID) --task TASK --harness NAME [--project PATH] [--yes] [--dry-run] [--json]
  selftune skills active [--task TASK] [--project PATH] [--json]
  selftune skills deactivate (--task TASK | --receipt ID) [--project PATH] [--yes] [--dry-run] [--json]
  selftune skills search "task or collection" [--limit N] [--search-dir PATH] [--json]
  selftune skills audit [--min-sessions N] [--inactive-days N] [--search-dir PATH] [--json]
  selftune skills consolidate (--skill NAME | --all-safe) [--search-dir PATH] [--yes] [--dry-run] [--json]
  selftune skills consolidation-rollback --id ID [--yes] [--dry-run] [--json]
  selftune skills quarantine --skill NAME [--skill-path PATH] --yes [--dry-run] [--json]
  selftune skills quarantined [--json]
  selftune skills restore --id ID [--dry-run] [--json]

Safety:
  Audits and dry-runs never modify packages. Consolidation and quarantine require
  explicit --yes approval, archive complete packages, and return exact undo commands.`;
