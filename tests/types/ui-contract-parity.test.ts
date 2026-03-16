/**
 * Compile-time parity guard between @selftune/ui types and dashboard-contract.
 *
 * If the canonical types in cli/selftune/dashboard-contract.ts diverge from
 * the re-declared types in packages/ui, this test will fail to compile.
 */

import { describe, expect, test } from "bun:test";

import type {
  EvalSnapshot as Canonical_EvalSnapshot,
  EvidenceEntry as Canonical_EvidenceEntry,
  EvolutionEntry as Canonical_EvolutionEntry,
  OrchestrateRunReport as Canonical_OrchestrateRunReport,
  OrchestrateRunSkillAction as Canonical_OrchestrateRunSkillAction,
  PendingProposal as Canonical_PendingProposal,
  UnmatchedQuery as Canonical_UnmatchedQuery,
} from "../../cli/selftune/dashboard-contract";

import type {
  EvalSnapshot,
  EvidenceEntry,
  EvolutionEntry,
  OrchestrateRunReport,
  OrchestrateRunSkillAction,
  PendingProposal,
  UnmatchedQuery,
} from "../../packages/ui/src/types";

// Assert mutual assignability — fails at compile time if fields diverge.
type AssertAssignable<T, U> = T extends U ? (U extends T ? true : false) : false;

// Each assertion must resolve to `true`. A `false` here means the types have drifted.
const _evalSnapshot: AssertAssignable<EvalSnapshot, Canonical_EvalSnapshot> = true;
const _evolutionEntry: AssertAssignable<EvolutionEntry, Canonical_EvolutionEntry> = true;
const _unmatchedQuery: AssertAssignable<UnmatchedQuery, Canonical_UnmatchedQuery> = true;
const _pendingProposal: AssertAssignable<PendingProposal, Canonical_PendingProposal> = true;
const _evidenceEntry: AssertAssignable<EvidenceEntry, Canonical_EvidenceEntry> = true;
const _orchestrateRunSkillAction: AssertAssignable<
  OrchestrateRunSkillAction,
  Canonical_OrchestrateRunSkillAction
> = true;
const _orchestrateRunReport: AssertAssignable<
  OrchestrateRunReport,
  Canonical_OrchestrateRunReport
> = true;

describe("@selftune/ui type parity with dashboard-contract", () => {
  test("types are mutually assignable (compile-time check)", () => {
    // If this file compiles, all type assertions above passed.
    expect(_evalSnapshot).toBe(true);
    expect(_evolutionEntry).toBe(true);
    expect(_unmatchedQuery).toBe(true);
    expect(_pendingProposal).toBe(true);
    expect(_evidenceEntry).toBe(true);
    expect(_orchestrateRunSkillAction).toBe(true);
    expect(_orchestrateRunReport).toBe(true);
  });
});
