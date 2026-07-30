# AGENTS.md

## Repository Overview

selftune — Self-improving skills for AI agents. Watches real sessions, learns how users actually work, and evolves skill descriptions to match. Supports Claude Code, Codex, OpenCode, OpenClaw, and Pi.

**Stack:** TypeScript on Bun for the CLI, Drizzle over Bun SQLite for operational/product state, a separate DuckDB observability-analytics domain, legacy/export JSONL recovery paths, Effect for owned runtime lifecycles, and a local React/Vite dashboard SPA.

## Vendored Effect Reference

- `.repos/effect` is the pinned Effect 4 source used as read-only reference material.
- Do not edit or import from `.repos/effect`; application code must continue importing normal package dependencies.
- Before writing Effect code, read `.repos/effect/LLMS.md` and inspect matching source, tests, and API signatures.
- Editor search, file watching, and auto-imports must remain excluded from `.repos/**`.

## Agent-First Architecture

**selftune is a skill consumed by AI agents, not a CLI tool used by humans directly.**

The user's interaction model is:

1. Install the skill: `npx skills add selftune-dev/selftune`
2. Tell their agent: "set up selftune" / "improve my skills" / "how are my skills doing?"
3. The agent reads `skill/SKILL.md`, routes to the correct workflow, and runs CLI commands

The `selftune` binary composed in `apps/cli/` is the **agent's API**. The skill definition (`skill/SKILL.md`) is the **product surface**. Workflow docs (`skill/workflows/`) are the **agent's instruction manual**. Users rarely if ever run `selftune` commands directly — their coding agent does it for them.

**When developing selftune:**

- Changes to CLI behavior must be reflected in the corresponding `skill/workflows/*.md` doc
- New CLI commands need a workflow doc and a routing entry in `skill/SKILL.md`
- Error messages should guide the agent, not the human (e.g., suggest the next CLI command, not "check the docs")
- The SKILL.md routing table and trigger keywords are as important as the CLI code itself — they determine whether the agent can find and use the feature
- `skill/SKILL.md` and `skill/workflows/*.md` are shipped product surface for users' agents. Do not put repo-local contributor commands or monorepo workflow there (for example: `cd oss/selftune`, `bun run dev`, Vite/HMR details). Put contributor guidance in `README.md`, `AGENTS.md`, or internal docs instead.

## Project Structure

```text
selftune/
├── apps/
│   ├── cli/                  # Command composition root; owns argument routing
│   ├── local/                # Process composition, Effect operations, HTTP routes, and OS service host
│   ├── local-dashboard/      # Shared React/Vite dashboard client
│   ├── desktop/              # Scoped Effect supervisor plus Electron window, tray, updater, and IPC adapters
│   ├── use-once-helper/      # Separate signed ephemeral shared-skill runner; never installs SelfTune
│   └── selfhost/             # One-container dashboard and Remote Library host
├── packages/
│   ├── config/               # Persisted config schemas, path resolution, loading, and atomic writes
│   ├── runtime/              # Local filesystem, SQLite/Drizzle, and host adapters
│   ├── library/              # Catalog, Skill Sets, and Remote Library protocol core
│   ├── local-store/          # Effect-managed SQLite lifecycle, Drizzle schema, and migrations
│   ├── observability/        # Effect-owned DuckDB trace analytics and derived signal queries
│   ├── skill-intelligence/   # Pure classification, pattern discovery, validation, and outcomes
│   ├── source-management/    # Source identity, update contracts, and sync service
│   ├── orchestration/        # Setup convergence/onboarding plus sync, improve, run, and scheduling workflows
│   ├── harnesses/
│   │   ├── core/             # Harness-neutral hook protocol, source-adapter contract, and stdin/session utilities
│   │   ├── registry/         # Split descriptor/source registries for all shipped harnesses
│   │   ├── claude-code/      # Claude Code hooks and transcript ingestion
│   │   ├── codex/            # Codex hooks, installer, rollout ingestion, and wrapper
│   │   ├── opencode/         # OpenCode hooks, installer, and ingestion
│   │   ├── cline/            # Cline hooks and installer
│   │   ├── pi/               # Pi hooks, installer, and ingestion
│   │   └── openclaw/         # OpenClaw ingestion and cron adapter
│   ├── control-plane/        # Effect services, domain contracts, programs, and Layers
│   ├── dashboard-core/       # Host-neutral dashboard shell and route contracts
│   ├── telemetry-contract/   # Canonical telemetry contract
│   └── ui/                   # Shared UI primitives and components
├── cli/selftune/             # Backward-compatible CLI and hook shims only
├── bin/selftune.cjs          # npm binary shim into apps/cli
├── skill/                    # Agent-facing routing table, workflows, and references
├── tests/                    # Cross-package behavior and release tests
└── scripts/                  # Release, packaging, and validation tooling
```

