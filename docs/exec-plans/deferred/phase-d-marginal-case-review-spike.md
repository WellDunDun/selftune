# Execution Plan: Phase D Marginal-Case Review Spike

<!-- Verified: 2026-03-18 -->

**Status:** Planned  
**Created:** 2026-03-18  
**Goal:** Define the minimum operator loop Daniel needs to review false positives, false negatives, and ambiguous trigger decisions from alpha users once Phase C upload data is live.

---

## Why This Exists

Ray’s office-hours guidance was clear:

- the point of alpha is data back to Daniel
- the signal is in false negatives, false positives, and marginal cases
- human thumbs up/down on borderline cases is where the learning loop gets sharper

Phase C gets the data upstream. Phase D defines how Daniel turns that data into learning instead of just storage.

This is a **spike**, not a polished product build.

The output of this plan is:

1. a concrete review data model
2. a concrete candidate-generation model
3. a minimum operator workflow
4. a low-conflict implementation split for later

---

## Scope

### In scope

- four-quadrant analysis model
- candidate-generation heuristics for likely FP/FN/marginal cases
- review-label schema
- minimum Daniel-only surface
- storage and query assumptions for reviewed cases

### Out of scope

- end-user-facing UI polish
- public-launch privacy redesign
- RLHF/training pipeline beyond storing labels cleanly
- automated judgment replacement for the human review step

---

## Core Product Decision

The first Phase D implementation should be **Daniel-only and review-first**.

That means:

- no attempt to build a general “community review product”
- no attempt to fully automate classification
- no need for a beautiful UX before the workflow is proven

The system only needs to answer:

1. which cases are worth Daniel’s attention?
2. how does Daniel label them quickly?
3. how do those labels feed future eval/evolution work?

---

## The Four-Quadrant Model

Every reviewed case should eventually be classifiable as one of:

| Expected           | Actual        | Outcome        |
| ------------------ | ------------- | -------------- |
| should trigger     | triggered     | true positive  |
| should trigger     | not triggered | false negative |
| should not trigger | triggered     | false positive |
| should not trigger | not triggered | true negative  |

In practice:

- true negatives will dominate volume
- true positives matter, but usually need less human review
- false negatives and false positives are the main learning signal
- ambiguous cases should be explicitly modeled rather than forced into certainty

---

## Candidate Types

The review system should surface three candidate buckets first:

### 1. Likely False Negatives

Queries where a skill probably should have triggered but did not.

Candidate sources:

- unmatched queries from local/remote telemetry
- prompt text that strongly resembles existing true positives
- prompt text that later led to manual skill usage or correction
- prompts near known eval positives but absent from invocation logs

### 2. Likely False Positives

Queries where a skill triggered but probably should not have.

Candidate sources:

- triggered skills followed by poor grading, low execution value, or user correction
- triggered skills followed by explicit “wrong skill” behavior
- over-broad routing collisions between multiple skills
- triggered skills on queries later labeled irrelevant by Daniel

### 3. Ambiguous / Marginal Cases

Cases where heuristics disagree or confidence is low.

These should be prioritized for manual review because they are the highest-value labeling surface.

Candidate sources:

- medium-confidence trigger decisions
- disagreement between heuristic detectors
- novel user phrasing with sparse historical neighbors
- cross-skill overlap where multiple skills could plausibly trigger

---

## Minimum Data Required From Phase C

Phase D assumes Phase C makes these available remotely:

- `user_id`
- `session_id`
- `occurred_at`
- `skill_name`
- `triggered`
- `invocation_mode`
- `query_text`
- `skill_scope`
- platform / agent metadata
- evolution outcome context where relevant

Helpful but not strictly required in v1:

- grading summary by session
- confidence scores
- active-skill overlap metrics
- operator-facing links back to local proposal/audit history

---

## Review Record Schema

The first implementation should store explicit review labels as their own record type.

Recommended shape:

```ts
interface MarginalCaseReview {
  review_id: string;
  user_id: string;
  session_id: string;
  occurred_at: string;
  skill_name: string | null;
  query_text: string;
  candidate_type: "likely_false_negative" | "likely_false_positive" | "marginal";
  predicted_quadrant: "tp" | "fp" | "fn" | "tn" | "unknown";
  reviewer_label: "tp" | "fp" | "fn" | "tn" | "unsure";
  reviewer_note?: string;
  reviewer_id: string;
  reviewed_at: string;
}
```

Important choices:

- `reviewer_label` should use the same four-quadrant vocabulary
- `unsure` is allowed
- the raw `query_text` should stay attached to the review record
- `skill_name` may be null for cross-skill review queues before Daniel chooses the intended skill

---

## Minimum Operator Workflow

The first useful loop should be:

1. generate a ranked queue of candidate cases
2. show Daniel one case at a time with enough context to judge it
3. let Daniel mark:
   - correct trigger
   - missed trigger
   - bad trigger
   - correct skip
   - unsure
4. optionally add a note
5. persist the label
6. feed those labels into later eval/evolution improvements

The first surface can be either:

- a CLI/TUI review flow, or
- a narrow dashboard operator panel

Recommendation:

- start with the cheapest surface that preserves context
- do not block on a polished dashboard workflow

---

## Ranking Heuristics For The Queue

The queue should not be chronological only. It should be scored.

Recommended initial ranking formula:

1. higher novelty first
2. higher ambiguity first
3. repeated query patterns across users first
4. cases near recent regressions first
5. cases tied to important/active skills first

Concrete signal ideas:

- semantic similarity to known positives with no trigger
- triggered skill followed by low-value session outcome
- repeated manual correction patterns
- low-confidence or conflicting routing outcomes
- recent deploys that changed trigger boundaries

---

## Where Labels Should Feed Back

Phase D should explicitly connect to later work:

### Eval generation

- reviewed false negatives become high-value positive eval examples
- reviewed false positives become high-value negative eval examples

### Routing/body evolution

- marginal labels help identify where descriptions are too broad or too narrow
- repeated notes can become structured failure feedback

### Operator analytics

- show reviewed-case volume over time
- show per-skill reviewed FP/FN patterns
- show whether review debt is growing or shrinking

---

## Minimum Implementation Split When Ready

When this spike turns into execution, split it like this:

1. **Candidate generation**
   - query/ranking logic
   - likely FP/FN candidate extraction
2. **Review persistence**
   - review-record schema
   - write/read APIs
3. **Operator surface**
   - CLI or dashboard review flow
4. **Feedback integration**
   - label export into eval/evolution inputs

Do not give one agent “the whole review loop” at once.

---

## Acceptance Criteria For Completing The Spike

This spike is done when:

- the candidate buckets are clearly defined
- the review record schema is decided
- the minimum operator workflow is chosen
- the ranking logic is concrete enough to implement
- the feedback path into future eval/evolution work is explicit

---

## Recommended Next Step After This Spike

Do **not** start full Phase D implementation until Phase C has at least one real uploaded user worth reviewing.

Once that exists, the first implementation ticket should be:

**“Build a Daniel-only ranked review queue for likely false negatives, likely false positives, and marginal cases, with persisted four-quadrant labels.”**
