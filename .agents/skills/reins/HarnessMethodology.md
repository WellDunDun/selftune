# Harness Engineering Methodology Reference

> Source: OpenAI's "Harness Engineering" (Feb 2026, Ryan Lopopolo)

## Philosophy

Build and ship software with **zero manually-written code**. Humans design environments, specify intent, and build feedback loops. Agents write all code, tests, CI, docs, and tooling.

## Reins CLI Mapping

Reins turns the methodology into four operational commands:
- `reins init` — scaffold repository knowledge and governance artifacts
- `reins audit` — score maturity across six dimensions (0-18)
- `reins doctor` — produce actionable pass/fail/warn health checks
- `reins evolve` — generate step-by-step upgrades to the next level

## The Five Pillars

### 1. Repository as System of Record

All knowledge must be versioned, in-repo, and agent-discoverable:

```
AGENTS.md              # ~100 lines, map to deeper docs
ARCHITECTURE.md        # Domain map, package layering, dependency rules
docs/
  design-docs/         # Indexed design decisions with verification status
    index.md
    core-beliefs.md
  exec-plans/          # First-class execution plans
    active/
    completed/
    tech-debt-tracker.md
  generated/           # Auto-generated docs (DB schema, API specs)
  product-specs/       # Product requirements and specs
    index.md
  references/          # External reference docs (LLM-friendly)
```

**Rules:**
- AGENTS.md is a map, not a manual (~100 lines)
- No knowledge lives in Slack, Google Docs, or human heads
- A "doc-gardening" agent scans for stale docs on a cadence
- A verification agent checks freshness and cross-links

### 2. Layered Domain Architecture

Each business domain follows a strict layer ordering:

```
Utils
  |
  v
Business Domain
  +-- Types --> Config --> Repo --> Service --> Runtime --> UI
  |
  +-- Providers (cross-cutting: auth, connectors, telemetry, feature flags)
        |
        v
      App Wiring + UI
```

**Rules:**
- Dependencies only flow "forward" (left to right)
- Cross-cutting concerns enter ONLY through Providers
- Enforce mechanically with custom linters and structural tests
- Violations fail CI, not code review

### 3. Agent Legibility

Optimize everything for agent understanding:

- Boot the app per git worktree (one instance per change)
- Wire Chrome DevTools Protocol into agent runtime (DOM snapshots, screenshots, navigation)
- Expose logs/metrics/traces via local observability stack (LogQL, PromQL, TraceQL)
- Ephemeral observability per worktree, torn down after task completion
- For CLI-first repositories, prioritize diagnosability surfaces (structured command output, doctor/help commands, deterministic error metadata) when full service observability is not relevant
- Prefer "boring" technology — composable, stable APIs, well-represented in training data
- Reimplement simple utilities rather than pulling opaque dependencies

### 4. Golden Principles (Mechanical Taste)

Opinionated rules that encode human taste mechanically:

- Prefer shared utility packages over hand-rolled helpers
- Validate data at boundaries, never probe shapes YOLO-style
- Use typed SDKs wherever possible
- Formatting and structural rules enforced in CI
- Rules checked and enforced by agents themselves
- Capture review feedback as documentation or tooling updates

### 5. Garbage Collection (Continuous Cleanup)

- Background agents scan for deviations on a recurring cadence
- Quality grades track each domain and architectural layer
- Targeted refactoring PRs auto-generated and auto-merged
- Technical debt paid continuously in small increments
- Stale documentation detected and updated automatically

## Agent Autonomy Levels

### Level 1: Prompted Execution
Agent receives prompt, writes code, opens PR. Human reviews and merges.

### Level 2: Agent Review Loop
Agent writes code, runs self-review, requests agent reviews, iterates until satisfied. Human spot-checks.

### Level 3: Full Autonomy
Agent validates codebase, reproduces bug, implements fix, validates fix, opens PR, responds to feedback, remediates failures, merges. Escalates only when judgment needed.

## Merge Philosophy

- Minimal blocking merge gates
- Short-lived PRs
- Test flakes addressed with follow-up runs, not blocking
- Corrections are cheap; waiting is expensive

## Patterns from Production

Real-world signals observed in production harness-engineered codebases that indicate mature practices:

### 1. Risk Policy as Code
`risk-policy.json` defines risk tiers, watch paths, and escalation rules. Enables automated decisions about review depth and deployment gates.

### 2. Verification Headers
`<!-- Verified: DATE | Status -->` headers in documentation files. Enables automated freshness tracking and doc-gardening.

### 3. Doc-Gardener Automation
Freshness scripts in CI that scan for stale docs, missing verification headers, and orphaned references. Runs on a cadence, not just at PR time.

### 4. Hierarchical AGENTS.md
Per-package AGENTS.md files in monorepos. Each package has its own discoverable context, avoiding a single monolithic file that rots instantly.

### 5. Design Decision Records with Consequences
Design docs that track not just the decision but also the consequences, trade-offs, and verification status. Indexed in `design-docs/index.md`.

### 6. Execution Plan Culture
Workstream tracking with versioned execution plans in-repo. Active plans, completed plans, and tech debt tracked as first-class artifacts.

### 7. Quality Grades per Domain
A/B/C/D grades assigned per domain and architectural layer. Provides clear visibility into where quality is strong and where cleanup is needed.

### 8. Lint Baseline/Ratchet Mechanism
Structural lint rules that only tighten over time. New violations fail CI, but existing violations are baselined and reduced incrementally.

### 9. Product Specs as Harness Artifacts
Product requirements versioned in-repo alongside design docs and execution plans. Agents can reference specs directly rather than relying on external tools.

### 10. i18n as Schema Constraint
Internationalization treated as a structural schema constraint rather than an afterthought. Enforced at the type level, not bolted on later.

## Anti-Patterns

- One giant AGENTS.md (context starvation, instant rot)
- Knowledge in external tools (Slack, Google Docs, wikis)
- Human code fixes (removes incentive for self-correction)
- Manual code review as primary quality gate
- Opaque dependencies agents can't reason about
- Letting tech debt compound without garbage collection
