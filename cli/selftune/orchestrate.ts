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

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { readAlphaIdentity } from "./alpha-identity.js";
import type { UploadCycleSummary } from "./alpha-upload/index.js";
import { getOrchestrateLockPath, SELFTUNE_CONFIG_PATH } from "./constants.js";
import type { OrchestrateRunReport, OrchestrateRunSkillAction } from "./dashboard-contract.js";
import type { EvolveOptions, EvolveResult } from "./evolution/evolve.js";
import {
  buildDefaultGradingOutputPath,
  deriveExpectationsFromSkill,
  gradeSession,
  resolveLatestSessionForSkill,
} from "./grading/grade-session.js";
import { readGradingResultsForSkill } from "./grading/results.js";
import { getDb } from "./localdb/db.js";
import {
  updateSignalConsumed,
  writeCronRunToDb,
  writeGradingResultToDb,
  writeOrchestrateRunToDb,
} from "./localdb/direct-write.js";
import {
  queryEvolutionAudit,
  queryImprovementSignals,
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "./localdb/queries.js";
import type { WatchResult } from "./monitoring/watch.js";
import { doctor } from "./observability.js";
import type { SkillStatus, StatusResult } from "./status.js";
import { computeStatus } from "./status.js";
import type { SyncResult } from "./sync.js";
import { createDefaultSyncOptions, syncSources } from "./sync.js";
import type {
  AlphaIdentity,
  EvolutionAuditEntry,
  ImprovementSignalRecord,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "./types.js";
import { CLIError, handleCLIError } from "./utils/cli-error.js";
import { detectAgent } from "./utils/llm-call.js";
import { getSelftuneVersion, readConfiguredAgentType } from "./utils/selftune-meta.js";
import {
  findInstalledSkillPath,
  findRepositoryClaudeSkillDirs,
  findRepositorySkillDirs,
} from "./utils/skill-discovery.js";
import { readExcerpt } from "./utils/transcript.js";
import {
  discoverWorkflowSkillProposals,
  persistWorkflowSkillProposal,
  type WorkflowSkillProposal,
} from "./workflows/proposals.js";

// ---------------------------------------------------------------------------
// Lockfile management
// ---------------------------------------------------------------------------

interface LockInfo {
  pid: number;
  timestamp: string;
}

const LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

export function acquireLock(lockPath: string = getOrchestrateLockPath()): boolean {
  try {
    if (existsSync(lockPath)) {
      try {
        const raw = readFileSync(lockPath, "utf-8");
        const info: LockInfo = JSON.parse(raw);
        const lockAge = Date.now() - Date.parse(info.timestamp);
        if (lockAge < LOCK_STALE_MS) {
          return false; // lock is fresh, cannot acquire
        }
        // Lock is stale, fall through to overwrite
      } catch {
        // Corrupted lock file, treat as stale and overwrite
      }
    }
    const lock: LockInfo = { pid: process.pid, timestamp: new Date().toISOString() };
    writeFileSync(lockPath, JSON.stringify(lock));
    return true;
  } catch {
    // Fail-open: if we can't check/write, allow the run
    return true;
  }
}

export function releaseLock(lockPath: string = getOrchestrateLockPath()): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Silent on errors (file may not exist)
  }
}

// ---------------------------------------------------------------------------
// Signal reading helpers
// ---------------------------------------------------------------------------

function readPendingSignals(reader?: () => ImprovementSignalRecord[]): ImprovementSignalRecord[] {
  const _read =
    reader ??
    (() => {
      const db = getDb();
      return queryImprovementSignals(db, false) as ImprovementSignalRecord[];
    });
  try {
    return _read().filter((s) => !s.consumed);
  } catch {
    return [];
  }
}

export function groupSignalsBySkill(signals: ImprovementSignalRecord[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of signals) {
    if (s.mentioned_skill) {
      const key = s.mentioned_skill.toLowerCase();
      map.set(key, (map.get(key) ?? 0) + 1);
    }
  }
  return map;
}

export function markSignalsConsumed(signals: ImprovementSignalRecord[], runId: string): void {
  try {
    if (signals.length === 0) return;
    for (const signal of signals) {
      const ok = updateSignalConsumed(signal.session_id, signal.query, signal.signal_type, runId);
      if (!ok) {
        console.error(
          `[orchestrate] failed to mark signal consumed: session_id=${signal.session_id}, signal_type=${signal.signal_type}`,
        );
      }
    }
  } catch {
    // Silent on errors
  }
}

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
    dryRun: boolean;
    approvalMode: "auto" | "review";
    elapsedMs: number;
  };
}

// ---------------------------------------------------------------------------
// Human-readable decision report
// ---------------------------------------------------------------------------

function formatSyncPhase(syncResult: SyncResult): string[] {
  const lines: string[] = ["Phase 1: Sync"];
  const sources: [string, keyof SyncResult["sources"]][] = [
    ["Claude", "claude"],
    ["Codex", "codex"],
    ["OpenCode", "opencode"],
    ["OpenClaw", "openclaw"],
  ];

  for (const [label, key] of sources) {
    const s = syncResult.sources[key];
    if (!s.available) {
      lines.push(`  ${label.padEnd(12)}not available`);
    } else if (s.synced > 0) {
      lines.push(`  ${label.padEnd(12)}scanned ${s.scanned}, synced ${s.synced}`);
    } else {
      lines.push(`  ${label.padEnd(12)}scanned ${s.scanned}, up to date`);
    }
  }

  if (syncResult.repair.ran && syncResult.repair.repaired_records > 0) {
    lines.push(
      `  Repair      ${syncResult.repair.repaired_records} records across ${syncResult.repair.repaired_sessions} sessions`,
    );
  }

  return lines;
}

