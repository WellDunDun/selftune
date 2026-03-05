# Plan: Expand selftune from description-only to full skill evolution

## Context

selftune currently evolves only the description block in SKILL.md — the text between `# Title` and the first `## Section`. Analysis of HuggingFace's upskill (skill generation + eval + refinement) and BenchFlow's SkillsBench (87 real-world agent benchmarks) revealed 10 concrete recommendations for expanding selftune's scope. This plan implements all 10 via a team of parallel agents.

**Problem:** Tier 2 (process) and Tier 3 (quality) failures are detected by grading but selftune can't act on them — it can only fix Tier 1 (trigger) failures via description changes. There's also no baseline comparison, no token efficiency tracking, no composability testing, and no skill-level unit tests.

**Outcome:** selftune evolves full skill content (descriptions, routing tables, and skill bodies), validates with cheaper models, measures baseline lift, tracks token efficiency, tests composability, and can import external eval corpora.

---

## Team Structure (7 agents in parallel)

| Agent | Name | Type | Workstream | Recs |
|-------|------|------|-----------|------|
| 1 | `foundation` | Engineer | Foundation types + shared utils | Prereqs for all |
| 2 | `body-evolve` | Engineer | Skill body evolution pipeline | 1, 6, 8 |
| 3 | `baseline` | Engineer | Baseline comparison system | 2, 9 |
| 4 | `token-pareto` | Engineer | Token efficiency + Pareto expansion | 3 |
| 5 | `unit-tests` | Engineer | Skill-level unit test framework | 5 |
| 6 | `composability` | Engineer | Multi-skill composability analysis | 7 |
| 7 | `skillsbench` | Engineer | SkillsBench task corpus importer | 10 |

Agent 1 (`foundation`) runs first and unblocks agents 2-7. Agents 2-7 run in parallel after foundation completes.

---

## Workstream 1: Foundation (Agent `foundation`) — RUNS FIRST

### 1a. Extract trigger-check utils to shared tier

The `buildTriggerCheckPrompt()` and `parseTriggerResponse()` functions in `cli/selftune/evolution/validate-proposal.ts` must be accessible to `eval/` modules. The architecture linter forbids `eval/` → `evolution/` imports.

**File:** `cli/selftune/utils/trigger-check.ts` (new)
- Move `buildTriggerCheckPrompt()` from `validate-proposal.ts:33-43`
- Move `parseTriggerResponse()` from `validate-proposal.ts:50+`
- Update `validate-proposal.ts` to import from `../utils/trigger-check.js`

### 1b. Add `parseSkillSections()` and `replaceSection()` to deploy-proposal.ts

**File:** `cli/selftune/evolution/deploy-proposal.ts` (modify)
- Add `parseSkillSections(content: string): SkillSections` — splits SKILL.md into named parts (frontmatter, title, description, workflow routing, remaining body)
- Add `replaceSection(content, sectionName, newContent): string` — replaces a `## Section` block
- Add `replaceBody(currentContent, proposedBody): string` — replaces entire body below frontmatter
- Existing `replaceDescription()` unchanged

### 1c. Add `modelFlag` to `callLlm()`

**File:** `cli/selftune/utils/llm-call.ts` (modify)
- Add optional `modelFlag?: string` parameter to `callLlm()` and `callViaAgent()`
- When set and agent is `claude`, append `--model ${modelFlag}` to subprocess args
- Fully backward compatible — all existing callers pass no modelFlag

### 1d. Add new types to types.ts

**File:** `cli/selftune/types.ts` (modify)

