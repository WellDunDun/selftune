# Design Doc: Composability v2 — From Conflict Detection to Workflow Discovery

**Status:** Proposed
**Author:** Daniel Petro
**Date:** 2026-03-08
**Prerequisite for:** Workflow Support (see `workflow-support.md`)

---

## Problem

The current `eval composability` command only answers one question: "Do these skills conflict?" It computes a `conflict_score` based on error rate increases when skills co-occur. This is useful but limited.

Users need answers to three more questions:

1. "Do these skills work **better** together?" (synergy detection)
2. "Which skills are **always** used together?" (workflow candidates)
3. "In what **order** are they used?" (sequence detection)

## Current State

```typescript
// composability.ts — what exists today
analyzeComposability(skillName, telemetry, window?) → ComposabilityReport

interface ComposabilityReport {
  pairs: CoOccurrencePair[];
  total_sessions_analyzed: number;
  conflict_count: number;
  generated_at: string;
}

interface CoOccurrencePair {
  skill_a: string;
  skill_b: string;
  co_occurrence_count: number;
  conflict_detected: boolean;
  conflict_reason?: string;
}
```

Limitations:

- Only detects negatives (conflicts), never positives (synergies)
- Only analyzes pairs, not sequences of 3+
- No ordering information — treats {A, B} same as {B, A}
- No workflow candidate detection
- No frequency thresholds for suggestions

## Proposed Extension

### New Types

```typescript
/** Extended pair with synergy detection */
export interface CoOccurrencePairV2 extends CoOccurrencePair {
  /** Positive = skills work better together. Negative = conflict */
  synergy_score: number;
  /** Average errors when both skills used together */
  avg_errors_together: number;
  /** Baseline: max of each skill's solo error rate */
  avg_errors_alone: number;
  /** Is this pair a workflow candidate? (synergy > 0.3 AND count >= threshold) */
  workflow_candidate: boolean;
}

/** Ordered skill sequence detected from timestamps */
export interface SkillSequence {
  /** Ordered list of skills as they were invoked */
  skills: string[];
  /** How many sessions contained this exact ordered sequence */
  occurrence_count: number;
  /** Synergy score for the full sequence */
  synergy_score: number;
  /** Most common initiating query */
  representative_query: string;
  /** Consistency: % of co-occurrences that follow this exact order */
  sequence_consistency: number;
}

/** Extended report with synergy and sequence detection */
export interface ComposabilityReportV2 extends ComposabilityReport {
  pairs: CoOccurrencePairV2[];
  /** Ordered skill sequences detected from timestamp analysis */
  sequences: SkillSequence[];
  /** Pairs with synergy_score > 0.3 AND co_occurrence_count >= threshold */
  workflow_candidates: CoOccurrencePairV2[];
  /** Synergy count (positive pairs) */
  synergy_count: number;
}
```

### New Function: `analyzeComposabilityV2`

```typescript
/**
 * Extended composability analysis with synergy detection and sequence extraction.
 *
 * @param skillName  - The skill to analyze
 * @param telemetry  - Session telemetry records
 * @param usage      - Skill usage records (for timestamp-based ordering)
 * @param options    - Analysis options
 */
export function analyzeComposabilityV2(
  skillName: string,
  telemetry: SessionTelemetryRecord[],
  usage: SkillUsageRecord[],
  options?: {
    window?: number;
    minOccurrences?: number; // default: 3
  },
): ComposabilityReportV2;
```

### Synergy Score Computation

The existing `conflict_score` only captures negative interactions. The new `synergy_score` captures both directions:

```text
synergy_score = clamp(
  (avg_errors_alone - avg_errors_together) / (avg_errors_alone + 1),
  -1, 1
)

Positive synergy_score → skills work BETTER together
Negative synergy_score → skills CONFLICT (same as existing detection)
Near zero             → no interaction effect
```

Note: this is the **inverse** of `conflict_score`. A high conflict_score (bad) maps to a negative synergy_score. A high synergy_score (good) means fewer errors together than apart.

The existing `conflict_detected` field remains for backwards compatibility:

```typescript
conflict_detected = synergy_score < -0.3; // same threshold, just inverted
```

### Sequence Detection

Uses `skill_usage_log.jsonl` which has per-invocation timestamps:

```text
Algorithm:
1. Filter usage records for sessions containing the target skill
2. Group by session_id
3. Sort each group by timestamp (ascending)
4. Extract ordered skill name sequences
5. Count frequency of each unique sequence
6. Filter by minimum occurrence threshold
7. Compute synergy_score for each sequence
8. Compute sequence_consistency (how often this exact order appears
   vs other orderings of the same skills)
```

