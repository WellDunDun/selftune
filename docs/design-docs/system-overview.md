<!-- Verified: 2026-03-15 -->

# System Overview

This is the fastest way to understand how selftune works today.

## In One Sentence

selftune observes agent work from local transcripts and telemetry, rebuilds a trustworthy local record with `sync`, decides whether a skill needs help, deploys validated low-risk description fixes, watches for regressions, and exposes the loop through a local dashboard SPA.

## The Mental Model

selftune has four layers:

1. **Capture** — transcripts, rollouts, session stores, and hooks produce raw evidence.
2. **Normalize** — `selftune sync` rebuilds shared JSONL logs and repaired overlays.
3. **Decide and act** — grading, evolution, orchestrate, watch, and rollback use that evidence.
4. **Surface** — `status`, `last`, and the local SPA explain what the system knows and did.

## End-to-End System

```mermaid
flowchart LR
  User[Developer] --> Agent[Claude Code / Codex / OpenCode / OpenClaw]
  Agent --> Sources[Transcripts / rollouts / session stores]
  Agent -. low-latency hints .-> Hooks[Claude hooks]

  Sources --> Sync[selftune sync]
  Hooks --> RawLogs[Append-only JSONL logs]
  Sync --> RawLogs
  Sync --> Repaired[Repaired skill-usage overlay]

  RawLogs --> Eval[Eval + grading]
  Repaired --> Eval
  Eval --> Orchestrate[selftune orchestrate]
  Orchestrate --> Evolve[Evolve / deploy / audit]
  Orchestrate --> Watch[Watch / rollback]

  RawLogs --> LocalDB[SQLite materialization]
  Repaired --> LocalDB
  Evolve --> LocalDB
  Watch --> LocalDB

  LocalDB --> Server[dashboard-server v2 API]
  Server --> SPA[Local dashboard SPA]
  Server --> CLI[status / last / badge]
```

## What Is Authoritative?

Hooks are useful, but they are not the main source of truth.

```mermaid
flowchart TD
  Hooks[Hook events] --> HintView[Low-latency hints]
  SourceStores[Transcripts / rollouts / session history] --> Sync[selftune sync]
  Sync --> Truth[Canonical local evidence]
  HintView -. enriches .-> Truth
```

### Practical rule

- Trust `selftune sync` before trusting `status`, `dashboard`, `watch`, or `orchestrate`.
- Treat hooks as convenience signal for Claude Code, not the canonical record for autonomous changes.

## What Happens During `selftune orchestrate`

```mermaid
sequenceDiagram
  participant User
  participant Orchestrate
  participant Sync
  participant Status
  participant Evolve
  participant Watch

  User->>Orchestrate: selftune orchestrate
  Orchestrate->>Sync: rebuild source-truth telemetry
  Sync-->>Orchestrate: shared logs + repaired overlay
  Orchestrate->>Status: compute current skill health
  Status-->>Orchestrate: candidates + reasons
  Orchestrate->>Evolve: validate and deploy low-risk description changes
  Evolve-->>Orchestrate: deployed proposals + audit trail
  Orchestrate->>Watch: monitor recent deployments
  Watch-->>Orchestrate: stable or rollback result
  Orchestrate-->>User: decision report
```

### Current autonomy posture

- Low-risk description evolution is autonomous by default.
- Validation is mandatory before deploy.
- Watch and rollback are the safety system after deploy.
- Review-required mode is optional policy, not the main product identity.

## What Happens When You Open The Dashboard

```mermaid
sequenceDiagram
  participant Browser
  participant Server as dashboard-server
  participant DB as SQLite localdb
  participant Materializer as selftune sync/materialize

  Browser->>Server: GET /
  Server-->>Browser: SPA shell
  Browser->>Server: GET /api/v2/overview
  Server->>DB: overview query
  DB-->>Server: OverviewPayload
  Server-->>Browser: JSON
  Browser->>Server: GET /api/v2/skills/:name
  Server->>DB: skill report query
  DB-->>Server: SkillReportPayload
  Server-->>Browser: JSON
  Browser->>Server: GET /api/v2/orchestrate-runs
  Server->>DB: recent orchestrate runs query
  DB-->>Server: OrchestrateRunsResponse
  Server-->>Browser: JSON
  Materializer->>DB: refresh from logs when sync/materialize runs
```

## The Main Local Artifacts

| Artifact | Role |
|---|---|
| `~/.claude/*.jsonl` | Shared append-only logs for telemetry, queries, repaired usage, and evolution audit |
| `~/.claude/orchestrate_runs.jsonl` | Persisted orchestrate run reports for CLI and dashboard inspection |
| `selftune sync` | Rebuilds trustworthy local evidence from source systems |
| `cli/selftune/localdb/` | Materializes logs into SQLite tables and payload-oriented queries |
| `cli/selftune/dashboard-server.ts` | Serves the SPA and the v2 dashboard API |
| `apps/local-dashboard/` | Overview, recent orchestrate activity, and per-skill report UI |

## What selftune Is Not

- Not a hooks-only product
- Not a generic LLM tracing dashboard
- Not a cloud-first dependency for the core loop
- Not a human approval queue for routine low-risk description fixes

## Read Next

- [ARCHITECTURE.md](../../ARCHITECTURE.md) for module boundaries and dependency rules
- [PRD.md](../../PRD.md) for product intent and success metrics
- [docs/integration-guide.md](../integration-guide.md) for setup paths
