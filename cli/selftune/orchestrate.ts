/**
 * selftune orchestrate — Autonomous core loop: sync → status → evolve → watch.
 *
 * This is the single entry point for the closed-loop improvement cycle.
 * It chains existing modules (sync, status, evolve, watch) into one
 * coordinated run with explicit candidate selection and safety controls.
 *
 * Default behavior is autonomous for low-risk description evolution, with
 * explicit dry-run and review-required modes for human-in-the-loop operation.
 */

import type { UploadCycleSummary } from "./alpha-upload/index.js";
import type { EvolveOptions, EvolveResult } from "./evolution/evolve.js";
import { readGradingResultsForSkill } from "./grading/results.js";
import { getDb } from "./localdb/db.js";
import { writeCronRunToDb } from "./localdb/direct-write.js";
import type { WatchResult } from "./monitoring/watch.js";
import {
  buildOrchestrateJsonOutput,
  parseOrchestrateCliArgs,
  renderOrchestrateHelp,
} from "./orchestrate/cli.js";
import {
  autoGradeFreshDeploys,
  buildReplayValidationOptions,
  runEvolutionPhase,
  watchRecentDeploys,
} from "./orchestrate/execute.js";
import { finalizeOrchestrateRun } from "./orchestrate/finalize.js";
import { acquireLock, releaseLock } from "./orchestrate/locks.js";
import { runPostOrchestrateSideEffects } from "./orchestrate/post-run.js";
import {
  autoGradeTopUngraded,
  detectCrossSkillOverlap,
  prepareOrchestrateRun,
} from "./orchestrate/prepare.js";
import {
  DEFAULT_COOLDOWN_HOURS,
  MIN_CANDIDATE_EVIDENCE,
  selectCandidates,
} from "./orchestrate/plan.js";
import { formatOrchestrateReport } from "./orchestrate/report.js";
import { resolveOrchestrateRuntime } from "./orchestrate/runtime.js";
import { doctor } from "./observability.js";
import type { StatusResult } from "./status.js";
import { computeStatus } from "./status.js";
import type { SyncResult } from "./sync.js";
import { syncSources } from "./sync.js";
import type {
  AlphaIdentity,
  EvolutionAuditEntry,
  ImprovementSignalRecord,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "./types.js";
import { handleCLIError } from "./utils/cli-error.js";
import { detectLlmAgent } from "./utils/llm-call.js";
import {
  discoverWorkflowSkillProposals,
  persistWorkflowSkillProposal,
  type WorkflowSkillProposal,
} from "./workflows/proposals.js";

export { acquireLock, releaseLock } from "./orchestrate/locks.js";
export {
  DEFAULT_COOLDOWN_HOURS,
  MIN_CANDIDATE_EVIDENCE,
  selectCandidates,
} from "./orchestrate/plan.js";
export { autoGradeTopUngraded, detectCrossSkillOverlap } from "./orchestrate/prepare.js";
export { formatOrchestrateReport } from "./orchestrate/report.js";
export { groupSignalsBySkill, markSignalsConsumed } from "./orchestrate/signals.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestrateOptions {
  /** Run sync → status → evolve → watch without writing changes. */
  dryRun: boolean;
  /** Approval policy for low-risk description evolution. */
  approvalMode: "auto" | "review";
  /** Scope to a single skill by name. */
  skillFilter?: string;
  /** Cap the number of skills processed per run. */
  maxSkills: number;
  /** Hours to look back for recently-evolved skills to watch. */
  recentWindowHours: number;
  /** Force sync to rescan all sources. */
  syncForce: boolean;
  /** Max ungraded skills to auto-grade per run (default: 5). Set 0 to disable. */
  maxAutoGrade: number;
}

export interface SkillAction {
  skill: string;
  action: "evolve" | "watch" | "skip";
  reason: string;
  evolveResult?: EvolveResult;
  watchResult?: WatchResult;
}

/** Context for candidate selection beyond simple status checks. */
export interface CandidateContext {
  skillFilter?: string;
  maxSkills: number;
  auditEntries?: EvolutionAuditEntry[];
  /** Hours since last deploy before a skill can be re-evolved. */
  cooldownHours?: number;
  /** Skill name (lowercase) to improvement signal count. */
  signaledSkills?: Map<string, number>;
}

export interface OrchestrateResult {
  syncResult: SyncResult;
  statusResult: StatusResult;
  candidates: SkillAction[];
  workflowProposals: WorkflowSkillProposal[];
  uploadSummary?: UploadCycleSummary;
  contributionRelaySummary?: { attempted: number; sent: number; failed: number };
  summary: {
    totalSkills: number;
    evaluated: number;
    evolved: number;
    deployed: number;
    watched: number;
    skipped: number;
    autoGraded: number;
    freshlyWatchedSkills: string[];
    dryRun: boolean;
    approvalMode: "auto" | "review";
    elapsedMs: number;
  };
}