function formatStatusPhase(statusResult: StatusResult): string[] {
  const lines: string[] = ["Phase 2: Status"];
  const byStatus: Record<string, number> = {};
  for (const skill of statusResult.skills) {
    byStatus[skill.status] = (byStatus[skill.status] ?? 0) + 1;
  }
  const healthLabel = statusResult.system.healthy ? "healthy" : "UNHEALTHY";
  lines.push(`  ${statusResult.skills.length} skills found, system ${healthLabel}`);

  const parts: string[] = [];
  for (const s of ["CRITICAL", "WARNING", "HEALTHY", "UNGRADED", "UNKNOWN"]) {
    if (byStatus[s]) parts.push(`${byStatus[s]} ${s}`);
  }
  if (parts.length > 0) lines.push(`  ${parts.join(", ")}`);

  return lines;
}

function formatDecisionPhase(candidates: SkillAction[]): string[] {
  const lines: string[] = ["Phase 3: Skill Decisions"];
  if (candidates.length === 0) {
    lines.push("  (no skills to evaluate)");
    return lines;
  }

  for (const c of candidates) {
    const icon = c.action === "skip" ? "⊘" : c.action === "watch" ? "○" : "→";
    const actionLabel = c.action.toUpperCase().padEnd(7);
    lines.push(`  ${icon} ${c.skill.padEnd(20)} ${actionLabel} ${c.reason}`);
  }

  return lines;
}

function formatEvolutionPhase(candidates: SkillAction[]): string[] {
  const evolved = candidates.filter((c) => c.action === "evolve" && c.evolveResult !== undefined);
  if (evolved.length === 0) return [];

  const lines: string[] = ["Phase 4: Evolution Results"];
  for (const c of evolved) {
    const r = c.evolveResult as NonNullable<typeof c.evolveResult>;
    const status = r.deployed ? "deployed" : "not deployed";
    const detail = r.reason;
    const validation = r.validation
      ? ` (${(r.validation.before_pass_rate * 100).toFixed(0)}% → ${(r.validation.after_pass_rate * 100).toFixed(0)}%)`
      : "";
    lines.push(`  ${c.skill.padEnd(20)} ${status}${validation}`);
    lines.push(`  ${"".padEnd(20)} ${detail}`);
  }

  return lines;
}

function formatWatchPhase(candidates: SkillAction[]): string[] {
  const watched = candidates.filter((c) => c.action === "watch");
  if (watched.length === 0) return [];

  const lines: string[] = ["Phase 5: Watch"];
  for (const c of watched) {
    const snap = c.watchResult?.snapshot;
    const metrics = snap
      ? ` (pass_rate=${snap.pass_rate.toFixed(2)}, baseline=${snap.baseline_pass_rate.toFixed(2)})`
      : "";
    const alertTag = c.watchResult?.alert ? " [ALERT]" : "";
    const rollbackTag = c.watchResult?.rolledBack ? " [ROLLED BACK]" : "";
    lines.push(`  ${c.skill.padEnd(20)} ${c.reason}${alertTag}${rollbackTag}${metrics}`);
  }

  return lines;
}

function formatWorkflowProposalPhase(proposals: WorkflowSkillProposal[]): string[] {
  if (proposals.length === 0) return [];

  const lines: string[] = ["Phase 6: Workflow Skill Proposals"];
  for (const proposal of proposals) {
    lines.push(
      `  + ${proposal.source_skill_name.padEnd(20)} NEW_SKILL ${proposal.draft.skill_name} (${proposal.workflow.skills.join(" -> ")})`,
    );
    lines.push(`  ${"".padEnd(20)} ${proposal.summary}`);
  }
  return lines;
}

export function formatOrchestrateReport(result: OrchestrateResult): string {
  const sep = "═".repeat(48);
  const lines: string[] = [];

  lines.push(sep);
  lines.push("selftune orchestrate — decision report");
  lines.push(sep);
  lines.push("");

  // Mode banner
  if (result.summary.dryRun) {
    lines.push("Mode: DRY RUN (no mutations applied)");
  } else if (result.summary.approvalMode === "review") {
    lines.push("Mode: REVIEW (proposals validated but not deployed)");
  } else {
    lines.push("Mode: AUTONOMOUS (validated changes deployed automatically)");
  }
  lines.push("");

  // Phase 1: Sync
  lines.push(...formatSyncPhase(result.syncResult));
  lines.push("");

  // Phase 2: Status
  lines.push(...formatStatusPhase(result.statusResult));
  lines.push("");

  // Phase 3: Skill decisions
  lines.push(...formatDecisionPhase(result.candidates));
  lines.push("");

  // Phase 4: Evolution results (only if any evolve ran)
  const evoLines = formatEvolutionPhase(result.candidates);
  if (evoLines.length > 0) {
    lines.push(...evoLines);
    lines.push("");
  }

  // Phase 5: Watch (only if any watched)
  const watchLines = formatWatchPhase(result.candidates);
  if (watchLines.length > 0) {
    lines.push(...watchLines);
    lines.push("");
  }

  const workflowProposalLines = formatWorkflowProposalPhase(result.workflowProposals);
  if (workflowProposalLines.length > 0) {
    lines.push(...workflowProposalLines);
    lines.push("");
  }

  // Final summary
  lines.push("Summary");
  lines.push(`  Auto-graded:  ${result.summary.autoGraded}`);
  lines.push(`  Evaluated:    ${result.summary.evaluated} skills`);
  lines.push(`  Deployed:     ${result.summary.deployed}`);
  lines.push(`  Proposed:     ${result.workflowProposals.length} workflow skills`);
  lines.push(`  Watched:      ${result.summary.watched}`);
  lines.push(`  Skipped:      ${result.summary.skipped}`);
  lines.push(`  Elapsed:      ${(result.summary.elapsedMs / 1000).toFixed(1)}s`);

  if (result.summary.dryRun && result.summary.evaluated > 0) {
    lines.push("");
    lines.push("  Rerun without --dry-run to allow validated deployments.");
  } else if (result.summary.approvalMode === "review" && result.summary.evaluated > 0) {
    lines.push("");
    lines.push("  Rerun without --review-required to allow validated deployments.");
  }

  return lines.join("\n");
}

