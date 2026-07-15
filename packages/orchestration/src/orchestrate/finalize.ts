import type {
  OrchestrateRunReport,
  OrchestrateRunSkillAction,
} from "@selftune/runtime/dashboard-contract";
import { getDb } from "@selftune/runtime/localdb/db";
import { writeCronRunToDb, writeOrchestrateRunToDb } from "@selftune/runtime/localdb/direct-write";
import type { OrchestrateResult, SkillAction } from "../orchestrate.js";
import type { SkillStatus, StatusResult } from "@selftune/runtime/status";
import type { SyncResult } from "../sync.js";
import type { ImprovementSignalRecord } from "@selftune/runtime/types";
import type { WorkflowSkillProposal } from "@selftune/runtime/workflows/proposals";
import { markSignalsConsumed } from "./signals.js";

interface OrchestrateFinalTotals {
  totalSkills: number;
  evaluated: number;
  evolved: number;
  deployed: number;
  watched: number;
  skipped: number;
  autoGraded: number;
  packageSearched: number;
  packageImproved: number;
  freshlyWatchedSkills: string[];
}

export interface FinalizeOrchestrateRunInput {
  syncResult: SyncResult;
  statusResult: StatusResult;
  candidates: SkillAction[];
  workflowProposals: WorkflowSkillProposal[];
  dryRun: boolean;
  approvalMode: "auto" | "review";
  autoGradedCount: number;
  packageSearched: number;
  packageImproved: number;
  freshlyWatchedSkills: string[];
  pendingSignals: ImprovementSignalRecord[];
  elapsedMs: number;
}

function buildFinalTotals(
  skills: SkillStatus[],
  candidates: SkillAction[],
  autoGradedCount: number,
  packageSearched: number,
  packageImproved: number,
  freshlyWatchedSkills: string[],
): OrchestrateFinalTotals {
  return {
    totalSkills: skills.length,
    evaluated: candidates.filter((candidate) => candidate.action === "evolve").length,
    evolved: candidates.filter(
      (candidate) => candidate.action === "evolve" && candidate.evolveResult !== undefined,
    ).length,
    deployed: candidates.filter((candidate) => candidate.evolveResult?.deployed).length,
    watched:
      candidates.filter((candidate) => candidate.action === "watch").length +
      freshlyWatchedSkills.length,
    skipped: candidates.filter((candidate) => candidate.action === "skip").length,
    autoGraded: autoGradedCount,
    packageSearched,
    packageImproved,
    freshlyWatchedSkills,
  };
}

export function finalizeOrchestrateRun(input: FinalizeOrchestrateRunInput): OrchestrateResult {
  const {
    syncResult,
    statusResult,
    candidates,
    workflowProposals,
    dryRun,
    approvalMode,
    autoGradedCount,
    packageSearched,
    packageImproved,
    freshlyWatchedSkills,
    pendingSignals,
    elapsedMs,
  } = input;

  const finalTotals = buildFinalTotals(
    statusResult.skills,
    candidates,
    autoGradedCount,
    packageSearched,
    packageImproved,
    freshlyWatchedSkills,
  );

  const result: OrchestrateResult = {
    syncResult,
    statusResult,
    candidates,
    workflowProposals,
    summary: {
      ...finalTotals,
      dryRun,
      approvalMode,
      elapsedMs,
    },
  };

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (pendingSignals.length > 0) {
    markSignalsConsumed(pendingSignals, runId);
  }

  const runReport: OrchestrateRunReport = {
    run_id: runId,
    timestamp: new Date().toISOString(),
    elapsed_ms: result.summary.elapsedMs,
    dry_run: result.summary.dryRun,
    approval_mode: result.summary.approvalMode,
    total_skills: finalTotals.totalSkills,
    evaluated: finalTotals.evaluated,
    evolved: finalTotals.evolved,
    deployed: finalTotals.deployed,
    watched: finalTotals.watched,
    skipped: finalTotals.skipped,
    auto_graded: finalTotals.autoGraded,
    package_searched: finalTotals.packageSearched,
    package_improved: finalTotals.packageImproved,
    skill_actions: candidates.map(
      (candidate): OrchestrateRunSkillAction => ({
        skill: candidate.skill,
        action: candidate.action,
        reason: candidate.reason,
        deployed: candidate.evolveResult?.deployed,
        rolledBack: candidate.watchResult?.rolledBack,
        alert: candidate.watchResult?.alert,
        elapsed_ms: candidate.evolveResult?.elapsedMs,
        llm_calls: candidate.evolveResult?.llmCallCount,
      }),
    ),
  };

  try {
    writeOrchestrateRunToDb(runReport);
  } catch {
    /* fail-open */
  }

  const totalLlmCalls = candidates.reduce(
    (sum, candidate) => sum + (candidate.evolveResult?.llmCallCount ?? 0),
    0,
  );
  try {
    writeCronRunToDb(getDb(), {
      jobName: "orchestrate",
      startedAt: runReport.timestamp,
      elapsedMs: runReport.elapsed_ms,
      status: "success",
      metrics: {
        total_skills: finalTotals.totalSkills,
        evaluated: finalTotals.evaluated,
        evolved: finalTotals.evolved,
        deployed: finalTotals.deployed,
        watched: finalTotals.watched,
        skipped: finalTotals.skipped,
        dry_run: result.summary.dryRun,
        total_llm_calls: totalLlmCalls,
        auto_graded: finalTotals.autoGraded,
        workflow_skill_proposals: workflowProposals.length,
      },
    });
  } catch {
    /* fail-open */
  }

  return result;
}
