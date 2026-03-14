# Execution Plan: Grader Prompt and Agent Evals

<!-- Verified: 2026-03-14 -->

**Status:** Deferred  
**Created:** 2026-03-14  
**Goal:** Evaluate and improve the grader prompts and grading agents so selftune’s session/skill judgments are trustworthy, stable, and measurable.

---

## Problem Statement

selftune relies on grading to decide:

- whether a session succeeded
- whether a skill was valuable
- whether evolution helped
- whether monitoring signals are believable

That makes grader quality a core product dependency.

Current risks:

- grader prompts may be too brittle or too noisy
- agent/runtime choice may affect grading consistency
- we do not yet have a tight eval loop for the graders themselves
- users can lose trust quickly if the grader feels arbitrary

## Priority Note

This remains important, but it is not the shortest path to the next release. It should resume once:

- the local app/dashboard path is stable
- the orchestrated improvement loop is demoable end to end
- the published package proof is done

---

## Goals

1. Build a real eval loop for selftune’s grading prompts/agents.
2. Measure grader consistency and failure modes explicitly.
3. Improve prompt quality where graders are too noisy, too weak, or too inconsistent.
4. Separate “grading infrastructure exists” from “grading is trustworthy.”

---

## Scope

In scope:

- session grading prompts
- skill-level grading prompts/agents
- eval sets and fixtures for grader behavior
- comparison of grader outputs across representative examples

Out of scope:

- broad telemetry architecture changes
- cloud analytics work
- unrelated UI work

---

## Recommended Work

### 1. Define grader eval corpora

Build or curate examples for:

- clear passes
- clear failures
- ambiguous sessions
- noisy wrapper/system-polluted sessions
- skills that should obviously count vs should not count

### 2. Measure prompt behavior

Evaluate:

- consistency
- false positives
- false negatives
- susceptibility to polluted context

### 3. Compare prompt/agent variants

Where useful, compare:

- revised prompt variants
- different calling styles
- stricter vs broader grading criteria

### 4. Feed results back into product trust

Use the findings to improve:

- grading prompts
- grading docs
- orchestrator confidence
- monitoring credibility

---

## Deliverables

1. A grader-focused eval suite
2. Prompt revisions where justified
3. A short report on grader failure modes
4. Recommendations for how much trust product features should place in current grading

---

## Success Criteria

- Grader behavior becomes more measurable and explainable
- Prompt changes are backed by eval evidence, not intuition
- selftune’s “it works” claim becomes more credible because the grading layer is being tested directly
