# selftune Quickstart Workflow

Guided onboarding that runs init, ingest, and status in a single command.
Designed for first-time users who want to get selftune working immediately.

## When to Use

- The user is setting up selftune for the first time
- The user says "getting started", "quickstart", "onboard", or "first time"
- The agent needs to bootstrap selftune in one step without running init, ingest, and status separately

## Default Command

```bash
selftune quickstart
```

Help:

```bash
selftune quickstart --help
```

## Options

| Flag     | Description            |
| -------- | ---------------------- |
| `--help` | Show usage information |

## Steps Performed

Quickstart runs three steps automatically:

1. **Init** — Creates `~/.selftune/config.json` if it does not exist. Skips if config is already present.
2. **Ingest** — Runs Claude Code transcript replay if the ingest marker file does not exist. Discovers transcripts from `~/.claude/projects/` and writes session telemetry to SQLite.
3. **Status** — Displays current skill health using `computeStatus`. Shows pass rates, session counts, and health indicators for all detected skills.

After status, quickstart suggests the top 3 skills that would benefit from evolution, prioritized by:

- **UNGRADED/UNKNOWN** skills (highest priority) — suggests running `selftune grade`
- **CRITICAL** skills (pass rate below threshold) — suggests evolution
- **WARNING** skills — suggests improvement

## Output Format

```text
selftune quickstart
====================

[1/3] Config exists, skipping init.
[2/3] Running ingest claude...
      Ingested 12 sessions.
[3/3] Current status:

  Skill Health Summary
  ...

Suggested next steps:
  - my-skill: pass rate 45% — needs evolution
  - other-skill: needs grading — run `selftune grade --skill other-skill`
```

If all skills are healthy, the output ends with:

```text
All skills are healthy. No immediate actions needed.
```

## Common Patterns

**First-time setup**

> Run `selftune quickstart`. It handles init, ingest, and status automatically.

**Already initialized**

> Quickstart skips steps that are already complete (config exists, ingest marker exists). It is safe to run multiple times.

**No transcripts found**

> If no Claude Code transcripts exist in `~/.claude/projects/`, quickstart reports "No Claude Code transcripts found" and continues to the status step. The user should run some agent sessions first, then re-run quickstart.

**Status or ingest fails**

> Quickstart catches errors in each step and suggests the manual command for troubleshooting (e.g., `selftune init`, `selftune ingest claude`, or `selftune status`).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Init failed" at step 1 | Config directory permissions or corrupted config | Run `selftune init --force` manually |
| "Ingest failed" at step 2 | Transcript directory missing or unreadable | Verify `~/.claude/projects/` exists and contains session directories |
| "No sessions found" after ingest | No actionable transcripts or no skill usage detected | Run agent sessions that use skills, then re-run quickstart |
| "Status failed" at step 3 | SQLite database issue | Run `selftune doctor` to diagnose |
