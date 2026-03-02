# Architecture — selftune

## Domain Map

| Domain | Directory | Description | Quality Grade |
|--------|-----------|-------------|---------------|
| Bootstrap | `cli/selftune/init.ts` | Agent detection, config write, hook check | B |
| Telemetry | `cli/selftune/hooks/` | Session capture hooks and log writers | B |
| Ingestors | `cli/selftune/ingestors/` | Platform adapters (Claude Code, Codex, OpenCode) | B |
| Eval | `cli/selftune/eval/` | False negative detection and eval set generation | C |
| Grading | `cli/selftune/grading/` | 3-tier session grading (trigger/process/quality) | C |
| Evolution | `cli/selftune/evolution/` | Description improvement loop, deploy, rollback | B |
| Monitoring | `cli/selftune/monitoring/` | Post-deploy regression detection and alerting | B |
| Contribute | `cli/selftune/contribute/` | Opt-in anonymized data export for community contribution | C |
| Observability CLI | `cli/selftune/status.ts`, `cli/selftune/last.ts` | Skill health summary and last session insight | B |
| Auto-Activation | `cli/selftune/hooks/auto-activate.ts`, `cli/selftune/activation-rules.ts` | UserPromptSubmit hook with configurable trigger rules | B |
| Memory & Context | `cli/selftune/memory/writer.ts` | 3-file evolution memory persistence (~/.selftune/memory/) | B |
| Enforcement Guardrails | `cli/selftune/hooks/evolution-guard.ts`, `cli/selftune/hooks/skill-change-guard.ts` | PreToolUse hooks blocking unguarded SKILL.md edits | B |
| Dashboard | `cli/selftune/dashboard.ts`, `cli/selftune/dashboard-server.ts`, `dashboard/` | HTML dashboard + live Bun.serve server with SSE | B |
| Specialized Agents | `.claude/agents/*.md` | Purpose-built agents (diagnosis, pattern, reviewer, integration) | B |
| Skill | `skill/` | Agent-facing skill (routing table + workflows + references) | B |

## The Feedback Loop

```
Observe → Detect → Diagnose → Propose → Validate → Deploy → Watch → Repeat
```

Telemetry feeds Ingestors, Ingestors feed Eval, Eval feeds Grading, Grading feeds Evolution.

## Module Architecture

Dependencies flow forward only through the pipeline.

```
cli/selftune/
├── index.ts              CLI entry point (command router)
├── init.ts               Agent detection, config bootstrap → ~/.selftune/config.json
├── activation-rules.ts   Configurable trigger rules for auto-activation
├── observability.ts      Health checks (doctor command)
├── status.ts             Skill health summary (status command)
├── last.ts               Last session insight (last command)
├── dashboard.ts          HTML dashboard builder (dashboard command)
├── dashboard-server.ts   Live Bun.serve server with SSE (dashboard --serve)
├── types.ts              Shared interfaces (incl. SelftuneConfig)
├── constants.ts          Log paths, config paths, known tools
├── utils/                Shared utilities (jsonl, transcript, logging, llm-call, schema-validator)
│                         LLM calls use callViaAgent() which spawns `claude -p` as a
│                         subprocess. In devcontainer testing, this runs with
│                         --dangerously-skip-permissions for unattended operation.
├── hooks/                Telemetry + activation + enforcement
│   ├── prompt-log.ts, skill-eval.ts, session-stop.ts   (telemetry capture)
│   ├── auto-activate.ts                                (auto-activation)
│   ├── skill-change-guard.ts, evolution-guard.ts       (enforcement guardrails)
│     │
│     v
├── memory/              Evolution memory persistence
│   └── writer.ts        3-file system (~/.selftune/memory/)
│     │
│     v
├── ingestors/            Platform adapters (normalize)
│     │
│     v
│   Shared Log Schema (~/.claude/*.jsonl)
│     │
│     v
├── eval/                 False negative detection (analyze)
│     │
│     v
├── grading/              Session grading (assess)
│     │
│     v
├── evolution/            Description improvement (propose, validate, deploy, rollback)
│     │
│     v
└── monitoring/           Post-deploy regression watch

.claude/agents/           Specialized Claude Code agents
├── diagnosis-analyst.md  Diagnose skill triggering failures
├── pattern-analyst.md    Analyze usage patterns across sessions
├── evolution-reviewer.md Review proposed skill evolutions
└── integration-guide.md  Guide project integration setup

dashboard/                HTML dashboard template
└── index.html            Skill-health-centric SPA with embedded JSON data

templates/                Settings and config templates
├── single-skill-settings.json
├── multi-skill-settings.json
└── activation-rules-default.json

skill/                    Agent-facing skill
├── SKILL.md              Routing table (triggers → workflows)
├── Workflows/            Step-by-step guides (1 per command)
└── references/           Domain knowledge (logs, grading, taxonomy)

tests/sandbox/
├── run-sandbox.ts          # Layer 1: Local sandbox orchestrator (10 tests, ~400ms)
├── fixtures/               # 3 skills, 15 sessions, 30 queries, hook payloads
├── docker/                 # Layer 2: Devcontainer + claude -p LLM test runner
└── results/                # Test run output (gitignored)
```

### Module Definitions