type AutonomousEvolveDefaults = Pick<
  EvolveOptions,
  | "paretoEnabled"
  | "candidateCount"
  | "tokenEfficiencyEnabled"
  | "withBaseline"
  | "validationModel"
  | "cheapLoop"
  | "gateModel"
  | "adaptiveGate"
  | "proposalModel"
>;

// Keep the autonomous loop aligned with the evolve CLI defaults so scheduled
// runs stay cheap by default and still get a stronger gate before deploy.
const AUTONOMOUS_EVOLVE_DEFAULTS: AutonomousEvolveDefaults = {
  paretoEnabled: true,
  candidateCount: 3,
  tokenEfficiencyEnabled: false,
  withBaseline: false,
  validationModel: "haiku",
  cheapLoop: true,
  gateModel: "sonnet",
  adaptiveGate: true,
  proposalModel: "haiku",
};

/**
 * Injectable dependencies for orchestrate(). Pass overrides in tests.
 */
export interface OrchestrateDeps {
  syncSources?: typeof syncSources;
  computeStatus?: typeof computeStatus;
  evolve?: typeof import("./evolution/evolve.js").evolve;
  watch?: typeof import("./monitoring/watch.js").watch;
  detectAgent?: typeof detectLlmAgent;
  doctor?: typeof doctor;
  readTelemetry?: () => SessionTelemetryRecord[];
  readSkillRecords?: () => SkillUsageRecord[];
  readQueryRecords?: () => QueryLogRecord[];
  readAuditEntries?: () => EvolutionAuditEntry[];
  resolveSkillPath?: (skillName: string) => string | undefined;
  readGradingResults?: (skillName: string) => ReturnType<typeof readGradingResultsForSkill>;
  readSignals?: () => ImprovementSignalRecord[];
  readAlphaIdentity?: () => AlphaIdentity | null;
  discoverWorkflowSkillProposals?: typeof discoverWorkflowSkillProposals;
  persistWorkflowSkillProposal?: typeof persistWorkflowSkillProposal;
  buildReplayOptions?: typeof buildReplayValidationOptions;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function orchestrate(
  options: OrchestrateOptions,
  deps: OrchestrateDeps = {},
): Promise<OrchestrateResult> {
  const startTime = Date.now();

  if (!acquireLock()) {
    // Another orchestrate run is in progress
    console.error("[orchestrate] Another run is in progress (lock held). Exiting.");
    return {
      syncResult: {
        since: null,
        dry_run: options.dryRun,
        sources: {
          claude: { available: false, scanned: 0, synced: 0, skipped: 0 },
          codex: { available: false, scanned: 0, synced: 0, skipped: 0 },
          opencode: { available: false, scanned: 0, synced: 0, skipped: 0 },
          openclaw: { available: false, scanned: 0, synced: 0, skipped: 0 },
          pi: { available: false, scanned: 0, synced: 0, skipped: 0 },
        },
        repair: {
          ran: false,
          repaired_sessions: 0,
          repaired_records: 0,
          codex_repaired_records: 0,
        },
        creator_contributions: {
          ran: false,
          eligible_skills: 0,
          built_signals: 0,
          staged_signals: 0,
        },
        timings: [],
        total_elapsed_ms: 0,
      },
      statusResult: {
        skills: [],
        unmatchedQueries: 0,
        pendingProposals: 0,
        lastSession: null,
        system: { healthy: true, pass: 0, fail: 0, warn: 0 },
      },
      candidates: [],
      workflowProposals: [],
      summary: {
        totalSkills: 0,
        evaluated: 0,
        evolved: 0,
        deployed: 0,
        watched: 0,
        skipped: 0,
        autoGraded: 0,
        freshlyWatchedSkills: [],
        dryRun: options.dryRun,
        approvalMode: options.approvalMode,
        elapsedMs: 0,
      },
    };
  }

  try {
    const runtime = await resolveOrchestrateRuntime(deps);
    const {
      syncResult,
      statusResult,
      telemetry,
      skillRecords,
      pendingSignals,
      candidates,
      evolveCandidates,
      agent,
      autoGradedCount,
    } = await prepareOrchestrateRun(options, runtime);

    // -------------------------------------------------------------------------
    // Step 5: Evolve candidates
    // -------------------------------------------------------------------------
    const freshlyDeployedInThisRun = await runEvolutionPhase({
      evolveCandidates,
      agent,
      options,
      resolveSkillPath: runtime.resolveSkillPath,
      readGradingResults: runtime.readGradingResults,
      evolve: runtime.evolve,
      buildReplayOptions: runtime.buildReplayOptions,
      evolveDefaults: AUTONOMOUS_EVOLVE_DEFAULTS,
    });

    // -------------------------------------------------------------------------
    // Step 5b: Auto-grade & write baselines for freshly deployed skills
    // -------------------------------------------------------------------------
    await autoGradeFreshDeploys({
      freshlyDeployedCandidates: freshlyDeployedInThisRun,
      dryRun: options.dryRun,
      agent,
      detectAgent: runtime.detectAgent,
      readTelemetry: runtime.readTelemetry,
      readSkillRecords: runtime.readSkillRecords,
    });

    // -------------------------------------------------------------------------
    // Step 6: Watch recently evolved skills (including freshly deployed in this run)
    // -------------------------------------------------------------------------
    const { freshAuditEntries, freshlyWatchedSkills } = await watchRecentDeploys({
      candidates,
      freshlyDeployedCandidates: freshlyDeployedInThisRun,
      skillFilter: options.skillFilter,
      recentWindowHours: options.recentWindowHours,
      readAuditEntries: runtime.readAuditEntries,
      resolveSkillPath: runtime.resolveSkillPath,
      watch: runtime.watch,
    });

    // -------------------------------------------------------------------------
    // Step 6b: Generate workflow-skill proposals from strong telemetry patterns
    // -------------------------------------------------------------------------
    const workflowProposals = runtime.discoverWorkflowSkillProposals(telemetry, skillRecords, {
      cwd: process.cwd(),
      skillFilter: options.skillFilter,
      resolveSkillPath: runtime.resolveSkillPath,
      existingAuditEntries: freshAuditEntries,
    });

    if (workflowProposals.length > 0) {
      console.error(
        `[orchestrate] Workflow skill proposals: ${workflowProposals.length}${options.dryRun ? " (dry-run)" : ""}`,
      );
      for (const proposal of workflowProposals) {
        console.error(`  + ${proposal.draft.skill_name}: ${proposal.summary}`);
        if (!options.dryRun) {
          runtime.persistWorkflowSkillProposal(proposal, {
            sourceSkillPath: runtime.resolveSkillPath(proposal.source_skill_name),
          });
        }
      }
    }

    // -------------------------------------------------------------------------
    // Step 7: Build summary (single source of truth for both CLI and dashboard)
    // -------------------------------------------------------------------------
    const result = finalizeOrchestrateRun({
      syncResult,
      statusResult,
      candidates,
      workflowProposals,
      dryRun: options.dryRun,
      approvalMode: options.approvalMode,
      autoGradedCount,
      freshlyWatchedSkills,
      pendingSignals,
      elapsedMs: Date.now() - startTime,
    });

    await runPostOrchestrateSideEffects({
      result,
      dryRun: options.dryRun,
      readAlphaIdentity: runtime.readAlphaIdentity,
    });

    return result;
  } catch (err) {
    // Log failed orchestrate run to unified cron_runs timeline
    const elapsedMs = Date.now() - startTime;
    try {
      writeCronRunToDb(getDb(), {
        jobName: "orchestrate",
        startedAt: new Date(startTime).toISOString(),
        elapsedMs,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* fail-open */
    }
    throw err;
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const cli = parseOrchestrateCliArgs();

  if (cli.showHelp) {
    console.log(renderOrchestrateHelp());
    process.exit(0);
  }

  for (const warning of cli.warnings) {
    console.error(warning);
  }

  const isLoop = cli.loop;
  let stopRequested = false;
  let sleepTimer: ReturnType<typeof setTimeout> | null = null;
  let sleepResolve: (() => void) | null = null;

  if (isLoop) {
    const requestStop = () => {
      stopRequested = true;
      if (sleepTimer) {
        clearTimeout(sleepTimer);
        sleepTimer = null;
      }
      if (sleepResolve) {
        sleepResolve();
        sleepResolve = null;
      }
      console.error("\n[orchestrate] Loop interrupted. Finishing current cycle...");
    };
    process.on("SIGINT", requestStop);
    process.on("SIGTERM", requestStop);
  }

  let iteration = 0;
  do {
    iteration++;
    if (isLoop && iteration > 1) {
      console.error(`\n[orchestrate] === Loop iteration ${iteration} ===`);
    }

    const result = await orchestrate({
      ...cli.runOptions,
    });

    console.log(JSON.stringify(buildOrchestrateJsonOutput(result), null, 2));

    // Print human-readable decision report to stderr
    console.error(`\n${formatOrchestrateReport(result)}`);

    if (!isLoop || stopRequested) break;

    const nextMinutes = Math.round(cli.loopIntervalSeconds / 60);
    console.error(`\n[orchestrate] Next cycle in ${nextMinutes} minute(s)... (Ctrl+C to stop)`);
    await new Promise<void>((resolve) => {
      sleepResolve = resolve;
      sleepTimer = setTimeout(() => {
        sleepTimer = null;
        sleepResolve = null;
        resolve();
      }, cli.loopIntervalSeconds * 1000);
    });
  } while (isLoop && !stopRequested);

  process.exit(0);
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
