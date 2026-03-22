# Contributing to selftune

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- Git
- Docker + VS Code Dev Containers extension (optional, for LLM-dependent testing)

## Setup

```bash
# Clone the repo
git clone https://github.com/selftune-dev/selftune.git
cd selftune

# Install dependencies
bun install

# Initialize selftune config
bun run cli/selftune/index.ts init
```

## Running Checks

```bash
make check        # Full check: lint + typecheck + tests + sandbox
make lint         # oxlint + oxfmt --check + architecture lint
make lint-fix     # Auto-fix lint + format issues
make format       # Format all files with oxfmt
make test         # All tests
make test-fast    # Unit tests only (~10s)
make test-slow    # Integration tests only (~80s)
```

All checks must pass before submitting a PR.

### Test Split

Tests are split into fast and slow tiers to enable rapid iteration:

| Tier        | Time | What's included                   | When to use        |
| ----------- | ---- | --------------------------------- | ------------------ |
| `test-fast` | ~10s | All unit tests                    | During development |
| `test-slow` | ~80s | Integration + mock.module() tests | Before PR          |
| `test`      | ~90s | Everything                        | CI, `make check`   |
| `sandbox`   | ~30s | End-to-end CLI harness            | Before PR          |

**Slow tests** (excluded from `test-fast`):

- `evolve.test.ts` — uses `mock.module()` which pollutes the global module registry
- `integration.test.ts` (evolution + monitoring) — LLM-dependent, long-running
- `dashboard-server.test.ts` — spins up a real HTTP server
- `blog-proof/*` — content validation, not unit tests

### Sandbox Testing

The sandbox harness tests all CLI commands and hooks end-to-end in an isolated environment:

```bash
make sandbox
```

This creates a temporary `HOME` directory in `/tmp`, copies test fixtures (3 skills, 15 sessions, 30 queries), and runs every command against that data. Results are saved to `tests/sandbox/results/`.

**Fixture skills:** `find-skills` (healthy, high triggers), `frontend-design` (sick, zero triggers), `ai-image-generation` (new, minimal data).

**To add new fixture data:** Edit files in `tests/sandbox/fixtures/`. Follow the existing JSONL schema documented in `ARCHITECTURE.md`.

### Devcontainer Testing (LLM-dependent commands)

Commands like `grade` and `evolve` need LLM calls. Test them in the devcontainer, based on the [official Claude Code devcontainer reference](https://code.claude.com/docs/en/devcontainer):

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

**VS Code:** Open the repo → "Reopen in Container"

## Architecture

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the full domain map, module layering, and dependency rules.

The key rule: **dependencies flow forward only** — `shared -> hooks/ingestors -> eval -> grading -> evolution -> monitoring`. This is enforced by `lint-architecture.ts`.

## Naming Conventions

Follow the conventions in [docs/golden-principles.md](docs/golden-principles.md):

- **Files:** `kebab-case.ts`
- **Functions:** `camelCase`
- **Types/Interfaces:** `PascalCase`

## Code Style

[oxc](https://oxc.rs) handles linting (oxlint) and formatting (oxfmt). Run before submitting:

```bash
bun run lint:fix
bun run format
```

## Pull Request Expectations

- **Concise summary** describing what changed and why
- **All checks pass** — `make check` must succeed
- **No new runtime dependencies** — selftune uses only Bun built-ins
- **Tests included** for new functionality
- **One concern per PR** — keep changes focused

## Zero Runtime Dependencies

selftune intentionally has zero runtime dependencies. All functionality uses Bun built-ins. Do not add `dependencies` to `package.json`.

## Local Data Management

selftune's data pipeline: **hooks write directly to SQLite via `localdb/direct-write.ts`**. JSONL serves as an append-only audit trail for debugging and the contribute workflow. The materializer runs once on dashboard startup to backfill historical data. `selftune export` generates JSONL from SQLite on demand. The SQLite DB at `~/.selftune/selftune.db` is the operational database.

### Rebuilding the Dashboard Database

When developing locally (especially after schema changes), the SQLite database can become incompatible. To rebuild:

```bash
rm ~/.selftune/selftune.db
selftune sync --force
```

`--force` ignores per-source markers and rescans all JSONL logs from scratch. The next `selftune dashboard` will serve fresh data.

### Linking Local Source for Testing

The globally installed `selftune` runs from npm, not your working tree. To test local changes end-to-end (hooks, materialization, dashboard):

```bash
npm link                     # global selftune → your source tree
# ... test ...
npm install -g selftune@latest  # revert to published version
```

While linked, hooks in `~/.claude/settings.json` point through the symlink to your local code — changes take effect immediately.

### Schema Change Checklist

When modifying JSONL log schemas or adding new fields, update all of these to keep the pipeline consistent:

| File                                  | What to update                            |
| ------------------------------------- | ----------------------------------------- |
| `cli/selftune/types.ts`               | Add/modify the TypeScript interface       |
| `cli/selftune/constants.ts`           | Add log path constant if new file         |
| `cli/selftune/localdb/schema.ts`      | Add column to SQLite schema               |
| `cli/selftune/localdb/materialize.ts` | Map JSONL field → SQLite column           |
| `cli/selftune/normalization.ts`       | Update canonical derivation if applicable |
| `cli/selftune/dashboard-contract.ts`  | Expose field to dashboard API             |
| `apps/local-dashboard/src/`           | Consume field in UI components            |
| `skill/references/logs.md`            | Document the field for agents             |

### Common Data Issues

| Symptom                                  | Fix                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Dashboard shows stale data               | `selftune sync --force`                                                             |
| SQLite schema mismatch after code change | `selftune export` first, then `rm ~/.selftune/selftune.db && selftune sync --force` |
| Missing invocations after hook changes   | Verify `~/.claude/settings.json` matchers, then `selftune doctor`                   |
| Need to backfill from transcripts        | `selftune ingest claude --force`                                                    |

## Questions?

Open a [discussion](https://github.com/selftune-dev/selftune/discussions) or file an [issue](https://github.com/selftune-dev/selftune/issues).
