/**
 * Compile-time parity guard between @selftune/ui types and dashboard-contract.
 *
 * If the canonical types in cli/selftune/dashboard-contract.ts diverge from
 * the re-declared types in this package, this file will produce a type error
 * at build time. Run `tsc --noEmit` to verify parity.
 */

import type {
  EvalSnapshot as Canonical_EvalSnapshot,
  EvidenceEntry as Canonical_EvidenceEntry,
  EvolutionEntry as Canonical_EvolutionEntry,
  OrchestrateRunReport as Canonical_OrchestrateRunReport,
  OrchestrateRunSkillAction as Canonical_OrchestrateRunSkillAction,
  PendingProposal as Canonical_PendingProposal,
  UnmatchedQuery as Canonical_UnmatchedQuery,
} from "../../../cli/selftune/dashboard-contract";

import type {
  EvalSnapshot,
  EvidenceEntry,
  EvolutionEntry,
  OrchestrateRunReport,
  OrchestrateRunSkillAction,
  PendingProposal,
  UnmatchedQuery,
} from "./types";

// Assert mutual assignability — fails at compile time if fields diverge.
type AssertAssignable<T, U> = T extends U ? U extends T ? true : false : false;

// Each assertion must resolve to `true`. A `false` here means the types have drifted.
const _evalSnapshot: AssertAssignable<EvalSnapshot, Canonical_EvalSnapshot> = true;
const _evolutionEntry: AssertAssignable<EvolutionEntry, Canonical_EvolutionEntry> = true;
const _unmatchedQuery: AssertAssignable<UnmatchedQuery, Canonical_UnmatchedQuery> = true;
const _pendingProposal: AssertAssignable<PendingProposal, Canonical_PendingProposal> = true;
const _evidenceEntry: AssertAssignable<EvidenceEntry, Canonical_EvidenceEntry> = true;
const _orchestrateRunSkillAction: AssertAssignable<OrchestrateRunSkillAction, Canonical_OrchestrateRunSkillAction> = true;
const _orchestrateRunReport: AssertAssignable<OrchestrateRunReport, Canonical_OrchestrateRunReport> = true;
