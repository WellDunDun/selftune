# Examples

## Scenario 1: First-time setup

User says: "Set up selftune" or "Install selftune"

Actions:

1. Read `workflows/Initialize.md`
2. Run `selftune init` to bootstrap config (hooks are installed automatically)
3. Run `selftune doctor` to verify

Result: Config at `~/.selftune/config.json`, hooks active, ready for session capture.

## Scenario 2: Improve a skill

User says: "Make the pptx skill catch more queries" or "Evolve the Research skill"

Actions:

1. `selftune eval generate --skill pptx` to find missed triggers
2. `selftune evolve --skill pptx --skill-path <path>` to propose changes
3. `selftune watch --skill pptx --skill-path <path>` to monitor post-deploy

Result: Skill description updated to match real user language, with rollback available.

## Scenario 3: Check skill health

User says: "How are my skills doing?" or "Run selftune"

Actions:

1. `selftune status` for overall health summary
2. `selftune last` for most recent session insight
3. `selftune doctor` if issues detected

Result: Pass rates, trend data, and actionable recommendations.

## Scenario 4: Autonomous operation

User says: "Set up cron jobs" or "Run selftune automatically"

Actions:

1. `selftune cron setup` to install OS-level scheduling
2. Orchestrate loop runs: ingest -> grade -> evolve -> watch

Result: Skills improve continuously without manual intervention.
