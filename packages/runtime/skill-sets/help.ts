export const SKILL_SETS_HELP = `selftune sets - Reusable project skill configurations

Usage:
  selftune sets list [--json]
  selftune sets suggest [--min-occurrences <count>] [--min-affinity <ratio>] [--holdout-ratio <ratio>] [--min-validation-occurrences <count>] [--min-evidence-score <ratio>] [--max <count>] [--json]
  selftune sets outcomes [--json]
  selftune sets create --name <name> --harness <id> --skill-path <path> [options]
  selftune sets update --set <id> --parent-revision <hash> --harness <id> --skill-path <path> [options]
  selftune sets capture [--project <path>] [--name <name>] [--harness <id>] [--json]
  selftune sets derive --name <name> --project <path> --harness <id> [options]
  selftune sets history --set <id> [--json]
  selftune sets export --set <id> --project <path> [--output <path>]
  selftune sets import --manifest <path> [--json]
  selftune sets plan --set <id> --project <path> [--json]
  selftune sets apply --set <id> --project <path> [--json]
  selftune sets receipts [--json]
  selftune sets rollback --receipt <id> [--json]

Create options:
  --name <name>          Human-readable Skill Set name
  --description <text>  Optional purpose or project-archetype description
  --harness <id>        Repeat for codex, claude_code, opencode, openclaw, or pi
  --skill-path <path>   Repeat for each package directory or SKILL.md

Capture defaults to the current directory, derives its name from the folder, and detects active harnesses.

Apply is conflict-blocking and idempotent. Rollback removes only receipt-owned paths.`;