```typescript
// Evolution target discriminant
export type EvolutionTarget = "description" | "routing_table" | "full_body";

// Parsed SKILL.md structure
export interface SkillSections {
  frontmatter: string;
  title: string;
  description: string;
  workflowRouting?: string;
  remainingBody: string;
  fullBody: string;
}

// Body evolution proposal (extends EvolutionProposal)
export interface BodyEvolutionProposal extends EvolutionProposal {
  evolution_target: EvolutionTarget;
  proposed_body?: string;
  proposed_routing_table?: string;
}

// Body validation (extends ValidationResultBase)
export interface BodyValidationResult extends ValidationResultBase {
  content_quality_score: number;
  structural_integrity: boolean;
  routing_coverage_delta: number;
}

// Teacher-student config
export interface LlmRoleConfig {
  teacherAgent: string;
  studentAgent: string;
  teacherModelFlag?: string;
  studentModelFlag?: string;
}

// Token efficiency
export interface TokenUsageMetrics {
  sessions_with_skill: number;
  avg_tokens_with_skill: number;
  avg_tokens_baseline: number;
  efficiency_ratio: number; // baseline / with_skill; >1 = skill helps
}

// Baseline comparison
export interface BaselineResult {
  skill_name: string;
  eval_set_size: number;
  baseline_pass_rate: number;
  with_skill_pass_rate: number;
  lift: number;
  adds_value: boolean;
  measured_at: string;
}

// Skill unit tests
export type AssertionType = "output_contains" | "output_matches_regex" | "tool_called" | "trigger_check";

export interface SkillAssertion {
  type: AssertionType;
  value: string;
  description: string;
}

export interface SkillUnitTest {
  test_id: string;
  skill_name: string;
  description: string;
  query: string;
  expected_trigger: boolean;
  assertions: SkillAssertion[];
  tags?: string[];
  source?: "manual" | "skillsbench" | "generated";
}

export interface UnitTestResult {
  test_id: string;
  overall_passed: boolean;
  trigger_passed: boolean;
  assertion_results: Array<{ type: AssertionType; value: string; passed: boolean; evidence: string }>;
  duration_ms: number;
}

export interface UnitTestSuiteResult {
  skill_name: string;
  total: number;
  passed: number;
  failed: number;
  pass_rate: number;
  results: UnitTestResult[];
  ran_at: string;
}

// Composability
export interface CoOccurrencePair {
  skill_a: string;
  skill_b: string;
  co_occurrence_count: number;
  conflict_score: number;
  avg_errors_together: number;
  avg_errors_alone: number;
}

export interface ComposabilityReport {
  skill_name: string;
  analyzed_sessions: number;
  co_occurring_skills: CoOccurrencePair[];
  conflict_candidates: CoOccurrencePair[];
  generated_at: string;
}

// SkillsBench import
export interface SkillsBenchTask {
  task_id: string;
  original_file: string;
  description: string;
  queries: string[];
}
```

### 1e. Populate token data in transcript parser

**File:** `cli/selftune/utils/transcript.ts` (modify)
- Add `extractTokenUsage(transcriptPath): { input: number; output: number }` that sums `usage.input_tokens` and `usage.output_tokens` from Claude transcript JSONL entries
- Call from `parseTranscript()` to populate the existing optional `input_tokens`/`output_tokens` fields in `SessionTelemetryRecord`

### 1f. Update architecture linter

**File:** `lint-architecture.ts` (modify)
- Add `EVAL_FILES` set with new eval modules: `baseline.ts`, `composability.ts`, `unit-test.ts`, `import-skillsbench.ts`
- Add `EVAL_FORBIDDEN` list: same as `CONTRIBUTE_FORBIDDEN` (no hooks/ingestors/grading/evolution/monitoring imports)
- Add new evolution files to `EVOLUTION_FILES`: `propose-routing.ts`, `propose-body.ts`, `validate-body.ts`, `validate-routing.ts`, `refine-body.ts`, `evolve-body.ts`

### 1g. Tests for foundation

- `tests/utils/trigger-check.test.ts` — verify extracted functions still work
- `tests/evolution/deploy-proposal.test.ts` — add tests for `parseSkillSections()`, `replaceSection()`, `replaceBody()`
- Update existing tests that import from `validate-proposal.ts` if import paths changed

---

## Workstream 2: Full Skill Body Evolution (Agent `body-evolve`) — Recs 1, 6, 8

**Depends on:** Workstream 1 completion

### 2a. Routing table proposal generation

**File:** `cli/selftune/evolution/propose-routing.ts` (new)
- `ROUTING_PROPOSER_SYSTEM` prompt instructing LLM to optimize the `## Workflow Routing` table
- `buildRoutingProposalPrompt(currentRouting, fullSkillContent, failurePatterns, missedQueries, skillName)`
- `generateRoutingProposal()` → `BodyEvolutionProposal` with `evolution_target: "routing_table"`

### 2b. Routing table validation

**File:** `cli/selftune/evolution/validate-routing.ts` (new)
- Reuses `buildTriggerCheckPrompt` from `utils/trigger-check.ts` but passes routing table as context
- Structural check: valid markdown table syntax with `| Trigger | Workflow |` columns
- Same before/after comparison as `validateProposal()` → `BodyValidationResult`

### 2c. Full body proposal generation (upskill port)

