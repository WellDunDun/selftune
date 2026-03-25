# Execution Plan: Multi-Agent Sandbox Expansion

<!-- Verified: 2026-03-02 -->

**Status:** Active
**Created:** 2026-03-02
**Goal:** Expand the sandbox test harness from Claude Code-only to cover all three agents (Claude Code, Codex, OpenCode) with shared fixtures, per-agent Layer 1 tests, and per-agent Layer 2 Docker containers.

---

## Problem Statement

The sandbox test harness currently only covers Claude Code:

1. **Design doc scope**: `sandbox-test-harness.md` is named generically but describes only Claude Code
2. **Fixture scope**: All fixtures are Claude Code-specific (hook payloads, settings.json, transcripts)
3. **No Layer 2 containers**: Only a Claude Code devcontainer exists — no Codex or OpenCode containers
4. **No per-agent Layer 1 tests**: Ingestor tests for Codex and OpenCode don't exist in the sandbox

---

## Target Architecture

### Directory Structure

```text
tests/sandbox/
├── run-sandbox.ts              # Shared Layer 1 (add --agent flag)
├── provision-claude.sh         # Renamed/updated for new fixture paths
├── results/
├── fixtures/
│   ├── shared/                 # Agent-agnostic (JSONL logs, skills)
│   ├── claude-code/            # Config, transcripts, hook-payloads, settings
│   ├── codex/                  # Config, rollout sessions
│   └── opencode/               # Config, opencode.db
├── claude-code/                # Layer 2: Claude Code devcontainer (move from docker/)
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── entrypoint.sh
│   └── run-with-llm.ts
├── codex/                      # Layer 2: Codex container (future)
└── opencode/                   # Layer 2: OpenCode container (future)
```

### Makefile Targets

```makefile
# Layer 1
sandbox:                    # claude-code (default, backward-compatible)
sandbox-codex:
sandbox-opencode:
sandbox-all:                # all agents in sequence

# Layer 2
sandbox-llm:                # claude-code (default)
sandbox-llm-codex:
sandbox-llm-opencode:

# Utility
sandbox-shell:              # claude-code container
sandbox-shell-codex:
```

---

## Implementation Tracks

### Track A: Doc Restructure

Split the generic design doc into shared architecture + Claude Code-specific docs.

| Step | Description                                                                        | Depends On |
| ---- | ---------------------------------------------------------------------------------- | ---------- |
| A1   | Create `sandbox-architecture.md` from shared sections of `sandbox-test-harness.md` | —          |
| A2   | Rename `sandbox-test-harness.md` → `sandbox-claude-code.md`, trim shared content   | A1         |
| A3   | Update `docs/design-docs/index.md` with new file names                             | A2         |

### Track B: Fixture Restructure

Reorganize fixtures into shared + per-agent directories.

| Step | Description                                                                                           | Depends On |
| ---- | ----------------------------------------------------------------------------------------------------- | ---------- |
| B1   | Create `fixtures/shared/` with agent-agnostic JSONL logs and skill definitions                        | —          |
| B2   | Create `fixtures/claude-code/` with Claude Code-specific config, transcripts, hook payloads, settings | B1         |
| B3   | Create `fixtures/codex/` with `selftune-config.json` + rollout JSONL files                            | B1         |
| B4   | Create `fixtures/opencode/` with `selftune-config.json` + SQLite db                                   | B1         |
| B5   | Update `run-sandbox.ts` to read from new fixture paths                                                | B2         |
| B6   | Update `provision-claude.sh` for new fixture paths                                                    | B2         |
| B7   | Add `--agent` flag to `run-sandbox.ts` for agent-specific test selection                              | B5         |

### Track C: Layer 1 Agent Coverage

Add per-agent tests to the local sandbox.

