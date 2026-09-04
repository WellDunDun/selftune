# CLI Quick Reference

Full flag reference for all selftune commands. Run `selftune <command> --help`
for the most up-to-date flags.

```bash
# Ingest group
selftune ingest claude   [--since DATE] [--dry-run] [--force] [--verbose]
selftune ingest codex                                                          # (experimental)
selftune ingest opencode                                                       # (experimental)
selftune ingest openclaw [--agents-dir PATH] [--since DATE] [--dry-run] [--force] [--verbose]  # (experimental)
selftune ingest pi       [--sessions-dir PATH] [--since DATE] [--dry-run] [--force] [--verbose]  # (experimental)
selftune ingest wrap-codex -- <codex args>                                     # (experimental)

# Grade group
selftune grade auto      --skill <name> [--expectations "..."] [--agent <name>]
selftune grade baseline  --skill <name> --skill-path <path> [--eval-set <path>] [--agent <name>]

# Evolve group
selftune evolve          --skill <name> --skill-path <path> [--dry-run] [--validation-mode auto|replay|judge]
selftune evolve body     --skill <name> --skill-path <path> --target <body|routing> [--dry-run]
selftune evolve rollback --skill <name> --skill-path <path> [--proposal-id <id>]
selftune improve --skill <name> --skill-path <path> [--scope auto|description|routing|body|package] [--dry-run] [--validation-mode auto|replay|judge]

# Create group
selftune verify --skill-path <path> [--agent AGENT] [--eval-set PATH] [--no-auto-fix] [--json]
selftune publish --skill-path <path> [--no-watch] [--ignore-watch-alerts] [--json]
selftune search-run --skill-path <path> [--skill NAME] [--surface routing|body|both] [--max-candidates N] [--agent AGENT] [--eval-set PATH] [--apply-winner] [--json]
selftune create status --skill-path <path> [--json]
selftune create init --name <name> --description <text> [--output-dir PATH] [--force] [--json]
selftune create scaffold --from-workflow <id|index> [--output-dir PATH] [--skill-name NAME] [--description TEXT] [--write] [--force] [--json]
selftune create check --skill-path <path> [--json]
selftune create replay --skill-path <path> [--mode routing|package] [--agent AGENT] [--json]
selftune create baseline --skill-path <path> [--mode routing|package] [--agent AGENT] [--json]
selftune create report --skill-path <path> [--agent AGENT] [--eval-set PATH] [--json]
selftune create publish --skill-path <path> [--watch] [--ignore-watch-alerts] [--json]

# Eval group
selftune eval generate      --skill <name> [--list-skills] [--stats] [--max N] [--seed N] [--output PATH] [--agent AGENT] [--blend]
selftune eval unit-test      --skill <name> --tests <path> [--run-agent] [--generate]
selftune eval import         --dir <path> --skill <name> --output <path> [--match-strategy exact|fuzzy]
selftune eval composability  --skill <name> [--window N] [--telemetry-log <path>]
selftune eval family-overlap --prefix <family-> | --skills <a,b,c> [--parent-skill <name>] [--min-overlap 0.3] [--min-shared 2]

# Other commands
selftune watch    --skill <name> --skill-path <path> [--auto-rollback] [--grade-threshold N] [--no-grade-watch]
selftune status
selftune last
selftune doctor
selftune dashboard [--port <port>] [--no-open]
selftune mcp serve  # read-only local Skills-over-MCP server over stdio
selftune daemon run [--port PORT] [--hostname HOST] [--spa-dir PATH] [--config-dir PATH] [--owner cli|desktop] [--supervised]
selftune daemon status [--config-dir PATH] [--json]
selftune daemon stop [--config-dir PATH]
selftune daemon rotate-token [--config-dir PATH]
selftune service install [--port PORT] [--config-dir PATH] [--owner cli|desktop] [--boot] [--json] [--executable PATH] [--resource-dir PATH] [--service-version VERSION]
selftune service status|start|stop|restart|uninstall [--config-dir PATH] [--json]
selftune service doctor [--json]
selftune service repair-lock [--json]  # Windows: only a proven stale pre-SQLite lock
# Legacy packaged callers may use --version VERSION as an alias for --service-version.
selftune contributions [status|preview <skill>|upload [--dry-run]|approve <skill>|revoke <skill>|default <ask|always|never>|reset]
selftune creator-contributions [status|enable --skill <name>|enable --all [--prefix <value>]|disable --skill <name>]
selftune contribute [--skill NAME] [--preview] [--sanitize LEVEL] [--submit]
selftune cron setup [--dry-run]                         # auto-detect platform (cron/launchd/systemd)
selftune cron setup --platform openclaw [--dry-run] [--tz <timezone>]  # OpenClaw-specific
selftune cron list
selftune cron remove [--dry-run]
selftune telemetry [status|enable|disable]
selftune export    [TABLE...] [--output/-o DIR] [--since DATE]

# Skill Library and Sync & Backup
selftune library
selftune library configure --url <remote-url> --api-key <account-token>
selftune library preview
selftune library sync
selftune library status
selftune library diagnostics
selftune library export --output <backup.json>
selftune library restore --target <clean-config-directory>
selftune library synthesize scan|list
selftune library synthesize review --candidate-id <id> --action <accept|reject|snooze|edit> --reason <text>
selftune library synthesize draft|evaluate|release --candidate-id <id>

# Project Skill Sets
selftune sets create|update|derive|list|show|history [options]
selftune sets export|import|plan|apply|rollback [options]

# Autonomous loop
selftune run [--dry-run] [--review-required] [--auto-approve] [--skill NAME] [--max-skills N] [--recent-window HOURS] [--sync-force] [--max-auto-grade N] [--loop] [--loop-interval SECS]
selftune orchestrate [--dry-run] [--review-required] [--auto-approve] [--skill NAME] [--max-skills N] [--recent-window HOURS] [--sync-force] [--max-auto-grade N] [--loop] [--loop-interval SECS]
selftune sync        [--since DATE] [--dry-run] [--force] [--no-claude] [--no-codex] [--no-opencode] [--no-openclaw] [--no-pi] [--no-repair] [--json]

# Discovery + badges
selftune workflows   [--skill NAME] [--skill-path PATH] [--min-occurrences N] [--window N] [--json] [save <name-or-index> --skill-path PATH] [scaffold <name-or-index> --output-dir PATH --skill-name NAME --description TEXT --write --force]
selftune badge       --skill <name> [--format svg|markdown|url] [--output PATH]

# Maintenance
selftune skills audit       [--min-sessions N] [--inactive-days N] [--search-dir PATH] [--json]
selftune skills quarantine  --skill NAME [--skill-path PATH] --yes [--dry-run] [--json]
selftune skills quarantined [--json]
selftune skills restore     --id ID [--dry-run] [--json]
selftune quickstart
selftune repair-skill-usage [--since DATE] [--dry-run]
selftune recover            [--full] [--force] [--since DATE]
selftune export-canonical   [--out FILE] [--platform NAME] [--record-kind KIND] [--pretty] [--push-payload]
selftune uninstall          [--dry-run] [--keep-logs] [--npm-uninstall]

# Hook dispatch (for debugging/manual invocation)
selftune hook <name>   # prompt-log | session-stop | skill-eval | auto-activate | skill-change-guard | evolution-guard

# Platform hooks (non-Claude-Code agents)
selftune codex hook
selftune codex install    [--dry-run] [--uninstall]
selftune opencode hook
selftune opencode install [--dry-run] [--uninstall]
selftune cline hook
selftune cline install    [--dry-run] [--uninstall]
selftune pi hook
selftune pi install       [--dry-run] [--uninstall]

# Registry (team skill distribution)
selftune registry push [name]      [--version=<semver>] [--summary=<text>]
selftune registry install <name>   [--global]
selftune registry sync
selftune registry status
selftune registry rollback <name>  [--to=<version>] [--reason=<text>]
selftune registry history <name>
selftune registry list

# Alpha enrollment (device-code flow — browser opens automatically)
selftune init --alpha --alpha-email <email>
selftune alpha relink
selftune status                                                        # shows cloud link state + upload readiness
```
