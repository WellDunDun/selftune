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
selftune evolve          --skill <name> --skill-path <path> [--dry-run]
selftune evolve body     --skill <name> --skill-path <path> --target <body|routing> [--dry-run]
selftune evolve rollback --skill <name> --skill-path <path> [--proposal-id <id>]

# Eval group
selftune eval generate      --skill <name> [--list-skills] [--stats] [--max N] [--seed N] [--output PATH]
selftune eval unit-test      --skill <name> --tests <path> [--run-agent] [--generate]
selftune eval import         --dir <path> --skill <name> --output <path> [--match-strategy exact|fuzzy]
selftune eval composability  --skill <name> [--window N] [--telemetry-log <path>]
selftune eval family-overlap --prefix <family-> | --skills <a,b,c> [--parent-skill <name>] [--min-overlap 0.3] [--min-shared 2]

# Other commands
selftune watch    --skill <name> --skill-path <path> [--auto-rollback]
selftune status
selftune last
selftune doctor
selftune dashboard [--port <port>] [--no-open]
selftune contributions [status|preview <skill>|upload [--dry-run]|approve <skill>|revoke <skill>|default <ask|always|never>|reset]
selftune creator-contributions [status|enable --skill <name>|enable --all [--prefix <value>]|disable --skill <name>]
selftune contribute [--skill NAME] [--preview] [--sanitize LEVEL] [--submit]
selftune cron setup [--dry-run]                         # auto-detect platform (cron/launchd/systemd)
selftune cron setup --platform openclaw [--dry-run] [--tz <timezone>]  # OpenClaw-specific
selftune cron list
selftune cron remove [--dry-run]
selftune telemetry [status|enable|disable]
selftune export    [TABLE...] [--output/-o DIR] [--since DATE]

# Autonomous loop
selftune orchestrate [--dry-run] [--review-required] [--auto-approve] [--skill NAME] [--max-skills N] [--recent-window HOURS] [--sync-force] [--max-auto-grade N] [--loop] [--loop-interval SECS]
selftune sync        [--since DATE] [--dry-run] [--force] [--no-claude] [--no-codex] [--no-opencode] [--no-openclaw] [--no-pi] [--no-repair] [--json]

# Discovery + badges
selftune workflows   [--skill NAME] [--skill-path PATH] [--min-occurrences N] [--window N] [--json] [save <name-or-index> --skill-path PATH] [scaffold <name-or-index> --output-dir PATH --skill-name NAME --description TEXT --write --force]
selftune badge       --skill <name> [--format svg|markdown|url] [--output PATH]

# Maintenance
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
selftune alpha upload [--dry-run]
selftune alpha relink
selftune status                                                        # shows cloud link state + upload readiness
```