| Step | Description                                                              | Depends On |
| ---- | ------------------------------------------------------------------------ | ---------- |
| C1   | Add Codex ingestor test (`ingest codex --dry-run`)                       | B3         |
| C2   | Add OpenCode ingestor test (`ingest opencode --dry-run`)                 | B4         |
| C3   | Make hook tests conditional on `agent_type === "claude_code"`            | B5         |
| C4   | Add Makefile targets: `sandbox-codex`, `sandbox-opencode`, `sandbox-all` | C1, C2     |

### Track D: Layer 2 Docker Expansion

Create per-agent Docker containers for LLM testing.

| Step | Description                                                                              | Depends On |
| ---- | ---------------------------------------------------------------------------------------- | ---------- |
| D1   | Move `tests/sandbox/docker/` → `tests/sandbox/claude-code/`                              | —          |
| D2   | Update Makefile targets to reference new `claude-code/` path                             | D1         |
| D3   | Create `tests/sandbox/codex/Dockerfile` based on Claude Code pattern                     | D1         |
| D4   | Create `tests/sandbox/codex/docker-compose.yml`                                          | D3         |
| D5   | Create `tests/sandbox/codex/provision.sh` for Codex fixture setup                        | D3, B3     |
| D6   | Create `tests/sandbox/codex/run-with-llm.ts` for Codex LLM tests                         | D4         |
| D7   | Create `tests/sandbox/opencode/Dockerfile` based on Claude Code pattern                  | D1         |
| D8   | Create `tests/sandbox/opencode/docker-compose.yml`                                       | D7         |
| D9   | Create `tests/sandbox/opencode/provision.sh` for OpenCode fixture setup                  | D7, B4     |
| D10  | Create `tests/sandbox/opencode/run-with-llm.ts` for OpenCode LLM tests                   | D8         |
| D11  | Add Makefile targets: `sandbox-llm-codex`, `sandbox-llm-opencode`, `sandbox-shell-codex` | D6, D10    |

### Track E: Per-Agent Design Docs

Document each agent's sandbox after implementation.

| Step | Description                                                                  | Depends On |
| ---- | ---------------------------------------------------------------------------- | ---------- |
| E1   | Write `docs/design-docs/sandbox-codex.md` after Codex sandbox is built       | D6, C1     |
| E2   | Write `docs/design-docs/sandbox-opencode.md` after OpenCode sandbox is built | D10, C2    |
| E3   | Update `ARCHITECTURE.md` sandbox section with multi-agent structure          | E1, E2     |

---

## Design Decisions

| Decision               | Choice                                             | Rationale                                                                       |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| Fixture organization   | `shared/` + per-agent overlays                     | Agent-agnostic data (JSONL logs, skills) shared; agent-specific data isolated   |
| Docker per agent       | Separate Dockerfiles per agent                     | Each agent has different runtime requirements and CLI tools                     |
| Backward compatibility | `sandbox` and `sandbox-llm` default to Claude Code | Existing workflows unbroken                                                     |
| `--agent` flag         | Added to `run-sandbox.ts`                          | Single entry point with agent selection vs. separate scripts                    |
| Track order            | A → B → C → D → E                                  | Docs first (zero risk), then fixtures, then tests, then Docker, then final docs |

---

## Success Criteria

- [ ] Design doc split: `sandbox-architecture.md` + `sandbox-claude-code.md` replace monolithic doc
- [ ] `ROADMAP.md` exists with agent support matrix
- [ ] Fixtures reorganized into `shared/` + per-agent directories
- [ ] `run-sandbox.ts` accepts `--agent` flag
- [ ] Codex ingestor tested in Layer 1 sandbox
- [ ] OpenCode ingestor tested in Layer 1 sandbox
- [ ] Hook tests conditional on `agent_type === "claude_code"`
- [ ] Codex Layer 2 container builds and runs
- [ ] OpenCode Layer 2 container builds and runs
- [ ] All Makefile targets functional
- [ ] `make check` passes throughout
- [ ] Per-agent design docs written after implementation