Example output:

```json
{
  "sequences": [
    {
      "skills": ["Copywriting", "MarketingAutomation", "SelfTuneBlog"],
      "occurrence_count": 12,
      "synergy_score": 0.72,
      "representative_query": "write and publish a blog post about X",
      "sequence_consistency": 0.92
    },
    {
      "skills": ["Research", "Content"],
      "occurrence_count": 8,
      "synergy_score": 0.45,
      "representative_query": "research and write about X",
      "sequence_consistency": 1.0
    }
  ]
}
```

### Workflow Candidate Detection

A pair or sequence is flagged as a `workflow_candidate` when:

```text
workflow_candidate = synergy_score > 0.3 AND occurrence_count >= minOccurrences
```

The `minOccurrences` threshold defaults to 3 and is configurable. This prevents noisy one-off co-occurrences from being suggested as workflows.

### Backwards Compatibility

The extension is **additive only**:

1. `CoOccurrencePairV2` extends `CoOccurrencePair` — all existing fields preserved
2. `ComposabilityReportV2` extends `ComposabilityReport` — all existing fields preserved
3. `conflict_detected` logic unchanged — same threshold, same computation
4. The existing `analyzeComposability()` function is NOT modified
5. New function `analyzeComposabilityV2()` is separate — requires the additional `usage` parameter

Existing tests continue to pass. The CLI `eval composability` command gains new output sections but existing output format is preserved.

### Updated CLI Output

```bash
selftune eval composability --skill Copywriting

Composability Report: Copywriting
Analyzed: 150 sessions | Window: all

Co-occurring Skills:
  Copywriting + SelfTuneBlog     (42 sessions)  synergy: +0.72  ✓ workflow candidate
  Copywriting + MarketingAuto    (38 sessions)  synergy: +0.55  ✓ workflow candidate
  Copywriting + Research         (15 sessions)  synergy: +0.21
  Copywriting + BuggySkill       ( 3 sessions)  synergy: -0.45  ⚠ conflict

Detected Sequences:
  1. Copywriting → MarketingAutomation → SelfTuneBlog  (12x, 92% consistent)
  2. Copywriting → SelfTuneBlog                        ( 8x, 100% consistent)
  3. Research → Copywriting → SelfTuneBlog             ( 5x, 80% consistent)

Workflow Candidates:
  • "Copywriting + SelfTuneBlog" — used together 42 times with 72% fewer errors
    → Run `selftune workflows save "Copywriting→SelfTuneBlog"` or `selftune workflows save 1` to codify

Conflicts:
  • "Copywriting + BuggySkill" — 45% more errors together (3 sessions)
```

### Updated Composability.md Workflow Doc

The workflow documentation for the `eval composability` command should be updated to reflect:

1. New `--min-occurrences` flag
2. Synergy score interpretation table:

| Synergy Score | Interpretation                                    |
| ------------- | ------------------------------------------------- |
| +0.6 to +1.0  | Strong synergy — skills work much better together |
| +0.3 to +0.6  | Moderate synergy — workflow candidate             |
| -0.1 to +0.3  | No significant interaction                        |
| -0.3 to -0.1  | Minor friction — monitor                          |
| -1.0 to -0.3  | Conflict — skills interfere                       |

3. New "Detected Sequences" section in output
4. New "Workflow Candidates" section with actionable suggestions
5. Link to `selftune workflows` command for workflow management

### Implementation Notes

- Pure function — no I/O, same pattern as existing `composability.ts`
- New function in same file or adjacent `composability-v2.ts`
- Reads from two existing log files: `session_telemetry_log.jsonl` + `skill_usage_log.jsonl`
- Zero new dependencies
- Sequence extraction is O(n log n) per session (sort by timestamp) — negligible cost

### Test Cases

1. **Synergy detection**: Two skills with lower error rate together → positive synergy_score
2. **Conflict preserved**: Two skills with higher error rate together → negative synergy_score, conflict_detected = true
3. **Sequence extraction**: Skills with timestamps [t1, t2, t3] → correct ordered sequence
4. **Workflow candidate**: Pair with synergy > 0.3 AND count >= 3 → workflow_candidate = true
5. **Threshold filtering**: Pair with count < minOccurrences → workflow_candidate = false
6. **Sequence consistency**: Same skills in different orders → separate sequences, consistency < 1.0
7. **Backwards compatibility**: V1 report fields unchanged in V2 output