**File:** `cli/selftune/evolution/propose-body.ts` (new)
- `BODY_GENERATOR_SYSTEM` — teacher LLM generates entire SKILL.md body
- `buildBodyGenerationPrompt(currentContent, failurePatterns, missedQueries, skillName, fewShotExamples?)`
- `generateBodyProposal(currentContent, failurePatterns, missedQueries, skillName, skillPath, teacherAgent, modelFlag?)` → `BodyEvolutionProposal`

### 2d. Full body validation (3-gate)

**File:** `cli/selftune/evolution/validate-body.ts` (new)
- **Gate 1 (structural):** Pure code — YAML frontmatter present, `# Title` exists, `## Workflow Routing` preserved if original had it. No LLM.
- **Gate 2 (trigger accuracy):** Student model YES/NO per eval entry on extracted description. Reuses `buildTriggerCheckPrompt` from shared utils.
- **Gate 3 (quality):** Student model rates body clarity/completeness 0.0-1.0.
- All three gates return `BodyValidationResult`

### 2e. Body refinement (upskill refine loop port)

**File:** `cli/selftune/evolution/refine-body.ts` (new)
- `BODY_REFINER_SYSTEM` — takes failure feedback, asks teacher to revise specific sections
- `refineBodyProposal(currentProposal, failureFeedback, validationFailures, qualityScore, teacherAgent, modelFlag?)` → `BodyEvolutionProposal`

### 2f. Body evolution orchestrator

**File:** `cli/selftune/evolution/evolve-body.ts` (new)
- `EvolveBodyDeps` interface (dependency injection matching `evolve.ts` pattern)
- `EvolveBodyOptions` with `target`, `teacherAgent`, `studentAgent`, `taskDescription`, `fewShotPaths`
- Orchestrator loop:
  1. `parseSkillSections()` → current state
  2. Build eval set (reuse `buildEvalSet()`)
  3. `extractFailurePatterns()` (reuse existing)
  4. Teacher generates proposal (routing or body depending on target)
  5. Gate 1: structural check (no LLM, fast)
  6. Gate 2: student trigger accuracy check
  7. Gate 3: student quality score (full_body only)
  8. If any gate fails: `refineBodyProposal()` with feedback, retry up to `maxIterations`
  9. Deploy: `replaceSection()` for routing, `replaceBody()` for full_body
  10. Backup + audit + memory update (audit entry includes `eval_snapshot` for rollback tracing)

### 2g. CLI command routing

**File:** `cli/selftune/index.ts` (modify)
- Add `case "evolve-body"` routing to `evolve-body.ts`
- Flags: `--skill`, `--skill-path`, `--target routing_table|full_body`, `--teacher-agent`, `--student-agent`, `--teacher-model`, `--student-model`, `--dry-run`, `--task-description`, `--few-shot`

### 2h. Tests

- `tests/evolution/propose-routing.test.ts`
- `tests/evolution/validate-routing.test.ts`
- `tests/evolution/propose-body.test.ts`
- `tests/evolution/validate-body.test.ts`
- `tests/evolution/refine-body.test.ts`
- `tests/evolution/evolve-body.test.ts` (run isolated like `evolve.test.ts`)

---

## Workstream 3: Baseline Comparison (Agent `baseline`) — Recs 2, 9

**Depends on:** Workstream 1 (trigger-check extraction + types)

### 3a. Baseline measurement module

**File:** `cli/selftune/eval/baseline.ts` (new)
- `measureBaseline(evalSet, skillDescription, agent)` → `BaselineResult`
- Runs trigger check against EMPTY string description (no-skill baseline)
- Runs trigger check against current description (with-skill)
- Computes `lift = with_skill_pass_rate - baseline_pass_rate`
- `adds_value = lift >= 0.05`
- Uses `buildTriggerCheckPrompt` from `utils/trigger-check.ts` (shared tier — no arch violation)

### 3b. Wire baseline into evolve command

**File:** `cli/selftune/evolution/evolve.ts` (modify)
- Add `--with-baseline` flag
- When enabled: call `measureBaseline()` before deploying
- Gate deployment on `lift > 0.05` — if skill doesn't add value over no-skill, don't evolve it
- Log `BaselineResult` to audit trail

### 3c. Standalone baseline CLI command

**File:** `cli/selftune/index.ts` (modify)
- Add `case "baseline"` routing
- `selftune baseline --skill <name> --skill-path <path> [--agent claude]`

### 3d. Tests