The root `selftune` package remains the publishable npm compatibility facade. New command
implementation belongs in `apps/cli`; local host behavior belongs in `apps/local`; reusable
behavior belongs in a package. Do not add implementation modules under `cli/selftune`.

## Architecture

See ARCHITECTURE.md for domain map, module layering, and dependency rules.

## Documentation Map

| Topic                   | Location                                   | Status  |
| ----------------------- | ------------------------------------------ | ------- |
| System Overview         | docs/design-docs/system-overview.md        | Current |
| Operator Guide          | docs/operator-guide.md                     | Current |
| Architecture            | ARCHITECTURE.md                            | Current |
| Product Requirements    | PRD.md                                     | Current |
| Skill Definition        | skill/SKILL.md                             | Current |
| Design Docs             | docs/design-docs/index.md                  | Current |
| Core Beliefs            | docs/design-docs/core-beliefs.md           | Current |
| Live Dashboard SSE      | docs/design-docs/live-dashboard-sse.md     | Current |
| SQLite-First Migration  | docs/design-docs/sqlite-first-migration.md | Current |
| Agent CLI Contract      | docs/design-docs/agent-cli-contract.md     | Current |
| Product Specs           | docs/product-specs/index.md                | Current |
| Active Plans (~4 epics) | docs/exec-plans/active/                    | Current |
| Completed Plans         | docs/exec-plans/completed/                 | Current |
| Deferred Plans          | docs/exec-plans/deferred/                  | Current |
| Technical Debt          | docs/exec-plans/tech-debt-tracker.md       | Current |
| Risk Policy             | risk-policy.json                           | Current |
| Golden Principles       | docs/golden-principles.md                  | Current |
| Escalation Policy       | docs/escalation-policy.md                  | Current |
| References              | skill/references/                          | Current |
| Launch Playbook         | docs/launch-playbook-tracker.md            | Current |
| Security Policy         | SECURITY.md                                | Current |
| Contributing Guide      | CONTRIBUTING.md                            | Current |
| Code of Conduct         | CODE_OF_CONDUCT.md                         | Current |
| License                 | LICENSE                                    | Current |

## Change Propagation Map

When changing one part of selftune, check if dependent files need updating.
This prevents stale docs and broken contracts.

| If you change...                                              | Also update...                                                                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI commands in `apps/cli/src/main.ts` (add/rename/remove)    | `skill/SKILL.md` Quick Reference + Workflow Routing table, `README.md` Commands table, `AGENTS.md` project tree                                         |
| CLI flags on any command                                      | The command's `skill/workflows/*.md` doc (flags table + examples)                                                                                       |
| Persisted config schema or path policy                        | `packages/config/`, runtime/local-store compatibility exports, `ARCHITECTURE.md` ownership and dependency rules                                         |
| JSONL log schema or new log file                              | `packages/runtime/constants.ts`, `packages/runtime/types.ts`, `skill/references/logs.md`, local DB writers/queries, `ARCHITECTURE.md` data architecture |
| Dashboard contract (`packages/runtime/dashboard-contract.ts`) | `apps/local-dashboard/src/types.ts`, dashboard components that consume the changed fields                                                               |
| Hook or adapter behavior (`packages/harnesses/**`)            | `skill/workflows/Initialize.md` hook table, `skill/settings_snippet.json`, `skill/workflows/PlatformHooks.md`                                           |
| Orchestration behavior (`packages/orchestration/**`)          | Relevant `skill/workflows/*.md` (for example Initialize or Orchestrate), plus `ARCHITECTURE.md` operating modes                                         |
| Agent files (`skill/agents/*.md`)                             | `skill/SKILL.md` Specialized Agents table                                                                                                               |
| New workflow file                                             | `skill/SKILL.md` Workflow Routing table + Resource Index                                                                                                |
| Evolution pipeline changes                                    | `skill/workflows/Evolve.md`, `docs/design-docs/evolution-pipeline.md`                                                                                   |
| Platform adapter (ingestor) changes                           | `skill/workflows/Ingest.md`, `README.md` Platforms section                                                                                              |
| CLI error handling (`packages/runtime/utils/cli-error.ts`)    | `docs/design-docs/agent-cli-contract.md` error codes table, all CLI entry points that import CLIError                                                   |
| Repo org/name change                                          | `README.md` badges + install, `llms.txt`, `SECURITY.md`, `CONTRIBUTING.md`, `contribute.ts` repo constant, `package.json` (homepage/repo/bugs)          |

