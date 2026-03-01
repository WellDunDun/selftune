# Contributing to selftune

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- Git

## Setup

```bash
# Clone the repo
git clone https://github.com/WellDunDun/selftune.git
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

Open a [discussion](https://github.com/WellDunDun/selftune/discussions) or file an [issue](https://github.com/WellDunDun/selftune/issues).
