# selftune

<div align="center">

<img src="./images/selftune-logo.svg" alt="selftune" width="250">

<br/>

[![Typing SVG](https://readme-typing-svg.demolab.com?font=Fira+Code&weight=500&size=20&pause=1000&color=3B82F6&center=true&vCenter=true&width=520&lines=Your+skills+trigger+half+the+time.;selftune+fixes+that+automatically.;Observe+%E2%86%92+Detect+%E2%86%92+Evolve+%E2%86%92+Watch+%E2%86%92+Repeat)](https://github.com/WellDunDun/selftune)

<br/>

![Stars](https://img.shields.io/github/stars/WellDunDun/selftune?style=social)
![Forks](https://img.shields.io/github/forks/WellDunDun/selftune?style=social)

[![CI](https://github.com/WellDunDun/selftune/actions/workflows/ci.yml/badge.svg)](https://github.com/WellDunDun/selftune/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/selftune)](https://www.npmjs.com/package/selftune)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/selftune?activeTab=dependencies)

**[Install](#install)** · **[Before / After](#before--after)** · **[Commands](#commands)** · **[Platforms](#platform-quick-start)** · **[Docs](docs/integration-guide.md)**

</div>

---

> [!NOTE]
> **Phase 0 — Foundation.** OpenClaw ingestor shipped, case studies in progress. [Show HN launch targeting March 17.](https://github.com/WellDunDun/selftune)

A user says "make me a slide deck" and your pptx skill doesn't fire. No error. No log. You never find out.

Skill descriptions are written based on what developers *think* users will say, not what they *actually* say. selftune observes real sessions, finds the mismatches, and rewrites your skill descriptions using evidence. Not vibes.

Works with **Claude Code**, **Codex**, **OpenCode**, and **OpenClaw**. Zero runtime dependencies.

## Install

```bash
npx skills add WellDunDun/selftune
```

Then tell your agent: **"initialize selftune"**

That's it. Within minutes you'll see which skills are undertriggering.

## Before / After

<p align="center">
  <img src="./images/selftune-before-after.png" alt="Before: 47% pass rate → After: 89% pass rate" width="800">
</p>

selftune found that real users say "slides", "deck", "presentation for Monday" — none of which matched the original skill description. It rewrote the triggers. Validated against the eval set. Deployed with a backup. Done.

## What It Does

<p align="center">
  <img src="./images/selftune-feedback-loop.png" alt="Observe → Detect → Diagnose → Propose → Validate → Deploy → Watch" width="800">
</p>

- **Observe** — Hooks capture every session automatically
- **Detect** — Finds queries where your skill *should* have fired but didn't
- **Evolve** — Rewrites skill descriptions based on real failure patterns
- **Watch** — Monitors post-deploy, auto-rollbacks if anything regresses

## Commands

| Command | What it does |
|---|---|
| `selftune init` | Auto-detect your agent environment, bootstrap config |
| `selftune status` | See which skills are undertriggering and why |
| `selftune last` | Quick insight from your most recent session |
| `selftune evals --skill <name>` | Generate eval sets from real usage logs |
| `selftune grade --skill <name>` | Grade sessions with pre-gates + LLM grading, graduated 0-1 scores |
| `selftune evolve --skill <name>` | Propose, validate, and deploy improved descriptions (`--pareto`, `--candidates N`) |
| `selftune watch --skill <name>` | Monitor post-deploy pass rates, auto-rollback on regressions |
| `selftune rollback --skill <name>` | Restore pre-evolution description |
| `selftune replay` | Backfill logs from existing Claude Code transcripts |
| `selftune contribute` | Export anonymized data for community signal pooling |
| `selftune dashboard` | Open a visual skill-health dashboard |
| `selftune doctor` | Health check on logs, hooks, config, and schema |
| `selftune ingest-openclaw` | Ingest OpenClaw session transcripts |
| `selftune cron setup` | Register autonomous cron jobs with OpenClaw |
| `selftune cron list` | Show registered selftune cron jobs |
| `selftune cron remove` | Remove selftune cron jobs |

---

<div align="center">

[Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Integration Guide](docs/integration-guide.md) · [Sponsor](https://github.com/sponsors/WellDunDun)

MIT License

---

## Tips

- Run `selftune init` first — everything else reads from the config it writes.
- Let logs accumulate a few days before running evals. More real queries = more reliable signal.
- All hooks are silent (exit 0) and take <50ms. Negligible overhead.
- Use `--dry-run` with `evolve` to preview proposals without deploying.
- Use `selftune contribute --preview` to inspect anonymized data before sharing.
- Use `selftune replay` to unlock months of existing signal immediately.

---

## Testing & Development

### Unit Tests

```bash
bun test
```

750+ tests across 50 files. Runs in ~600ms.

### Sandbox Harness

The sandbox harness exercises every CLI command and hook against realistic fixture data in an isolated `/tmp` directory — your real `~/.claude/` and `~/.selftune/` are never touched.

```bash
make sandbox
```

Tests 3 real skills from [skills.sh](https://skills.sh): `find-skills` (healthy), `frontend-design` (undertriggering), `ai-image-generation` (newly installed). Runs 10 tests in ~400ms.

### Devcontainer + LLM Testing

For commands that require LLM calls (`grade`, `evolve`, `watch`), use the devcontainer with the Claude Code CLI. Based on the [official Claude Code devcontainer reference](https://code.claude.com/docs/en/devcontainer).

**First-time setup** (one-time, auth persists in a Docker volume):
```bash
make sandbox-shell       # drop into the container
claude login             # paste your token
exit
```

**Run LLM tests:**
```bash
make sandbox-llm
```

**Alternative auth:** Set `ANTHROPIC_API_KEY` in `.env.local` at the project root.

**VS Code:** Open the repo and click "Reopen in Container" when prompted.

Uses the official Claude Code CLI with `claude -p`. Auth persists across runs — no need to log in again.

### All Checks

```bash
make check   # lint + architecture lint + unit tests + sandbox
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and PR guidelines.

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full domain map, module rules, and dependency structure.

## Sponsor

If selftune saves you time, consider [sponsoring the project](https://github.com/sponsors/WellDunDun).

## License

[MIT](LICENSE)

</div>