## Mandatory Rules (If/Then)

These rules are non-negotiable. Before performing the action in the "If" column, you MUST complete the "Then" action first.

| If you are about to...                                                        | Then FIRST...                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Add, rename, or remove a CLI command in `index.ts`                            | Update `skill/SKILL.md` Quick Reference and Workflow Routing table                                            |
| Modify CLI flags on any command                                               | Update that command's `skill/workflows/*.md` doc (flags table + examples)                                     |
| Edit hook behavior in `hooks/*.ts`, `hooks-shared/*`, or `adapters/*/hook.ts` | Update `skill/workflows/Initialize.md`, `skill/settings_snippet.json`, and `skill/workflows/PlatformHooks.md` |
| Change `dashboard-contract.ts` fields                                         | Update `apps/local-dashboard/src/types.ts` and consuming dashboard components                                 |
| Add a new file to `evolution/`                                                | Update `ARCHITECTURE.md` domain map and module definitions table                                              |
| Modify the evolution pipeline (`evolution/*.ts`)                              | Update `skill/workflows/Evolve.md`                                                                            |
| Change error handling patterns (`utils/cli-error.ts`)                         | Update `docs/design-docs/agent-cli-contract.md` error codes table                                             |
| Create a new workflow file in `skill/workflows/`                              | Add routing entry in `skill/SKILL.md` Workflow Routing table + Resource Index                                 |
| Edit `orchestrate.ts` behavior                                                | Update `skill/workflows/Orchestrate.md`                                                                       |
| Commit any changes                                                            | Run `bunx oxlint` and `bunx oxfmt --check` on changed files                                                   |

## Development Workflow

1. Receive task via prompt
2. Read this file, then follow pointers to relevant docs
3. Read PRD.md for product context and the feedback loop model
4. Implement changes following ARCHITECTURE.md layer rules
5. **Check the Change Propagation Map above** — update dependent docs before committing
6. Run sandbox harness: `bun run tests/sandbox/run-sandbox.ts`
7. Run `make check` (lint + test) or `bun test`
8. Verify JSONL output schema matches appendix in PRD.md
9. Self-review: check log schema compatibility across all platforms
10. Open PR with concise summary

## Key Constraints

- **selftune is agent-first:** users interact through their coding agent, not the CLI directly. SKILL.md and workflow docs are the product surface; the CLI is the agent's API.
- Claude Code is the primary supported platform; Codex, OpenCode, OpenClaw, and Pi adapters are experimental (they exist but are not actively tested). All five write to the same shared log schema
- Source-truth transcripts/rollouts are authoritative; hooks are low-latency hints, not the canonical record
- Grading uses the user's existing agent subscription — no separate API key
- Hooks should be zero-config after installation where the host agent supports them
- SQLite is the sole operational/product write target. DuckDB is the separate
  rebuildable observability-analytics store for trace facts, metrics, and
  cross-trace aggregation; it never owns product lifecycle state. Legacy
  SelfTune JSONL files on disk are pre-cutover history only, while
  source-native transcripts, rollouts, and session stores remain authoritative
  import sources (see docs/design-docs/sqlite-first-migration.md).
- Evolution proposals require validation against eval set before deploy
- `selftune orchestrate` is the primary autonomous loop; `selftune cron setup` installs OS-level scheduling (`selftune schedule` is a backward-compatible alias)
- `bun run dev` atomically claims a stable worktree-specific port block for the watched dashboard runtime and Vite; use `dev:status`, `dev:open`, and conservative `dev:reap` rather than assuming fixed ports
- All knowledge lives in-repo, not in external tools
- `packages/config` is the canonical owner of persisted config schemas, environment-derived paths, loading, and atomic writes. Runtime and local-store may re-export stable compatibility names but must not redefine that policy.
- Keep runtime dependencies explicit and owned at the narrowest package boundary. The local database uses `drizzle-orm`; process and resource lifecycles use Effect; platform I/O should still prefer Bun and Node built-ins.
- **`@selftune/telemetry-contract` uses `workspace:*` in the repo; `prepack` rewrites to `file:` at publish time.** Do NOT hardcode `file:` (causes bun lockfile duplicates) or remove the prepack/postpack scripts (breaks registry installs). A CI test (`tests/trust-floor/publish-deps.test.ts`) enforces the full pipeline.

## Golden Principles

See docs/golden-principles.md for the full set of mechanical taste rules.
