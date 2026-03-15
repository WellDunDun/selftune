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
make check    # Runs lint + architecture lint + all tests
make lint     # Biome check + architecture lint only
make test     # Tests only
```

All checks must pass before submitting a PR.

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

[Biome](https://biomejs.dev) handles formatting and linting. Run before submitting:

```bash
bun run lint:fix
```

## Pull Request Expectations

- **Concise summary** describing what changed and why
- **All checks pass** — `make check` must succeed
- **No new runtime dependencies** — selftune uses only Bun built-ins
- **Tests included** for new functionality
- **One concern per PR** — keep changes focused

## Zero Runtime Dependencies

selftune intentionally has zero runtime dependencies. All functionality uses Bun built-ins. Do not add `dependencies` to `package.json`.

## Questions?

Open a [discussion](https://github.com/selftune-dev/selftune/discussions) or file an [issue](https://github.com/selftune-dev/selftune/issues).