/** Candidate selection criteria. */
const CANDIDATE_STATUSES = new Set(["CRITICAL", "WARNING", "UNGRADED"]);

/** Minimum skill_checks before autonomous evolution is allowed. */
export const MIN_CANDIDATE_EVIDENCE = 3;

/** Default cooldown hours after a deploy before re-evolving the same skill. */
export const DEFAULT_COOLDOWN_HOURS = 24;

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

function candidatePriority(skill: SkillStatus, signalCount = 0): number {
  const statusWeight = skill.status === "CRITICAL" ? 300 : skill.status === "WARNING" ? 200 : 100;
  const missedWeight = Math.min(skill.missedQueries, 50);
  const passPenalty = skill.passRate === null ? 0 : Math.round((1 - skill.passRate) * 100);
  const trendBoost = skill.trend === "down" ? 30 : 0;
  const signalBoost = Math.min(signalCount * 150, 450);
  return statusWeight + missedWeight + passPenalty + trendBoost + signalBoost;
}

/**
 * Injectable dependencies for orchestrate(). Pass overrides in tests.
 */
export interface OrchestrateDeps {
  syncSources?: typeof syncSources;
  computeStatus?: typeof computeStatus;
  evolve?: typeof import("./evolution/evolve.js").evolve;
  watch?: typeof import("./monitoring/watch.js").watch;
  detectAgent?: typeof detectAgent;
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
}

// ---------------------------------------------------------------------------
// Skill path resolution
// ---------------------------------------------------------------------------

function getSkillSearchDirs(): string[] {
  const home = homedir();
  const cwd = process.cwd();
  return [
    join(home, ".claude", "skills"),
    join(home, ".agents", "skills"),
    join(home, ".codex", "skills"),
    ...findRepositorySkillDirs(cwd),
    ...findRepositoryClaudeSkillDirs(cwd),
  ];
}

function defaultResolveSkillPath(skillName: string): string | undefined {
  return findInstalledSkillPath(skillName, getSkillSearchDirs());
}

// ---------------------------------------------------------------------------
// Cross-skill eval set overlap detection (internal — exported for testing only)
// ---------------------------------------------------------------------------

/**
 * Detects significant overlap between the positive eval sets of evolution
 * candidates. When two skills share >30% of their positive queries, it
 * suggests a routing boundary problem. Console-only — no persistence.
 *
 * @internal Exported solely for unit testing.
 */
export async function detectCrossSkillOverlap(
  candidates: Array<{ skill: string }>,
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
): Promise<
  Array<{ skill_a: string; skill_b: string; overlap_pct: number; shared_queries: string[] }>