| Module | Directory | Files | Responsibility | May Import From |
|--------|-----------|-------|---------------|-----------------|
| Shared | `cli/selftune/` | `types.ts`, `constants.ts`, `utils/*.ts` | Shared types, constants, utilities | Bun built-ins only |
| Bootstrap | `cli/selftune/` | `init.ts`, `observability.ts` | Agent detection, config, health checks | Shared only |
| Telemetry | `cli/selftune/hooks/` | `prompt-log.ts`, `session-stop.ts`, `skill-eval.ts` | Capture session data via hooks | Shared only |
| Auto-Activation | `cli/selftune/hooks/`, `cli/selftune/` | `auto-activate.ts`, `activation-rules.ts` | Detect when selftune should run, output suggestions | Shared only |
| Enforcement | `cli/selftune/hooks/` | `evolution-guard.ts`, `skill-change-guard.ts` | Block unguarded SKILL.md edits | Shared only |
| Memory | `cli/selftune/memory/` | `writer.ts` | Persist evolution context across resets | Shared only |
| Ingestors | `cli/selftune/ingestors/` | `codex-wrapper.ts`, `codex-rollout.ts`, `opencode-ingest.ts`, `claude-replay.ts` | Normalize platform data | Shared only |
| Eval | `cli/selftune/eval/` | `hooks-to-evals.ts` | Detect false negatives, generate eval sets | Shared only |
| Grading | `cli/selftune/grading/` | `grade-session.ts` | Grade sessions across 3 tiers | Shared only |
| Evolution | `cli/selftune/evolution/` | `extract-patterns.ts`, `propose-description.ts`, `validate-proposal.ts`, `audit.ts`, `evolve.ts`, `deploy-proposal.ts`, `rollback.ts`, `stopping-criteria.ts` | Propose and validate description improvements | Shared, Eval |
| Monitoring | `cli/selftune/monitoring/` | `watch.ts` | Post-deploy regression detection | Shared, Evolution/audit |
| Status | `cli/selftune/` | `status.ts` | Skill health summary CLI | Shared, Monitoring, Evolution/audit |
| Last | `cli/selftune/` | `last.ts` | Last session insight CLI | Shared only |
| Dashboard | `cli/selftune/` | `dashboard.ts`, `dashboard-server.ts` | HTML dashboard builder + live SSE server | Shared, Monitoring, Evolution/audit |
| Agents | `.claude/agents/` | `diagnosis-analyst.md`, `pattern-analyst.md`, `evolution-reviewer.md`, `integration-guide.md` | Specialized Claude Code agents | Reads log schema + config |
| Skill | `skill/` | `SKILL.md`, `Workflows/*.md`, `references/*.md`, `settings_snippet.json` | Agent-facing routing, workflows, domain knowledge | Reads log schema + config |
| Sandbox | `tests/sandbox/` | `run-sandbox.ts`, `fixtures/`, `docker/` | Sandbox test harness and Docker integration tests | All modules (test-only) |

### Enforcement

These rules are enforced mechanically:
- [x] Import direction lint: hooks must not import from grading/eval (`lint-architecture.ts`)
- [x] Schema validation: all JSONL writers validate against shared schema (`utils/schema-validator.ts`)
- [x] CI gate: `make check` must pass before merge (`.github/workflows/ci.yml`)

## Config System

The `init` command writes `~/.selftune/config.json` with agent identity and resolved paths:

| Field | Type | Description |
|-------|------|-------------|
| `agent_type` | `claude_code \| codex \| opencode \| unknown` | Detected agent environment |
| `cli_path` | `string` | Absolute path to `cli/selftune/index.ts` |
| `llm_mode` | `agent \| api` | How grading/evolution invoke LLMs |
| `agent_cli` | `string \| null` | Agent CLI binary name (e.g., `claude`) |
| `hooks_installed` | `boolean` | Whether telemetry hooks are configured (Claude Code only) |
| `initialized_at` | `string` | ISO timestamp of last init |

All skill workflows read this config to build CLI invocations. The `doctor` command includes config health in its checks.

## Skill Structure

The skill follows a routing-table pattern (modeled after Reins):

| Layer | File(s) | Purpose |
|-------|---------|---------|
| Routing | `skill/SKILL.md` | Trigger keywords → workflow file mapping |
| Workflows | `skill/Workflows/*.md` | Step-by-step guides (1 per command) |
| References | `skill/references/*.md` | Domain knowledge shared across workflows |

Each workflow is self-contained: an agent reading a single workflow file plus its referenced docs can operate the command independently.

## Log Schema (Shared Interface)

All modules communicate through four JSONL files:

| File | Writer | Reader |
|------|--------|--------|
| `~/.claude/session_telemetry_log.jsonl` | Telemetry, Ingestors | Eval, Grading, Status, Last, Dashboard |
| `~/.claude/skill_usage_log.jsonl` | Telemetry | Eval, Status, Last, Dashboard |
| `~/.claude/all_queries_log.jsonl` | Telemetry, Ingestors | Eval, Status, Last, Dashboard |
| `~/.claude/evolution_audit_log.jsonl` | Evolution | Monitoring, Status, Dashboard |

## Three-Tier Evaluation Model

| Tier | What It Checks | Automated |
|------|---------------|-----------|
| Tier 1 — Trigger | Did the skill fire at all? | Yes |
| Tier 2 — Process | Did it follow the right steps? | Yes |
| Tier 3 — Quality | Was the output actually good? | Yes (agent-as-grader) |

## Invocation Taxonomy

| Type | Description |
|------|-------------|
| Explicit | Names the skill directly |
| Implicit | Describes the task without naming the skill |
| Contextual | Implicit with domain noise |
| Negative | Adjacent queries that should NOT trigger |
