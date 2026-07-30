export const WORKFLOWS_HELP = `selftune workflows — Discover repeated multi-skill patterns

Usage:
  selftune workflows [options]
  selftune workflows save <name-or-index> [--skill-path <path>]
  selftune workflows scaffold <name-or-index> [--output-dir <path>] [--skill-name <name>] [--description <text>] [--write] [--force] [--json]

Options:
  --min-occurrences <n>  Minimum workflow frequency to show (default: 3)
  --window <n>           Only analyze the most recent N sessions
  --skill <name>         Only show workflows containing the named skill
  --skill-path <path>    Target SKILL.md for the save subcommand
  --output-dir <path>    Target skill registry dir for scaffold previews/writes
  --skill-name <name>    Override the generated draft skill name
  --description <text>   Override the generated draft skill description
  --write                Persist the scaffolded draft skill to disk
  --force                Overwrite an existing scaffold path when combined with --write
  --json                 Emit machine-readable JSON
  -h, --help             Show this help message`;