> {
  if (candidates.length < 2) return [];

  const { buildEvalSet } = await import("./eval/hooks-to-evals.js");

  const evalSets = new Map<string, Set<string>>();

  for (const c of candidates) {
    const evalSet = buildEvalSet(skillRecords, queryRecords, c.skill);
    const positives = new Set(
      evalSet
        .filter((e: { should_trigger: boolean }) => e.should_trigger)
        .map((e: { query: string }) => e.query.toLowerCase()),
    );
    evalSets.set(c.skill, positives);
  }

  const overlaps: Array<{
    skill_a: string;
    skill_b: string;
    overlap_pct: number;
    shared_queries: string[];
  }> = [];
  const skillNames = [...evalSets.keys()];

  for (let i = 0; i < skillNames.length; i++) {
    for (let j = i + 1; j < skillNames.length; j++) {
      const setA = evalSets.get(skillNames[i]);
      const setB = evalSets.get(skillNames[j]);
      if (!setA || !setB) continue;

      if (setA.size === 0 || setB.size === 0) continue;

      const shared: string[] = [];
      for (const q of setA) {
        if (setB.has(q)) shared.push(q);
      }

      const overlapPct = shared.length / Math.min(setA.size, setB.size);

      if (overlapPct > 0.3) {
        overlaps.push({
          skill_a: skillNames[i],
          skill_b: skillNames[j],
          overlap_pct: overlapPct,
          shared_queries: shared.slice(0, 10),
        });
      }
    }
  }

  return overlaps;
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

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

export function selectCandidates(skills: SkillStatus[], options: CandidateContext): SkillAction[] {
  const actions: SkillAction[] = [];
  const orderedSkills = [...skills].sort((a, b) => {
    const aSignals = options.signaledSkills?.get(a.name.toLowerCase()) ?? 0;
    const bSignals = options.signaledSkills?.get(b.name.toLowerCase()) ?? 0;
    return candidatePriority(b, bSignals) - candidatePriority(a, aSignals);
  });

  const cooldownHours = options.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
  const recentlyDeployed = findRecentlyDeployedSkills(options.auditEntries ?? [], cooldownHours);

  for (const skill of orderedSkills) {
    const signalCount = options.signaledSkills?.get(skill.name.toLowerCase()) ?? 0;

    // Apply skill filter
    if (options.skillFilter && skill.name !== options.skillFilter) {
      actions.push({
        skill: skill.name,
        action: "skip",
        reason: `filtered out (--skill ${options.skillFilter})`,
      });
      continue;
    }

    // Check if skill is a candidate
    if (!CANDIDATE_STATUSES.has(skill.status)) {
      actions.push({
        skill: skill.name,
        action: "skip",
        reason: `status=${skill.status} — no action needed`,
      });
      continue;
    }

    // Gate: cooldown — skip if this skill was deployed recently
    if (recentlyDeployed.has(skill.name)) {
      actions.push({
        skill: skill.name,
        action: "skip",
        reason: `recently evolved (cooldown ${cooldownHours}h) — let it bake`,
      });
      continue;
    }

    // Gate: insufficient evidence — need enough data points for autonomous action
    // Bypass if there are improvement signals for this skill
    const skillChecks = skill.snapshot?.skill_checks ?? 0;
    if (skillChecks < MIN_CANDIDATE_EVIDENCE && skill.status !== "UNGRADED" && signalCount === 0) {
      actions.push({
        skill: skill.name,
        action: "skip",
        reason: `insufficient evidence (${skillChecks}/${MIN_CANDIDATE_EVIDENCE} checks) — need more data`,
      });
      continue;
    }

    // UNGRADED: only evolve if there are missed queries (some signal)
    // Bypass if there are improvement signals for this skill
    if (skill.status === "UNGRADED" && skill.missedQueries === 0 && signalCount === 0) {
      actions.push({
        skill: skill.name,
        action: "skip",
        reason: "UNGRADED with 0 missed queries — insufficient signal",
      });
      continue;
    }

    // Gate: weak WARNING signal — skip if no missed queries and trend isn't declining
    if (skill.status === "WARNING" && skill.missedQueries === 0 && skill.trend !== "down") {
      actions.push({
        skill: skill.name,
        action: "skip",
        reason: `WARNING but no missed queries and trend=${skill.trend} — weak signal`,
      });
      continue;
    }

    actions.push({
      skill: skill.name,
      action: "evolve",
      reason: `status=${skill.status}, passRate=${skill.passRate !== null ? `${(skill.passRate * 100).toFixed(0)}%` : "—"}, missed=${skill.missedQueries}, trend=${skill.trend}`,
    });
  }

  // Apply max-skills cap to evolve candidates only
  let evolveCount = 0;
  for (const action of actions) {
    if (action.action === "evolve") {
      evolveCount++;
      if (evolveCount > options.maxSkills) {
        action.action = "skip";
        action.reason = `capped by --max-skills ${options.maxSkills}`;
      }
    }
  }

  return actions;
}

/**
 * Find skills deployed within the given window.
 * Used for both cooldown gating (don't re-evolve) and watch targeting
 * (monitor recently deployed skills for regressions).
 */
function findRecentlyDeployedSkills(
  auditEntries: EvolutionAuditEntry[],
  windowHours: number,
): Set<string> {
  const cutoffMs = Date.now() - windowHours * 60 * 60 * 1000;
  const names = new Set<string>();
  for (const entry of auditEntries) {
    const deployedAtMs = Date.parse(entry.timestamp);
    if (
      entry.action === "deployed" &&
      entry.skill_name &&
      Number.isFinite(deployedAtMs) &&
      deployedAtMs >= cutoffMs
    ) {
      names.add(entry.skill_name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Auto-grade ungraded skills
// ---------------------------------------------------------------------------

/**
 * Auto-grade the top ungraded skills that have some session data.
 * Fail-open: individual grading errors are logged but never propagated.
 *
 * @returns Number of skills successfully graded.
 */
export async function autoGradeTopUngraded(
  skills: SkillStatus[],
  maxAutoGrade: number,
  agent: string,
  deps: {
    readTelemetry: () => SessionTelemetryRecord[];
    readSkillRecords: () => SkillUsageRecord[];
  },
): Promise<number> {
  // Filter: UNGRADED skills with some data (skill_checks > 0)
  const ungradedWithData = skills
    .filter((s) => s.status === "UNGRADED" && (s.snapshot?.skill_checks ?? 0) > 0)
    .sort((a, b) => (b.snapshot?.skill_checks ?? 0) - (a.snapshot?.skill_checks ?? 0))
    .slice(0, maxAutoGrade);

  if (ungradedWithData.length === 0) return 0;

  let graded = 0;

  for (const skill of ungradedWithData) {
    try {
      const telemetry = deps.readTelemetry();
      const skillUsage = deps.readSkillRecords();

      // Resolve the latest session for this skill
      const resolved = resolveLatestSessionForSkill(telemetry, skillUsage, skill.name);
      if (!resolved) {
        console.error(`  [auto-grade] ${skill.name}: no session found, skipping`);
        continue;
      }

      // Derive expectations from SKILL.md
      const derived = deriveExpectationsFromSkill(skill.name);
      let transcriptExcerpt = "(no transcript)";
      if (resolved.transcriptPath) {
        try {
          transcriptExcerpt = readExcerpt(resolved.transcriptPath);
        } catch {
          transcriptExcerpt = "(no transcript)";
        }
      }

      console.error(`  [auto-grade] Grading "${skill.name}" (session ${resolved.sessionId})...`);

      const result = await gradeSession({
        expectations: derived.expectations,
        telemetry: resolved.telemetry,
        sessionId: resolved.sessionId,
        skillName: skill.name,
        transcriptExcerpt,
        transcriptPath: resolved.transcriptPath,
        agent,
      });

      // Persist to SQLite — only count as graded if DB write succeeds
      let persisted = false;
      try {
        persisted = writeGradingResultToDb(result);
      } catch {
        persisted = false;
      }
      if (!persisted) {
        console.error(`  [auto-grade] ${skill.name}: graded but failed to persist result`);
        continue;
      }

      // Persist to file (fail-open, supplementary)
      try {
        const basePath = buildDefaultGradingOutputPath(resolved.sessionId);
        const safeName = skill.name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const outputPath = basePath.replace(/\.json$/, `_${safeName}.json`);
        const outputDir = dirname(outputPath);
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
      } catch {
        // fail-open: DB is authoritative, file is supplementary
      }

      const passRate = result.summary.pass_rate;
      console.error(
        `  [auto-grade] ${skill.name}: ${result.summary.passed}/${result.summary.total} passed (${Math.round(passRate * 100)}%)`,
      );
      graded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `  [auto-grade] ${skill.name}: error — ${msg}. Retry with: selftune grade ${skill.name}`,
      );
      // fail-open: continue to next skill
    }
  }

  return graded;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function orchestrate(
  options: OrchestrateOptions,
  deps: OrchestrateDeps = {},
): Promise<OrchestrateResult> {
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
        },
        repair: {
          ran: false,
          repaired_sessions: 0,
          repaired_records: 0,
          codex_repaired_records: 0,
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
        dryRun: options.dryRun,
        approvalMode: options.approvalMode,
        elapsedMs: 0,
      },
    };
  }

  try {
    const startTime = Date.now();

    const _syncSources = deps.syncSources ?? syncSources;
    const _computeStatus = deps.computeStatus ?? computeStatus;
    const _detectAgent = deps.detectAgent ?? detectAgent;
    const _doctor = deps.doctor ?? doctor;
    const _readTelemetry =
      deps.readTelemetry ??
      (() => {
        const db = getDb();
        return querySessionTelemetry(db) as SessionTelemetryRecord[];
      });
    const _readSkillRecords =
      deps.readSkillRecords ??
      (() => {
        const db = getDb();
        return querySkillUsageRecords(db) as SkillUsageRecord[];
      });
    const _readQueryRecords =
      deps.readQueryRecords ??
      (() => {
        const db = getDb();
        return queryQueryLog(db) as QueryLogRecord[];
      });
    const _readAuditEntries =
      deps.readAuditEntries ??
      (() => {
        const db = getDb();
        return queryEvolutionAudit(db) as EvolutionAuditEntry[];
      });
    const _resolveSkillPath = deps.resolveSkillPath ?? defaultResolveSkillPath;
    const _readGradingResults = deps.readGradingResults ?? readGradingResultsForSkill;
    const _readAlphaIdentity =
      deps.readAlphaIdentity ?? (() => readAlphaIdentity(SELFTUNE_CONFIG_PATH));
    const _discoverWorkflowSkillProposals =
      deps.discoverWorkflowSkillProposals ?? discoverWorkflowSkillProposals;
    const _persistWorkflowSkillProposal =
      deps.persistWorkflowSkillProposal ?? persistWorkflowSkillProposal;

    // Lazy-load evolve and watch to avoid circular imports
    const _evolve = deps.evolve ?? (await import("./evolution/evolve.js")).evolve;
    const _watch = deps.watch ?? (await import("./monitoring/watch.js")).watch;

    // -------------------------------------------------------------------------
    // Step 1: Sync source-truth telemetry (mandatory)
    // -------------------------------------------------------------------------
    console.error("[orchestrate] Syncing source-truth telemetry...");
    const syncResult = _syncSources(createDefaultSyncOptions({ force: options.syncForce }));
    const sourceSynced = Object.values(syncResult.sources).reduce((sum, s) => sum + s.synced, 0);
    console.error(
      `[orchestrate] Sync complete: ${sourceSynced} sessions synced, ${syncResult.repair.repaired_records} repaired`,
    );

    // -------------------------------------------------------------------------
    // Step 2: Compute status
    // -------------------------------------------------------------------------
    console.error("[orchestrate] Computing skill status...");
    const telemetry = _readTelemetry();
    const skillRecords = _readSkillRecords();
    const queryRecords = _readQueryRecords();
    const auditEntries = _readAuditEntries();
    const doctorResult = await _doctor();

    let statusResult = _computeStatus(
      telemetry,
      skillRecords,
      queryRecords,
      auditEntries,
      doctorResult,
    );
    console.error(
      `[orchestrate] Status: ${statusResult.skills.length} skills, system=${statusResult.system.healthy ? "healthy" : "unhealthy"}`,
    );

    // -------------------------------------------------------------------------
    // Step 2a: Auto-grade ungraded skills with sufficient data
    // -------------------------------------------------------------------------
    let autoGradedCount = 0;
    const scopedSkills = options.skillFilter
      ? statusResult.skills.filter((s) => s.name === options.skillFilter)
      : statusResult.skills;
    const ungradedWithData = scopedSkills.filter(
      (s) => s.status === "UNGRADED" && (s.snapshot?.skill_checks ?? 0) > 0,
    );

    if (!options.dryRun && options.maxAutoGrade > 0 && ungradedWithData.length > 0) {
      const gradeAgent = _detectAgent();
      if (gradeAgent) {
        console.error(
          `[orchestrate] Auto-grading ${Math.min(ungradedWithData.length, options.maxAutoGrade)} ungraded skill(s)...`,
        );
        autoGradedCount = await autoGradeTopUngraded(
          scopedSkills,
          options.maxAutoGrade,
          gradeAgent,
          { readTelemetry: _readTelemetry, readSkillRecords: _readSkillRecords },
        );

        if (autoGradedCount > 0) {
          // Recompute status so candidate selection sees updated grades
          console.error(
            `[orchestrate] Recomputing status after grading ${autoGradedCount} skill(s)...`,
          );
          try {
            const freshTelemetry = _readTelemetry();
            const freshSkillRecords = _readSkillRecords();
            const freshQueryRecords = _readQueryRecords();
            const freshAudit = _readAuditEntries();
            const freshDoctor = doctorResult; // reuse — environment unchanged during grading
            statusResult = _computeStatus(
              freshTelemetry,
              freshSkillRecords,
              freshQueryRecords,
              freshAudit,
              freshDoctor,
            );
          } catch (recomputeErr) {
            console.error(
              `[orchestrate] Warning: failed to recompute status after grading — using pre-grade status. ${recomputeErr instanceof Error ? recomputeErr.message : String(recomputeErr)}`,
            );
          }
        }
      } else {
        console.error(
          "[orchestrate] No agent CLI found — skipping auto-grade. To disable, rerun with: selftune orchestrate --max-auto-grade 0",
        );
      }
    }

    // -------------------------------------------------------------------------
    // Step 2b: Read pending improvement signals
    // -------------------------------------------------------------------------
    const pendingSignals = readPendingSignals(deps.readSignals);
    const signaledSkills = groupSignalsBySkill(pendingSignals);
    if (signaledSkills.size > 0) {
      console.error(
        `[orchestrate] Improvement signals: ${pendingSignals.length} pending for ${signaledSkills.size} skill(s)`,
      );
    }

    // -------------------------------------------------------------------------
    // Step 3: Select candidates
    // -------------------------------------------------------------------------
    const candidates = selectCandidates(statusResult.skills, {
      skillFilter: options.skillFilter,
      maxSkills: options.maxSkills,
      auditEntries,
      signaledSkills,
    });

    const evolveCandidates = candidates.filter((c) => c.action === "evolve");
    const skipCount = candidates.filter((c) => c.action === "skip").length;
    console.error(
      `[orchestrate] Candidates: ${evolveCandidates.length} to evolve, ${skipCount} skipped`,
    );

    // Log each decision
    for (const c of candidates) {
      console.error(`  ${c.action === "skip" ? "⊘" : "→"} ${c.skill}: ${c.reason}`);
    }

    // Cross-skill overlap detection (console-only, non-critical)
    if (evolveCandidates.length >= 2) {
      try {
        const overlap = await detectCrossSkillOverlap(evolveCandidates, skillRecords, queryRecords);
        if (overlap.length > 0) {
          console.error("\n[orchestrate] Cross-skill eval overlap detected:");
          for (const o of overlap) {
            console.error(
              `  ⚠ ${o.skill_a} ↔ ${o.skill_b}: ${(o.overlap_pct * 100).toFixed(0)}% shared queries (${o.shared_queries.length} queries)`,
            );
          }
          console.error("");
        }
      } catch {
        // fail-open: overlap detection is non-critical
      }
    }

    // -------------------------------------------------------------------------
    // Step 4: Detect agent
    // -------------------------------------------------------------------------
    const agent = _detectAgent();
    if (!agent && evolveCandidates.length > 0) {
      console.error("[orchestrate] WARNING: No agent CLI found in PATH. Evolve will be skipped.");
      for (const c of evolveCandidates) {
        c.action = "skip";
        c.reason = "no agent CLI available";
      }
    }

    // -------------------------------------------------------------------------
    // Step 5: Evolve candidates
    // -------------------------------------------------------------------------
    for (const candidate of evolveCandidates) {
      // Skip if agent detection marked this candidate as skip
      if (candidate.action === "skip") continue;

      const skillPath = _resolveSkillPath(candidate.skill);
      if (!skillPath) {
        candidate.action = "skip";
        candidate.reason = `SKILL.md not found for "${candidate.skill}"`;
        console.error(`  ⊘ ${candidate.skill}: ${candidate.reason}`);
        continue;
      }

      const effectiveDryRun = options.dryRun || options.approvalMode === "review";
      console.error(
        `[orchestrate] Evolving "${candidate.skill}"${effectiveDryRun ? " (dry-run)" : ""}...`,
      );

      try {
        const evolveResult = await _evolve({
          skillName: candidate.skill,
          skillPath,
          agent: agent as string,
          dryRun: effectiveDryRun,
          confidenceThreshold: 0.6,
          maxIterations: 3,
          gradingResults: _readGradingResults(candidate.skill),
          syncFirst: false, // We already synced
          ...AUTONOMOUS_EVOLVE_DEFAULTS,
        });

        candidate.evolveResult = evolveResult;

        if (evolveResult.deployed) {
          console.error(`  ✓ ${candidate.skill}: deployed (${evolveResult.reason})`);
        } else {
          console.error(`  ✗ ${candidate.skill}: not deployed (${evolveResult.reason})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        candidate.action = "skip";
        candidate.reason = `evolve error: ${msg}`;
        console.error(`  ✗ ${candidate.skill}: error — ${msg}`);
      }
    }

    // -------------------------------------------------------------------------
    // Step 6: Watch recently evolved skills
    // -------------------------------------------------------------------------
    // Re-read audit entries to capture any newly-deployed entries from the evolve loop above.
    // evolve() writes audit entries synchronously, so a fresh read is needed.
    const freshAuditEntries = _readAuditEntries();
    const recentlyEvolved = findRecentlyDeployedSkills(
      freshAuditEntries,
      options.recentWindowHours,
    );

    // O(1) lookup for skills already processed as evolve candidates
    const evolvedSkillNames = new Set(
      candidates.filter((c) => c.action === "evolve").map((c) => c.skill),
    );

    for (const skillName of recentlyEvolved) {
      // Skip if already processed in this run as evolve candidate
      if (evolvedSkillNames.has(skillName)) {
        continue;
      }

      // Apply skill filter
      if (options.skillFilter && skillName !== options.skillFilter) continue;

      const skillPath = _resolveSkillPath(skillName);
      if (!skillPath) continue;

      console.error(`[orchestrate] Watching "${skillName}" (recently evolved)...`);

      try {
        const watchResult = await _watch({
          skillName,
          skillPath,
          windowSessions: 20,
          regressionThreshold: 0.1,
          autoRollback: true,
          syncFirst: false,
        });

        candidates.push({
          skill: skillName,
          action: "watch",
          reason: watchResult.alert ?? "stable",
          watchResult,
        });

        console.error(
          `  ${watchResult.alert ? "⚠" : "✓"} ${skillName}: ${watchResult.recommendation}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ ${skillName}: watch error — ${msg}`);
      }
    }

    // -------------------------------------------------------------------------
    // Step 6b: Generate workflow-skill proposals from strong telemetry patterns
    // -------------------------------------------------------------------------
    const workflowProposals = _discoverWorkflowSkillProposals(telemetry, skillRecords, {
      cwd: process.cwd(),
      skillFilter: options.skillFilter,
      resolveSkillPath: _resolveSkillPath,
      existingAuditEntries: freshAuditEntries,
    });

    if (workflowProposals.length > 0) {
      console.error(
        `[orchestrate] Workflow skill proposals: ${workflowProposals.length}${options.dryRun ? " (dry-run)" : ""}`,
      );
      for (const proposal of workflowProposals) {
        console.error(`  + ${proposal.draft.skill_name}: ${proposal.summary}`);
        if (!options.dryRun) {
          _persistWorkflowSkillProposal(proposal, {
            sourceSkillPath: _resolveSkillPath(proposal.source_skill_name),
          });
        }
      }
    }

    // -------------------------------------------------------------------------
    // Step 7: Build summary (single source of truth for both CLI and dashboard)
    // -------------------------------------------------------------------------
    const finalTotals = {
      totalSkills: statusResult.skills.length,
      evaluated: candidates.filter((c) => c.action === "evolve").length,
      evolved: candidates.filter((c) => c.action === "evolve" && c.evolveResult !== undefined)
        .length,
      deployed: candidates.filter((c) => c.evolveResult?.deployed).length,
      watched: candidates.filter((c) => c.action === "watch").length,
      skipped: candidates.filter((c) => c.action === "skip").length,
      autoGraded: autoGradedCount,
    };

    const result: OrchestrateResult = {
      syncResult,
      statusResult,
      candidates,
      workflowProposals,
      summary: {
        ...finalTotals,
        dryRun: options.dryRun,
        approvalMode: options.approvalMode,
        elapsedMs: Date.now() - startTime,
      },
    };

    // -------------------------------------------------------------------------
    // Step 7b: Mark consumed signals
    // -------------------------------------------------------------------------
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (pendingSignals.length > 0) {
      markSignalsConsumed(pendingSignals, runId);
    }

    // -------------------------------------------------------------------------
    // Step 8: Persist run report
    // -------------------------------------------------------------------------
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
      skill_actions: candidates.map(
        (c): OrchestrateRunSkillAction => ({
          skill: c.skill,
          action: c.action,
          reason: c.reason,
          deployed: c.evolveResult?.deployed,
          rolledBack: c.watchResult?.rolledBack,
          alert: c.watchResult?.alert,
          elapsed_ms: c.evolveResult?.elapsedMs,
          llm_calls: c.evolveResult?.llmCallCount,
        }),
      ),
    };

    try {
      writeOrchestrateRunToDb(runReport);
    } catch {
      /* fail-open */
    }

    // Also log to unified cron_runs timeline
    const totalLlmCalls = candidates.reduce(
      (sum, c) => sum + (c.evolveResult?.llmCallCount ?? 0),
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

    // -------------------------------------------------------------------------
    // Step 9: Alpha upload (fail-open — never blocks the orchestrate loop)
    // -------------------------------------------------------------------------
    const alphaIdentity = _readAlphaIdentity();
    if (alphaIdentity?.enrolled) {
      try {
        console.error("[orchestrate] Running alpha upload cycle...");
        const { runUploadCycle } = await import("./alpha-upload/index.js");
        const db = getDb();
        const uploadSummary = await runUploadCycle(db, {
          enrolled: true,
          userId: alphaIdentity.user_id,
          agentType: readConfiguredAgentType(SELFTUNE_CONFIG_PATH, "unknown"),
          selftuneVersion: getSelftuneVersion(),
          dryRun: options.dryRun,
          apiKey: alphaIdentity.api_key,
        });
        result.uploadSummary = uploadSummary;
        console.error(
          `[orchestrate] Alpha upload: prepared=${uploadSummary.prepared}, sent=${uploadSummary.sent}, failed=${uploadSummary.failed}, skipped=${uploadSummary.skipped}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[orchestrate] Alpha upload failed (non-blocking): ${msg}`);
      }
    }

    // -------------------------------------------------------------------------
    // Step 10: Contribution relay flush (fail-open — never blocks the loop)
    // Automatically sends any staged creator-directed signals for skills
    // the user has opted in to. Requires an API key (alpha enrolled).
    // -------------------------------------------------------------------------
    if (alphaIdentity?.api_key) {
      try {
        const { flushCreatorContributionSignals } = await import("./contribution-relay.js");
        const db = getDb();
        const relayResult = await flushCreatorContributionSignals(db, {
          apiKey: alphaIdentity.api_key,
          dryRun: options.dryRun,
        });
        if (relayResult.attempted > 0) {
          result.contributionRelaySummary = {
            attempted: relayResult.attempted,
            sent: relayResult.sent,
            failed: relayResult.failed,
          };
          console.error(
            `[orchestrate] Contribution relay: attempted=${relayResult.attempted}, sent=${relayResult.sent}, failed=${relayResult.failed}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[orchestrate] Contribution relay failed (non-blocking): ${msg}`);
      }
    }

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
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      "review-required": { type: "boolean", default: false },
      "auto-approve": { type: "boolean", default: false },
      skill: { type: "string" },
      "max-skills": { type: "string", default: "5" },
      "recent-window": { type: "string", default: "48" },
      "sync-force": { type: "boolean", default: false },
      "max-auto-grade": { type: "string", default: "5" },
      loop: { type: "boolean", default: false },
      "loop-interval": { type: "string", default: "3600" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune orchestrate — Autonomous core loop

Runs the full improvement cycle: sync → status → auto-grade → evolve → watch.

Usage:
  selftune orchestrate [options]

Options:
  --dry-run             Preview actions without mutations
  --review-required     Validate candidates but require human review before deploy
  --auto-approve        Deprecated alias; autonomous mode is now the default
  --skill <name>        Scope to a single skill
  --max-skills <n>      Cap skills processed per run (default: 5)
  --recent-window <hrs> Hours to look back for watch targets (default: 48)
  --sync-force          Force full rescan during sync
  --max-auto-grade <n>  Max ungraded skills to auto-grade per run (default: 5, 0 to disable)
  --loop                Run in continuous loop mode (never stops)
  --loop-interval <s>   Seconds between iterations (default: 3600, min: 60)
  -h, --help            Show this help message

Safety:
  By default, low-risk description evolution runs autonomously after
  validation. Use --review-required to keep a human in the loop, or
  --dry-run to preview the whole loop without mutations. Every deploy
  still passes validation gates first.

Examples:
  selftune orchestrate                          # autonomous description evolution
  selftune orchestrate --review-required        # validate but do not deploy
  selftune orchestrate --dry-run                # preview only
  selftune orchestrate --skill Research         # single skill
  selftune orchestrate --max-skills 3           # limit scope
  selftune orchestrate --loop                         # continuous loop (hourly)
  selftune orchestrate --loop --loop-interval 600     # every 10 minutes`);
    process.exit(0);
  }

  const maxSkillsRaw = values["max-skills"] ?? "5";
  if (!/^\d+$/.test(maxSkillsRaw) || Number(maxSkillsRaw) < 1) {
    throw new CLIError(
      "--max-skills must be a positive integer",
      "INVALID_FLAG",
      "selftune orchestrate --max-skills 5",
    );
  }
  const maxSkills = Number(maxSkillsRaw);

  const recentWindowRaw = values["recent-window"] ?? "48";
  if (!/^\d+$/.test(recentWindowRaw) || Number(recentWindowRaw) < 1) {
    throw new CLIError(
      "--recent-window must be a positive integer",
      "INVALID_FLAG",
      "selftune orchestrate --recent-window 48",
    );
  }
  const recentWindow = Number(recentWindowRaw);

  const maxAutoGradeRaw = values["max-auto-grade"] ?? "5";
  if (!/^\d+$/.test(maxAutoGradeRaw)) {
    throw new CLIError(
      "--max-auto-grade must be a non-negative integer",
      "INVALID_FLAG",
      "selftune orchestrate --max-auto-grade 5",
    );
  }
  const maxAutoGrade = Number(maxAutoGradeRaw);

  const loopIntervalRaw = values["loop-interval"] ?? "3600";
  if (!/^\d+$/.test(loopIntervalRaw) || (values.loop && Number(loopIntervalRaw) < 60)) {
    throw new CLIError(
      "--loop-interval must be an integer >= 60 (seconds)",
      "INVALID_FLAG",
      "selftune orchestrate --loop --loop-interval 3600",
    );
  }
  const loopInterval = Number(loopIntervalRaw);

  const autoApprove = values["auto-approve"] ?? false;
  if (autoApprove) {
    console.error(
      "[orchestrate] --auto-approve is deprecated; autonomous mode is now the default.",
    );
  }

  const reviewRequired = values["review-required"] ?? false;
  const dryRun = values["dry-run"] ?? false;
  const approvalMode: "auto" | "review" = reviewRequired ? "review" : "auto";

  const isLoop = values.loop ?? false;
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
      dryRun,
      approvalMode,
      skillFilter: values.skill,
      maxSkills,
      recentWindowHours: recentWindow,
      syncForce: values["sync-force"] ?? false,
      maxAutoGrade,
    });

    // JSON output: include per-skill decisions for machine consumption
    const jsonOutput = {
      ...result.summary,
      ...(result.uploadSummary ? { upload: result.uploadSummary } : {}),
      workflow_proposals: result.workflowProposals.map((proposal) => ({
        proposal_id: proposal.proposal_id,
        source_skill_name: proposal.source_skill_name,
        workflow_id: proposal.workflow.workflow_id,
        generated_skill_name: proposal.draft.skill_name,
        output_path: proposal.draft.skill_path,
        confidence: proposal.confidence,
        reason: proposal.rationale,
      })),
      decisions: result.candidates.map((c) => ({
        skill: c.skill,
        action: c.action,
        reason: c.reason,
        ...(c.evolveResult
          ? {
              deployed: c.evolveResult.deployed,
              evolveReason: c.evolveResult.reason,
              validation: c.evolveResult.validation
                ? {
                    before: c.evolveResult.validation.before_pass_rate,
                    after: c.evolveResult.validation.after_pass_rate,
                    improved: c.evolveResult.validation.improved,
                  }
                : null,
            }
          : {}),
        ...(c.watchResult
          ? {
              alert: c.watchResult.alert,
              rolledBack: c.watchResult.rolledBack,
              passRate: c.watchResult.snapshot?.pass_rate ?? null,
              recommendation: c.watchResult.recommendation,
            }
          : {}),
      })),
    };
    console.log(JSON.stringify(jsonOutput, null, 2));

    // Print human-readable decision report to stderr
    console.error(`\n${formatOrchestrateReport(result)}`);

    if (!isLoop || stopRequested) break;

    const nextMinutes = Math.round(loopInterval / 60);
    console.error(`\n[orchestrate] Next cycle in ${nextMinutes} minute(s)... (Ctrl+C to stop)`);
    await new Promise<void>((resolve) => {
      sleepResolve = resolve;
      sleepTimer = setTimeout(() => {
        sleepTimer = null;
        sleepResolve = null;
        resolve();
      }, loopInterval * 1000);
    });
  } while (isLoop && !stopRequested);

  process.exit(0);
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