- `tests/eval/baseline.test.ts` — mock callLlm, verify lift computation with various pass rate scenarios

---

## Workstream 4: Token Efficiency + Pareto Expansion (Agent `token-pareto`) — Rec 3

**Depends on:** Workstream 1 (token data population + types)

### 4a. Token efficiency scoring

**File:** `cli/selftune/evolution/pareto.ts` (modify)
- Add `computeTokenEfficiencyScore(skillName, telemetry: SessionTelemetryRecord[]): number`
  - Finds sessions WITH skill (skill in `skills_triggered[]`) vs without
  - Computes avg total tokens for each group
  - Returns `clamp(baseline_avg / with_skill_avg, 0, 1)` — >0.5 means skill is efficient
- Add `TokenUsageMetrics` computation

### 4b. Extend Pareto dominance to 5 dimensions

**File:** `cli/selftune/evolution/pareto.ts` (modify)
- Extend `dominates()` to accept optional `token_efficiency_score` on candidates
- When present, adds a 5th dimension to Pareto comparison
- `computeParetoFrontier()` uses it if available
- Backward compatible — if no token data, 4-dimensional comparison unchanged

### 4c. Wire into evolve orchestrator

**File:** `cli/selftune/evolution/evolve.ts` (modify)
- Add `--token-efficiency` flag
- When enabled and Pareto mode active: compute token efficiency per candidate, pass to Pareto functions
- Log token metrics in audit entry details

### 4d. Tests

- `tests/evolution/pareto.test.ts` — extend existing tests with token dimension cases
- New fixture data with `input_tokens`/`output_tokens` populated

---

## Workstream 5: Skill Unit Tests (Agent `unit-tests`) — Rec 5

**Depends on:** Workstream 1 (trigger-check extraction + types)

### 5a. Unit test runner

**File:** `cli/selftune/eval/unit-test.ts` (new)
- `loadUnitTests(testsPath: string): SkillUnitTest[]` — reads JSON file
- `runUnitTest(test, skillDescription, agent): UnitTestResult`
  - `trigger_check` assertions: use `buildTriggerCheckPrompt` from shared utils + `callLlm`
  - `output_contains` assertions: run query through agent, check transcript for value
  - `tool_called` assertions: run query, check transcript for tool usage
- `runUnitTestSuite(tests, skillDescription, agent): UnitTestSuiteResult`
- Deterministic tests (trigger_check) are cheap; agent-run tests gated behind `--run-agent` flag

### 5b. Unit test generator

**File:** `cli/selftune/eval/generate-unit-tests.ts` (new)
- `generateUnitTests(skillName, skillPath, evalSet, agent): SkillUnitTest[]`
- LLM generates test cases from skill content + eval failures (upskill pattern)
- Few-shot prompt with example test cases
- Output stored as `~/.selftune/unit-tests/<skillName>.json`

### 5c. CLI command

**File:** `cli/selftune/index.ts` (modify)
- `selftune unit-test --skill <name> --tests <path> [--run-agent] [--generate]`
- `--generate` flag creates tests from skill content; without it, runs existing tests

### 5d. Tests

- `tests/eval/unit-test.test.ts` — mock agent, verify assertion logic
- `tests/eval/generate-unit-tests.test.ts` — mock LLM, verify test generation

---

## Workstream 6: Composability Analysis (Agent `composability`) — Rec 7

**Depends on:** Workstream 1 (types only)

### 6a. Composability analyzer

**File:** `cli/selftune/eval/composability.ts` (new)
- `analyzeComposability(skillName, telemetry: SessionTelemetryRecord[], window?): ComposabilityReport`
  - Filter sessions where `skills_triggered` includes `skillName`
  - For each co-occurring skill: compute avg `errors_encountered` with both vs alone
  - `conflict_score = clamp((errors_together - errors_alone) / (errors_alone + 1), 0, 1)`
  - Flag pairs with `conflict_score > 0.3` as conflict candidates
- Pure function — reads from `SessionTelemetryRecord[]` array, no I/O

### 6b. CLI command

**File:** `cli/selftune/index.ts` (modify)
- `selftune composability --skill <name> [--window N]`
- Reads `session_telemetry_log.jsonl`, calls `analyzeComposability()`, prints report

### 6c. Tests

- `tests/eval/composability.test.ts` — deterministic fixtures with known co-occurrence patterns

---

## Workstream 7: SkillsBench Importer (Agent `skillsbench`) — Rec 10

**Depends on:** Workstream 1 (types only)

### 7a. SkillsBench task parser

**File:** `cli/selftune/eval/import-skillsbench.ts` (new)
- `parseSkillsBenchDir(dirPath: string): SkillsBenchTask[]`
  - Reads `tasks/*/instruction.md` files
  - Extracts task description as query candidates
  - Reads `task.toml` for metadata (difficulty, category, tags)
- `convertToEvalEntries(tasks, targetSkill, matchStrategy): EvalEntry[]`
  - Maps task descriptions to `EvalEntry` format
  - `matchStrategy: "exact" | "fuzzy"` — exact matches on skill name in task metadata, fuzzy uses keyword overlap

### 7b. CLI command

**File:** `cli/selftune/index.ts` (modify)
- `selftune import-skillsbench --dir <path> --skill <name> --output <path> [--match-strategy exact|fuzzy]`

### 7c. Tests

- `tests/eval/import-skillsbench.test.ts` — fixture `instruction.md` + `task.toml` files

---

## Execution Order

```text
Phase 1 (sequential):
  Agent 1: foundation     ← must complete first

Phase 2 (all parallel):
  Agent 2: body-evolve    ← largest workstream
  Agent 3: baseline
  Agent 4: token-pareto
  Agent 5: unit-tests
  Agent 6: composability
  Agent 7: skillsbench
```

---

## New Files Summary

| File | Workstream | Purpose |
|------|-----------|---------|
| `cli/selftune/utils/trigger-check.ts` | 1 | Shared trigger-check prompts |
| `cli/selftune/evolution/propose-routing.ts` | 2 | Routing table proposal LLM |
| `cli/selftune/evolution/validate-routing.ts` | 2 | Routing table validation |
| `cli/selftune/evolution/propose-body.ts` | 2 | Full body generation (teacher) |
| `cli/selftune/evolution/validate-body.ts` | 2 | 3-gate body validation (student) |
| `cli/selftune/evolution/refine-body.ts` | 2 | Iterative body refinement |
| `cli/selftune/evolution/evolve-body.ts` | 2 | Body evolution orchestrator |
| `cli/selftune/eval/baseline.ts` | 3 | No-skill baseline comparison |
| `cli/selftune/eval/unit-test.ts` | 5 | Skill unit test runner |
| `cli/selftune/eval/generate-unit-tests.ts` | 5 | Unit test auto-generation |
| `cli/selftune/eval/composability.ts` | 6 | Multi-skill conflict detection |
| `cli/selftune/eval/import-skillsbench.ts` | 7 | SkillsBench corpus importer |

## Modified Files Summary

| File | Workstream | Changes |
|------|-----------|---------|
| `cli/selftune/types.ts` | 1 | All new interfaces |
| `cli/selftune/utils/llm-call.ts` | 1 | `modelFlag` parameter |
| `cli/selftune/utils/transcript.ts` | 1 | Token extraction |
| `cli/selftune/evolution/deploy-proposal.ts` | 1 | `parseSkillSections`, `replaceSection`, `replaceBody` |
| `cli/selftune/evolution/validate-proposal.ts` | 1 | Extract trigger-check to shared util |
| `cli/selftune/evolution/pareto.ts` | 4 | Token efficiency dimension |
| `cli/selftune/evolution/evolve.ts` | 3, 4 | `--with-baseline`, `--token-efficiency` flags |
| `cli/selftune/index.ts` | All | 5 new command routes |
| `lint-architecture.ts` | 1 | Add `EVAL_FILES` + new evolution files |

---

## Verification

After all agents complete:

1. **Lint check:** `make lint` — architecture linter passes with all new files registered
2. **Unit tests:** `make test` — all existing + new tests pass
3. **Sandbox (Layer 1):** `make sandbox` — read-only CLI smoke test still passes
4. **Manual smoke test for each new command:**
   - `selftune baseline --skill Research --skill-path ~/.claude/skills/Research/SKILL.md`
   - `selftune unit-test --skill Research --generate`
   - `selftune composability --skill Research`
   - `selftune evolve-body --skill Research --skill-path ~/.claude/skills/Research/SKILL.md --target routing_table --dry-run`
   - `selftune evolve --with-baseline --skill Research --skill-path ~/.claude/skills/Research/SKILL.md --dry-run`
5. **Integration test:** Run full `evolve-body --target full_body --dry-run` against a real skill — verify 3-gate validation produces reasonable scores
