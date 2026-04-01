/**
 * evolve.ts
 *
 * Evolution orchestrator: coordinates failure pattern extraction, proposal
 * generation, validation, and deployment into a single pipeline with retry
 * logic and comprehensive audit tracking.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { QUERY_LOG, SKILL_LOG } from "../constants.js";
import type { BaselineMeasurement } from "../eval/baseline.js";
import { measureBaseline } from "../eval/baseline.js";
import { buildEvalSet } from "../eval/hooks-to-evals.js";
import { readGradingResultsForSkill } from "../grading/results.js";
import { getDb } from "../localdb/db.js";
import {
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "../localdb/queries.js";
import { updateContextAfterEvolve } from "../memory/writer.js";
import type { SyncResult } from "../sync.js";
import type {
  EvalEntry,
  EvalPassRate,
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  EvolutionProposal,
  EvolveResultSummary,
  FailurePattern,
  GradingResult,
  ParetoCandidate,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { CLIError, handleCLIError } from "../utils/cli-error.js";
import { parseFrontmatter, replaceDescription } from "../utils/frontmatter.js";
import type { EffortLevel } from "../utils/llm-call.js";
import { createEvolveTUI } from "../utils/tui.js";
import { appendAuditEntry } from "./audit.js";
import { checkConstitution } from "./constitutional.js";
import { scoreDescription } from "./description-quality.js";
import { appendEvidenceEntry } from "./evidence.js";
import { extractFailurePatterns } from "./extract-patterns.js";
import {
  computeInvocationScores,
  computeParetoFrontier,
  computeTokenEfficiencyScore,
  selectFromFrontier,
} from "./pareto.js";
import { generateMultipleProposals, generateProposal } from "./propose-description.js";
import { evaluateStoppingCriteria } from "./stopping-criteria.js";
import { buildUnblockSuggestions } from "./unblock-suggestions.js";
import type { ValidationResult } from "./validate-proposal.js";
import {
  TRIGGER_CHECK_BATCH_SIZE,
  VALIDATION_RUNS,
  validateProposal,
} from "./validate-proposal.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvolveOptions {
  skillName: string;
  skillPath: string;
  evalSetPath?: string;
  agent: string;
  dryRun: boolean;
  confidenceThreshold: number; // default 0.6
  maxIterations: number; // default 3
  gradingResults?: GradingResult[];
  paretoEnabled?: boolean;
  candidateCount?: number;
  tokenEfficiencyEnabled?: boolean;
  telemetryRecords?: SessionTelemetryRecord[];
  withBaseline?: boolean;
  validationModel?: string;
  cheapLoop?: boolean;
  gateModel?: string;
  gateEffort?: EffortLevel;
  proposalModel?: string;
  adaptiveGate?: boolean;
  syncFirst?: boolean;
  syncForce?: boolean;
}

export interface EvolveResult {
  proposal: EvolutionProposal | null;
  validation: ValidationResult | null;
  deployed: boolean;
  auditEntries: EvolutionAuditEntry[];
  reason: string;
  skillVersion?: string;
  llmCallCount: number;
  elapsedMs: number;
  baselineResult?: BaselineMeasurement;
  gateValidation?: ValidationResult;
  sync_result?: SyncResult;
  descriptionQualityBefore?: number;
  descriptionQualityAfter?: number;
}

/**
 * Injectable dependencies for evolve(). When omitted, the real module
 * imports are used. Pass overrides in tests to avoid mock.module().
 */
export interface EvolveDeps {
  extractFailurePatterns?: (
    evalEntries: EvalEntry[],
    skillUsage: SkillUsageRecord[],
    skillName: string,
    gradingResults?: GradingResult[],
  ) => FailurePattern[];
  generateProposal?: typeof import("./propose-description.js").generateProposal;
  validateProposal?: typeof import("./validate-proposal.js").validateProposal;
  gateValidateProposal?: typeof import("./validate-proposal.js").validateProposal;
  appendAuditEntry?: typeof import("./audit.js").appendAuditEntry;
  appendEvidenceEntry?: typeof import("./evidence.js").appendEvidenceEntry;
  buildEvalSet?: typeof import("../eval/hooks-to-evals.js").buildEvalSet;
  updateContextAfterEvolve?: typeof import("../memory/writer.js").updateContextAfterEvolve;
  measureBaseline?: typeof import("../eval/baseline.js").measureBaseline;
  readSkillUsageLog?: () => SkillUsageRecord[];
  syncSources?: typeof import("../sync.js").syncSources;
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

function createAuditEntry(
  proposalId: string,
  action: EvolutionAuditEntry["action"],
  details: string,
  evalSnapshot?: EvalPassRate,
  skillName?: string,
  iterationsUsed?: number,
  provenance?: Pick<
    EvolutionAuditEntry,
    "validation_mode" | "validation_agent" | "validation_fixture_id" | "validation_evidence_ref"
  >,
): EvolutionAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    proposal_id: proposalId,
    action,
    details,
    ...(skillName ? { skill_name: skillName } : {}),
    ...(evalSnapshot ? { eval_snapshot: evalSnapshot } : {}),
    ...(iterationsUsed != null ? { iterations_used: iterationsUsed } : {}),
    ...(provenance?.validation_mode ? { validation_mode: provenance.validation_mode } : {}),
    ...(provenance?.validation_agent ? { validation_agent: provenance.validation_agent } : {}),
    ...(provenance?.validation_fixture_id
      ? { validation_fixture_id: provenance.validation_fixture_id }
      : {}),
    ...(provenance?.validation_evidence_ref
      ? { validation_evidence_ref: provenance.validation_evidence_ref }
      : {}),
  };
}

function buildValidationEvidenceRef(proposalId: string, stage: string): string {
  return `evolution_evidence:${proposalId}:${stage}`;
}

// ---------------------------------------------------------------------------
// Diff helper
// ---------------------------------------------------------------------------

/**
 * Produce a simple colored diff between two text strings.
 * Red (removed) / Green (added) lines, skipping unchanged lines.
 */
function formatSimpleDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const output: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) continue;
    if (oldLine !== undefined) {
      output.push(`\x1b[31m- ${oldLine}\x1b[0m`);
    }
    if (newLine !== undefined) {
      output.push(`\x1b[32m+ ${newLine}\x1b[0m`);
    }
  }
  return output.join("\n");
}

function countValidationLlmCalls(evalSetSize: number): number {
  if (evalSetSize === 0) return 0;
  return Math.ceil(evalSetSize / TRIGGER_CHECK_BATCH_SIZE) * 2 * VALIDATION_RUNS;
}

interface GateDecision {
  model: string;
  effort?: EffortLevel;
  riskSignals: string[];
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0).length;
}

function resolveGateDecision(
  options: EvolveOptions,
  proposal: EvolutionProposal,
  validation: ValidationResult,
  currentDescription: string,
  confidenceThreshold: number,
): GateDecision | undefined {
  const baseModel = options.gateModel;
  if (!baseModel) return undefined;

  const baseDecision: GateDecision = {
    model: baseModel,
    effort: options.gateEffort,
    riskSignals: [],
  };

  if (!options.adaptiveGate) return baseDecision;

  const riskSignals: string[] = [];
  const originalWords = countWords(currentDescription);
  const proposedWords = countWords(proposal.proposed_description);
  const wordGrowth = originalWords === 0 ? 1 : proposedWords / originalWords;
  const lowLift = validation.net_change < 0.15;
  const hasRegressions = validation.regressions.length > 0;
  const lowConfidence = proposal.confidence < Math.max(confidenceThreshold + 0.05, 0.75);
  const broadeningRisk = wordGrowth > 1.8 || proposedWords - originalWords > 32;
  const notYetStrong = validation.after_pass_rate < 0.9;

  if (hasRegressions) riskSignals.push(`regressions=${validation.regressions.length}`);
  if (lowLift) riskSignals.push(`low_lift=${validation.net_change.toFixed(3)}`);
  if (lowConfidence) riskSignals.push(`confidence=${proposal.confidence.toFixed(2)}`);
  if (broadeningRisk) riskSignals.push(`word_growth=${wordGrowth.toFixed(2)}x`);
  if (notYetStrong) riskSignals.push(`after_pass_rate=${validation.after_pass_rate.toFixed(2)}`);

  const shouldEscalate = hasRegressions || validation.net_change < 0.1 || riskSignals.length >= 2;
  if (!shouldEscalate) {
    return {
      ...baseDecision,
      riskSignals,
    };
  }

  return {
    model: "opus",
    effort: options.gateEffort === "max" ? "max" : "high",
    riskSignals,
  };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function evolve(
  options: EvolveOptions,
  _deps: EvolveDeps = {},
): Promise<EvolveResult> {
  const { skillName, skillPath, evalSetPath, agent, dryRun, confidenceThreshold, maxIterations } =
    options;

  // Apply cheap-loop defaults: cheap models for proposal/validation, expensive for gate
  if (options.cheapLoop) {
    if (!options.proposalModel) options.proposalModel = "haiku";
    if (!options.validationModel) options.validationModel = "haiku";
    if (!options.gateModel) options.gateModel = "sonnet";
  }

  // Resolve injectable dependencies with real-import fallbacks
  const _extractFailurePatterns = _deps.extractFailurePatterns ?? extractFailurePatterns;
  const _generateProposal = _deps.generateProposal ?? generateProposal;
  const _validateProposal = _deps.validateProposal ?? validateProposal;
  const _gateValidateProposal = _deps.gateValidateProposal ?? validateProposal;
  const _appendAuditEntry = _deps.appendAuditEntry ?? appendAuditEntry;
  const _appendEvidenceEntry = _deps.appendEvidenceEntry ?? appendEvidenceEntry;
  const _buildEvalSet = _deps.buildEvalSet ?? buildEvalSet;
  const _updateContextAfterEvolve = _deps.updateContextAfterEvolve ?? updateContextAfterEvolve;
  const _measureBaseline = _deps.measureBaseline ?? measureBaseline;
  const _readSkillUsageLog =
    _deps.readSkillUsageLog ??
    (() => {
      const db = getDb();
      return querySkillUsageRecords(db) as SkillUsageRecord[];
    });

  const auditEntries: EvolutionAuditEntry[] = [];
  let syncResult: SyncResult | undefined;

  function recordAudit(
    proposalId: string,
    action: EvolutionAuditEntry["action"],
    details: string,
    evalSnapshot?: EvalPassRate,
    iterationsUsed?: number,
    provenance?: Pick<
      EvolutionAuditEntry,
      "validation_mode" | "validation_agent" | "validation_fixture_id" | "validation_evidence_ref"
    >,
  ): void {
    const entry = createAuditEntry(
      proposalId,
      action,
      details,
      evalSnapshot,
      skillName,
      iterationsUsed,
      provenance,
    );
    auditEntries.push(entry);
    try {
      _appendAuditEntry(entry);
    } catch {
      // Fail-open: audit write failures should not break the pipeline
    }
  }

  function recordEvidence(entry: EvolutionEvidenceEntry): void {
    try {
      _appendEvidenceEntry(entry);
    } catch {
      // Fail-open: evidence should not block the pipeline
    }
  }

  const pipelineStart = Date.now();
  let llmCallCount = 0;
  const tui = createEvolveTUI({ skillName, model: options.proposalModel ?? "(default)" });
  const finishTui = () =>
    tui.finish(
      `${llmCallCount} LLM calls \u00b7 ${((Date.now() - pipelineStart) / 1000).toFixed(1)}s elapsed`,
    );

  /** Stamp every return with pipeline stats so callers always get them. */
  const withStats = (r: Omit<EvolveResult, "llmCallCount" | "elapsedMs">): EvolveResult => {
    const descQualityAfterScore = r.proposal
      ? scoreDescription(r.proposal.proposed_description, options.skillName).composite
      : undefined;
    return {
      ...r,
      llmCallCount,
      elapsedMs: Date.now() - pipelineStart,
      ...(syncResult ? { sync_result: syncResult } : {}),
      ...(descQualityBeforeScore != null
        ? { descriptionQualityBefore: descQualityBeforeScore }
        : {}),
      ...(descQualityAfterScore != null ? { descriptionQualityAfter: descQualityAfterScore } : {}),
    };
  };

  // Hoisted so catch block and withStats can preserve partial results on error
  let lastProposal: EvolutionProposal | null = null;
  let lastValidation: ValidationResult | null = null;
  let descQualityBeforeScore: number | undefined;

  try {
    // -----------------------------------------------------------------------
    // Step 1: Read current SKILL.md
    // -----------------------------------------------------------------------
    if (!existsSync(skillPath)) {
      tui.fail(`SKILL.md not found at ${skillPath}`);
      finishTui();
      return withStats({
        proposal: null,
        validation: null,
        deployed: false,
        auditEntries,
        reason: `SKILL.md not found at ${skillPath}`,
      });
    }

    const rawContent = readFileSync(skillPath, "utf-8");
    const frontmatter = parseFrontmatter(rawContent);
    const currentDescription = frontmatter.description || rawContent;
    const skillVersion = frontmatter.version || undefined;
    const versionTag = skillVersion ? `, v${skillVersion}` : "";
    const createdAuditDetails = (message: string) =>
      `original_description:${rawContent}\n${message}`;
    const descQualityBefore = scoreDescription(currentDescription, skillName);
    descQualityBeforeScore = descQualityBefore.composite;
    tui.done(
      `Loaded SKILL.md (desc: ${currentDescription.length} chars${versionTag}, quality: ${descQualityBefore.composite})`,
    );

    if (options.syncFirst) {
      tui.step(`Syncing source-truth telemetry${options.syncForce ? " (force)" : ""}...`);
      const { createDefaultSyncOptions, syncSources: realSyncSources } = await import("../sync.js");
      const syncRunner = _deps.syncSources ?? realSyncSources;
      syncResult = syncRunner(
        createDefaultSyncOptions({
          force: options.syncForce ?? false,
        }),
      );
      const sourceSynced = Object.values(syncResult.sources).reduce(
        (sum, source) => sum + source.synced,
        0,
      );
      tui.done(
        `Source sync complete (${sourceSynced} source sessions, ${syncResult.repair.repaired_records} repaired records)`,
      );
    }

    // -----------------------------------------------------------------------
    // Step 2: Load eval set
    // -----------------------------------------------------------------------
    const skillUsage = _readSkillUsageLog();
    let evalSet: EvalEntry[];

    if (evalSetPath && existsSync(evalSetPath)) {
      try {
        const raw = readFileSync(evalSetPath, "utf-8");
        evalSet = JSON.parse(raw) as EvalEntry[];
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        tui.fail(`Failed to load eval set from ${evalSetPath}: ${msg}`);
        finishTui();
        return withStats({
          proposal: null,
          validation: null,
          deployed: false,
          auditEntries,
          reason: `Failed to load eval set: ${msg}`,
        });
      }
      if (!Array.isArray(evalSet)) {
        tui.fail(`Eval set at ${evalSetPath} is not an array`);
        finishTui();
        return withStats({
          proposal: null,
          validation: null,
          deployed: false,
          auditEntries,
          reason: `Eval set at ${evalSetPath} is not a JSON array`,
        });
      }
    } else {
      // Build from logs
      const dbForQuery = getDb();
      const queryRecords = queryQueryLog(dbForQuery) as QueryLogRecord[];
      evalSet = _buildEvalSet(skillUsage, queryRecords, skillName);
    }

    const posCount = evalSet.filter((e) => e.should_trigger).length;
    const negCount = evalSet.filter((e) => !e.should_trigger).length;
    tui.done(`Loaded eval set (${evalSet.length} entries: ${posCount}+, ${negCount}-)`);

    // -----------------------------------------------------------------------
    // Step 3: Load skill usage records
    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // Step 4: Extract failure patterns
    // -----------------------------------------------------------------------
    const failurePatterns = _extractFailurePatterns(
      evalSet,
      skillUsage,
      skillName,
      options.gradingResults,
    );

    const totalMissed = failurePatterns.reduce((sum, p) => sum + p.missed_queries.length, 0);
    tui.done(
      `Extracted ${failurePatterns.length} failure pattern(s) (${totalMissed} missed queries)`,
    );

    // Compute aggregate grading metrics for proposal context
    const aggregateMetrics = options.gradingResults?.length
      ? (() => {
          const scores = options.gradingResults.map(
            (r) => r.summary.mean_score ?? r.summary.pass_rate,
          );
          const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
          const scoreStdDev = Math.sqrt(
            scores.reduce((sum, s) => sum + (s - meanScore) ** 2, 0) / scores.length,
          );
          const failedRate =
            options.gradingResults.filter((r) => r.summary.failed > 0).length /
            options.gradingResults.length;
          const errors = options.gradingResults.map(
            (r) => r.execution_metrics?.errors_encountered ?? 0,
          );
          const meanErrors = errors.reduce((a, b) => a + b, 0) / errors.length;
          return {
            mean_score: meanScore,
            score_std_dev: scoreStdDev,
            failed_session_rate: failedRate,
            mean_errors: meanErrors,
            total_graded: options.gradingResults.length,
          };
        })()
      : undefined;

    // -----------------------------------------------------------------------
    // Step 5: Cold-start bootstrap or early exit if no patterns
    // -----------------------------------------------------------------------
    if (failurePatterns.length === 0) {
      // Cold-start: if the eval set has positive entries that the skill should
      // match but there are zero skill usage records, treat the positive eval
      // entries themselves as "missed queries" — they ARE the failure signal.
      const positiveEvals = evalSet.filter((e) => e.should_trigger);
      const hasSkillUsageHistory = skillUsage.some((record) => record.skill_name === skillName);
      if (positiveEvals.length > 0 && !hasSkillUsageHistory) {
        const coldStartPattern: FailurePattern = {
          pattern_id: `fp-${skillName}-coldstart`,
          skill_name: skillName,
          invocation_type: "implicit",
          missed_queries: positiveEvals.map((e) => e.query),
          frequency: positiveEvals.length,
          sample_sessions: [],
          extracted_at: new Date().toISOString(),
        };
        failurePatterns.push(coldStartPattern);
        tui.done(
          `Cold-start bootstrap: ${positiveEvals.length} positive eval entries used as missed queries`,
        );
      } else {
        finishTui();
        return withStats({
          proposal: null,
          validation: null,
          deployed: false,
          auditEntries,
          reason: "No failure patterns found",
        });
      }
    }

    // -----------------------------------------------------------------------
    // Step 6: Collect all missed queries
    // -----------------------------------------------------------------------
    const missedQueries = failurePatterns.flatMap((p) => p.missed_queries);

    // -----------------------------------------------------------------------
    // Steps 7-12: Proposal generation and validation
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Pareto multi-candidate path
    // -----------------------------------------------------------------------
    const paretoEnabled = options.paretoEnabled ?? true;
    const candidateCount = options.candidateCount ?? 3;
    const tokenEfficiencyEnabled = options.tokenEfficiencyEnabled ?? false;
    const telemetryRecords =
      options.telemetryRecords ??
      (tokenEfficiencyEnabled
        ? (() => {
            const dbTel = getDb();
            return querySessionTelemetry(dbTel) as SessionTelemetryRecord[];
          })()
        : undefined);

    // Compute token efficiency score if enabled and telemetry is available
    let tokenEffScore: number | undefined;
    if (tokenEfficiencyEnabled && telemetryRecords && telemetryRecords.length > 0) {
      tokenEffScore = computeTokenEfficiencyScore(skillName, telemetryRecords);
      recordAudit(
        "system",
        "created",
        `Token efficiency score for ${skillName}: ${tokenEffScore.toFixed(3)}`,
      );
    }

    let iterationsCompleted = 0;

    if (paretoEnabled && candidateCount > 1) {
      // Generate N candidates in parallel
      const candidates = await generateMultipleProposals(
        currentDescription,
        failurePatterns,
        missedQueries,
        skillName,
        skillPath,
        agent,
        candidateCount,
        options.proposalModel,
        aggregateMetrics,
      );
      llmCallCount += candidateCount;

      // Filter by confidence threshold
      const viableCandidates = candidates.filter((c) => c.confidence >= confidenceThreshold);

      if (viableCandidates.length === 0) {
        finishTui();
        return withStats({
          proposal: candidates[0] ?? null,
          validation: null,
          deployed: false,
          auditEntries,
          reason: `No candidates met confidence threshold ${confidenceThreshold}`,
        });
      }

      // Validate each candidate
      const paretoCandidates: ParetoCandidate[] = [];
      for (const proposal of viableCandidates) {
        recordAudit(
          proposal.proposal_id,
          "created",
          createdAuditDetails(`Pareto candidate for ${skillName}`),
        );
        recordEvidence({
          timestamp: new Date().toISOString(),
          proposal_id: proposal.proposal_id,
          skill_name: skillName,
          skill_path: skillPath,
          target: "description",
          stage: "created",
          rationale: proposal.rationale,
          confidence: proposal.confidence,
          details: `Pareto candidate for ${skillName}`,
          original_text: proposal.original_description,
          proposed_text: proposal.proposed_description,
          eval_set: evalSet,
        });

        // Constitutional check before validation (same gate as retry flow)
        const constitution = checkConstitution(
          proposal.proposed_description,
          currentDescription,
          skillName,
        );
        if (!constitution.passed) {
          const reason = `Constitutional: ${constitution.violations.join("; ")}`;
          recordAudit(proposal.proposal_id, "rejected", reason);
          recordEvidence({
            timestamp: new Date().toISOString(),
            proposal_id: proposal.proposal_id,
            skill_name: skillName,
            skill_path: skillPath,
            target: "description",
            stage: "rejected",
            rationale: proposal.rationale,
            confidence: proposal.confidence,
            details: reason,
            original_text: proposal.original_description,
            proposed_text: proposal.proposed_description,
            eval_set: evalSet,
          });
          continue;
        }

        const validation = await _validateProposal(
          proposal,
          evalSet,
          agent,
          options.validationModel,
        );
        llmCallCount += countValidationLlmCalls(evalSet.length);
        const evidenceRef = buildValidationEvidenceRef(proposal.proposal_id, "validated");
        recordAudit(
          proposal.proposal_id,
          "validated",
          `Pareto validation: improved=${validation.improved}`,
          undefined,
          undefined,
          {
            validation_mode: validation.validation_mode,
            validation_agent: validation.validation_agent,
            validation_evidence_ref: evidenceRef,
          },
        );
        recordEvidence({
          timestamp: new Date().toISOString(),
          proposal_id: proposal.proposal_id,
          skill_name: skillName,
          skill_path: skillPath,
          target: "description",
          stage: "validated",
          rationale: proposal.rationale,
          confidence: proposal.confidence,
          details: `Pareto validation: improved=${validation.improved}`,
          validation: {
            improved: validation.improved,
            before_pass_rate: validation.before_pass_rate,
            after_pass_rate: validation.after_pass_rate,
            net_change: validation.net_change,
            regressions: validation.regressions,
            new_passes: validation.new_passes,
            per_entry_results: validation.per_entry_results,
            validation_mode: validation.validation_mode,
            validation_agent: validation.validation_agent,
            validation_evidence_ref: evidenceRef,
          },
        });

        if (validation.improved && validation.per_entry_results) {
          const invocationScores = computeInvocationScores(validation.per_entry_results);
          const candidate: ParetoCandidate = {
            proposal,
            validation,
            invocation_scores: invocationScores,
            dominates_on: [],
          };
          if (tokenEffScore !== undefined) {
            candidate.token_efficiency_score = tokenEffScore;
          }
          paretoCandidates.push(candidate);
        }
      }

      if (paretoCandidates.length === 0) {
        finishTui();
        return withStats({
          proposal: viableCandidates[0],
          validation: null,
          deployed: false,
          auditEntries,
          reason: "No Pareto candidates improved validation",
        });
      }

      // Compute Pareto frontier
      const frontier = computeParetoFrontier(paretoCandidates);
      const { best } = selectFromFrontier(frontier);

      lastProposal = best.proposal;
      lastValidation = best.validation;
      iterationsCompleted = 1; // Pareto selection is a single-pass

      // Skip the standard retry loop — we already have our result
    } else {
      // Standard single-candidate retry loop
      let feedbackReason = "";
      const previousPassRates: number[] = [];

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        iterationsCompleted = iteration + 1;
        // Step 7: Generate proposal
        const effectiveMissedQueries = feedbackReason
          ? [...missedQueries, `[Previous attempt failed: ${feedbackReason}]`]
          : missedQueries;

        tui.step(`Generating proposal (iteration ${iteration + 1}/${maxIterations})...`);
        const proposal = await _generateProposal(
          currentDescription,
          failurePatterns,
          effectiveMissedQueries,
          skillName,
          skillPath,
          agent,
          options.proposalModel,
          aggregateMetrics,
        );
        llmCallCount++;

        lastProposal = proposal;
        tui.done(`Proposal generated (conf: ${proposal.confidence.toFixed(2)})`);

        // Step 8: Audit "created"
        recordAudit(
          proposal.proposal_id,
          "created",
          createdAuditDetails(`Proposal created for ${skillName} (iteration ${iteration + 1})`),
        );
        recordEvidence({
          timestamp: new Date().toISOString(),
          proposal_id: proposal.proposal_id,
          skill_name: skillName,
          skill_path: skillPath,
          target: "description",
          stage: "created",
          rationale: proposal.rationale,
          confidence: proposal.confidence,
          details: `Proposal created for ${skillName} (iteration ${iteration + 1})`,
          original_text: proposal.original_description,
          proposed_text: proposal.proposed_description,
          eval_set: evalSet,
        });

        // Step 8b: Constitutional check (deterministic, pre-validation)
        const constitution = checkConstitution(
          proposal.proposed_description,
          currentDescription,
          skillName,
        );
        if (!constitution.passed) {
          feedbackReason = `Constitutional: ${constitution.violations.join("; ")}`;
          // Re-evaluate stopping after a constitutional rejection by treating the
          // last entry in previousPassRates as the currentPassRate (or 0 on the
          // first iteration) and slicing it out of history before calling
          // evaluateStoppingCriteria() with the current iteration/maxIterations,
          // confidenceThreshold, and proposal.confidence.
          const constitutionStop = evaluateStoppingCriteria(
            previousPassRates.at(-1) ?? 0,
            previousPassRates.slice(0, -1),
            iteration + 1,
            maxIterations,
            confidenceThreshold,
            proposal.confidence,
          );
          recordAudit(
            proposal.proposal_id,
            "rejected",
            `${feedbackReason} (stopping: ${constitutionStop.reason})`,
          );
          recordEvidence({
            timestamp: new Date().toISOString(),
            proposal_id: proposal.proposal_id,
            skill_name: skillName,
            skill_path: skillPath,
            target: "description",
            stage: "rejected",
            rationale: proposal.rationale,
            confidence: proposal.confidence,
            details: `${feedbackReason} (stopping: ${constitutionStop.reason})`,
          });
          if (constitutionStop.shouldStop) {
            finishTui();
            return withStats({
              proposal: lastProposal,
              validation: null,
              deployed: false,
              auditEntries,
              reason: `${feedbackReason} (${constitutionStop.reason})`,
            });
          }
          continue;
        }

        // Step 9: Check confidence threshold via stopping criteria
        {
          const preValidationStop = evaluateStoppingCriteria(
            previousPassRates.at(-1) ?? 0,
            previousPassRates.slice(0, -1),
            iteration + 1,
            maxIterations,
            confidenceThreshold,
            proposal.confidence,
          );
          if (proposal.confidence < confidenceThreshold) {
            feedbackReason = `Confidence ${proposal.confidence} below threshold ${confidenceThreshold}`;
            recordAudit(
              proposal.proposal_id,
              "rejected",
              `${feedbackReason} (stopping: ${preValidationStop.reason})`,
            );
            recordEvidence({
              timestamp: new Date().toISOString(),
              proposal_id: proposal.proposal_id,
              skill_name: skillName,
              skill_path: skillPath,
              target: "description",
              stage: "rejected",
              rationale: proposal.rationale,
              confidence: proposal.confidence,
              details: `${feedbackReason} (stopping: ${preValidationStop.reason})`,
            });

            // Use stopping criteria to decide whether to return or retry
            if (preValidationStop.shouldStop) {
              finishTui();
              return withStats({
                proposal: lastProposal,
                validation: null,
                deployed: false,
                auditEntries,
                reason: `${feedbackReason} (${preValidationStop.reason})`,
              });
            }

            continue;
          }
        }

        // Step 10: Validate against eval set
        const batchCount = Math.ceil(evalSet.length / TRIGGER_CHECK_BATCH_SIZE);
        tui.step(
          `Validating ${evalSet.length} entries (${batchCount} batches, ${VALIDATION_RUNS}x majority-vote)...`,
        );
        const validation = await _validateProposal(
          proposal,
          evalSet,
          agent,
          options.validationModel,
        );
        lastValidation = validation;
        llmCallCount += countValidationLlmCalls(evalSet.length);
        tui.done(
          `Validation: ${(validation.before_pass_rate * 100).toFixed(1)}% \u2192 ${(validation.after_pass_rate * 100).toFixed(1)}% (improved: ${validation.improved})`,
        );

        // Step 11: Audit "validated"
        const evalSnapshot: EvalPassRate = {
          total: evalSet.length,
          passed: Math.round(validation.after_pass_rate * evalSet.length),
          failed: evalSet.length - Math.round(validation.after_pass_rate * evalSet.length),
          pass_rate: validation.after_pass_rate,
        };
        const validatedEvidenceRef = buildValidationEvidenceRef(proposal.proposal_id, "validated");
        recordAudit(
          proposal.proposal_id,
          "validated",
          `Validation complete: improved=${validation.improved}`,
          evalSnapshot,
          undefined,
          {
            validation_mode: validation.validation_mode,
            validation_agent: validation.validation_agent,
            validation_evidence_ref: validatedEvidenceRef,
          },
        );
        recordEvidence({
          timestamp: new Date().toISOString(),
          proposal_id: proposal.proposal_id,
          skill_name: skillName,
          skill_path: skillPath,
          target: "description",
          stage: "validated",
          rationale: proposal.rationale,
          confidence: proposal.confidence,
          details: `Validation complete: improved=${validation.improved}`,
          validation: {
            improved: validation.improved,
            before_pass_rate: validation.before_pass_rate,
            after_pass_rate: validation.after_pass_rate,
            net_change: validation.net_change,
            regressions: validation.regressions,
            new_passes: validation.new_passes,
            per_entry_results: validation.per_entry_results,
            validation_mode: validation.validation_mode,
            validation_agent: validation.validation_agent,
            validation_evidence_ref: validatedEvidenceRef,
          },
        });

        // Step 12: Evaluate stopping criteria after validation
        const stopping = evaluateStoppingCriteria(
          validation.after_pass_rate,
          previousPassRates,
          iteration + 1,
          maxIterations,
          confidenceThreshold,
          proposal.confidence,
        );
        previousPassRates.push(validation.after_pass_rate);

        if (!validation.improved) {
          feedbackReason = `Validation failed: net_change=${validation.net_change.toFixed(3)}, improved=false`;
          const rejectedEvidenceRef = buildValidationEvidenceRef(proposal.proposal_id, "rejected");
          recordAudit(
            proposal.proposal_id,
            "rejected",
            `Validation failed: net_change=${validation.net_change.toFixed(3)} (stopping: ${stopping.reason})`,
            undefined,
            undefined,
            {
              validation_mode: validation.validation_mode,
              validation_agent: validation.validation_agent,
              validation_evidence_ref: rejectedEvidenceRef,
            },
          );
          recordEvidence({
            timestamp: new Date().toISOString(),
            proposal_id: proposal.proposal_id,
            skill_name: skillName,
            skill_path: skillPath,
            target: "description",
            stage: "rejected",
            rationale: proposal.rationale,
            confidence: proposal.confidence,
            details: `Validation failed: net_change=${validation.net_change.toFixed(3)} (stopping: ${stopping.reason})`,
            validation: {
              improved: validation.improved,
              before_pass_rate: validation.before_pass_rate,
              after_pass_rate: validation.after_pass_rate,
              net_change: validation.net_change,
              regressions: validation.regressions,
              new_passes: validation.new_passes,
              per_entry_results: validation.per_entry_results,
              validation_mode: validation.validation_mode,
              validation_agent: validation.validation_agent,
              validation_evidence_ref: rejectedEvidenceRef,
            },
          });

          // Use stopping criteria to decide whether to return or retry
          if (stopping.shouldStop) {
            finishTui();
            return withStats({
              proposal: lastProposal,
              validation: lastValidation,
              deployed: false,
              auditEntries,
              reason: `Validation failed (${stopping.reason}): net_change=${validation.net_change.toFixed(3)}`,
            });
          }

          continue;
        }

        // Validation passed — check if converged or continue
        if (stopping.shouldStop && stopping.reason.includes("Converged")) {
          recordAudit(proposal.proposal_id, "validated", `Stopping early: ${stopping.reason}`);
        }

        // Validation passed - break out of retry loop
        break;
      }
    }

    // -----------------------------------------------------------------------
    // Step 13: Dry run check
    // -----------------------------------------------------------------------
    if (dryRun) {
      finishTui();
      return withStats({
        proposal: lastProposal,
        validation: lastValidation,
        deployed: false,
        auditEntries,
        reason: "Dry run - proposal validated but not deployed",
      });
    }

    // -----------------------------------------------------------------------
    // Step 13b: Baseline gate (--with-baseline)
    // -----------------------------------------------------------------------
    let baselineResult: BaselineMeasurement | undefined;
    if (options.withBaseline && lastProposal) {
      tui.step("Measuring baseline...");
      baselineResult = await _measureBaseline({
        evalSet,
        skillDescription: currentDescription,
        skillName,
        agent,
        modelFlag: options.validationModel,
      });
      tui.done(
        `Baseline: lift=${baselineResult.lift.toFixed(3)}, adds_value=${baselineResult.adds_value}`,
      );

      recordAudit(
        lastProposal.proposal_id,
        "validated",
        `Baseline check: lift=${baselineResult.lift.toFixed(3)}, adds_value=${baselineResult.adds_value}`,
      );

      if (!baselineResult.adds_value) {
        recordAudit(
          lastProposal.proposal_id,
          "rejected",
          `Baseline gate failed: lift=${baselineResult.lift.toFixed(3)} below 0.05 threshold`,
        );
        recordEvidence({
          timestamp: new Date().toISOString(),
          proposal_id: lastProposal.proposal_id,
          skill_name: skillName,
          skill_path: skillPath,
          target: "description",
          stage: "rejected",
          rationale: lastProposal.rationale,
          confidence: lastProposal.confidence,
          details: `Baseline gate failed: lift=${baselineResult.lift.toFixed(3)} below 0.05 threshold`,
          validation: {
            improved: false,
            net_change: baselineResult.lift,
          },
        });
        finishTui();
        return withStats({
          proposal: lastProposal,
          validation: lastValidation,
          deployed: false,
          auditEntries,
          reason: `Baseline gate failed: lift=${baselineResult.lift.toFixed(3)} below 0.05 threshold`,
          baselineResult,
        });
      }
    }

    // -----------------------------------------------------------------------
    // Step 13c: Gate validation (--cheap-loop / --gate-model)
    // -----------------------------------------------------------------------
    let gateValidation: ValidationResult | undefined;
    if (options.gateModel && lastProposal && lastValidation?.improved) {
      const gateDecision = resolveGateDecision(
        options,
        lastProposal,
        lastValidation,
        currentDescription,
        confidenceThreshold,
      );
      const gateLabel = gateDecision?.effort
        ? `${gateDecision.model}, effort=${gateDecision.effort}`
        : (gateDecision?.model ?? options.gateModel);
      tui.step(`Gate validation (${gateLabel})...`);
      gateValidation = await _gateValidateProposal(
        lastProposal,
        evalSet,
        agent,
        gateDecision?.model ?? options.gateModel,
        gateDecision?.effort,
      );
      llmCallCount += countValidationLlmCalls(evalSet.length);
      tui.done(
        `Gate (${gateLabel}): improved=${gateValidation.improved}, net_change=${gateValidation.net_change.toFixed(3)}`,
      );

      const gatePrefix =
        gateDecision && gateDecision.riskSignals.length > 0
          ? `Adaptive gate [${gateDecision.riskSignals.join(", ")}]`
          : "Gate validation";

      if (!gateValidation.improved) {
        recordAudit(
          lastProposal.proposal_id,
          "rejected",
          `${gatePrefix} failed (${gateLabel}): net_change=${gateValidation.net_change.toFixed(3)}`,
        );
        recordEvidence({
          timestamp: new Date().toISOString(),
          proposal_id: lastProposal.proposal_id,
          skill_name: skillName,
          skill_path: skillPath,
          target: "description",
          stage: "rejected",
          rationale: lastProposal.rationale,
          confidence: lastProposal.confidence,
          details: `${gatePrefix} failed (${gateLabel}): net_change=${gateValidation.net_change.toFixed(3)}`,
          validation: {
            improved: gateValidation.improved,
            before_pass_rate: gateValidation.before_pass_rate,
            after_pass_rate: gateValidation.after_pass_rate,
            net_change: gateValidation.net_change,
            regressions: gateValidation.regressions,
            new_passes: gateValidation.new_passes,
            per_entry_results: gateValidation.per_entry_results,
          },
        });
        finishTui();
        return withStats({
          proposal: lastProposal,
          validation: lastValidation,
          deployed: false,
          auditEntries,
          reason: `${gatePrefix} failed (${gateLabel}): net_change=${gateValidation.net_change.toFixed(3)}`,
          gateValidation,
          ...(baselineResult ? { baselineResult } : {}),
        });
      }

      recordAudit(
        lastProposal.proposal_id,
        "validated",
        `${gatePrefix} (${gateLabel}): improved=${gateValidation.improved}, net_change=${gateValidation.net_change.toFixed(3)}`,
      );
    }

    // -----------------------------------------------------------------------
    // Step 14: Deploy — write updated description to SKILL.md
    // -----------------------------------------------------------------------
    if (lastProposal && lastValidation?.improved) {
      // Create backup before modifying
      const backupPath = `${skillPath}.bak`;
      copyFileSync(skillPath, backupPath);
      tui.done(`Backup created at ${backupPath}`);

      // Replace the description (handles both frontmatter and plain markdown)
      const updatedContent = replaceDescription(rawContent, lastProposal.proposed_description);
      writeFileSync(skillPath, updatedContent, "utf-8");
      tui.done(`Deployed updated description to ${skillPath}`);

      // Show what changed in the skill file
      const diffOutput = formatSimpleDiff(rawContent, updatedContent);
      if (diffOutput) {
        console.error("\n--- Skill description diff ---");
        console.error(diffOutput);
        console.error("------------------------------\n");
      }

      recordAudit(
        lastProposal.proposal_id,
        "deployed",
        `Deployed proposal for ${skillName}`,
        {
          total: evalSet.length,
          passed: Math.round(lastValidation.after_pass_rate * evalSet.length),
          failed: evalSet.length - Math.round(lastValidation.after_pass_rate * evalSet.length),
          pass_rate: lastValidation.after_pass_rate,
        },
        iterationsCompleted,
        {
          validation_mode: lastValidation.validation_mode,
          validation_agent: lastValidation.validation_agent,
          validation_evidence_ref: buildValidationEvidenceRef(lastProposal.proposal_id, "deployed"),
        },
      );
      recordEvidence({
        timestamp: new Date().toISOString(),
        proposal_id: lastProposal.proposal_id,
        skill_name: skillName,
        skill_path: skillPath,
        target: "description",
        stage: "deployed",
        rationale: lastProposal.rationale,
        confidence: lastProposal.confidence,
        details: `Deployed proposal for ${skillName}`,
        validation: {
          improved: lastValidation.improved,
          before_pass_rate: lastValidation.before_pass_rate,
          after_pass_rate: lastValidation.after_pass_rate,
          net_change: lastValidation.net_change,
          regressions: lastValidation.regressions,
          new_passes: lastValidation.new_passes,
          per_entry_results: lastValidation.per_entry_results,
          validation_mode: lastValidation.validation_mode,
          validation_agent: lastValidation.validation_agent,
          validation_evidence_ref: buildValidationEvidenceRef(lastProposal.proposal_id, "deployed"),
        },
      });
    }

    // -----------------------------------------------------------------------
    // Step 15: Update evolution memory
    // -----------------------------------------------------------------------
    const wasDeployed = lastProposal && lastValidation?.improved;
    const evolveResult: EvolveResult = withStats({
      proposal: lastProposal,
      validation: lastValidation,
      deployed: wasDeployed,
      auditEntries,
      reason: wasDeployed
        ? "Evolution deployed successfully"
        : "Evolution not deployed: proposal or validation missing",
      ...(skillVersion ? { skillVersion } : {}),
      ...(baselineResult ? { baselineResult } : {}),
      ...(gateValidation ? { gateValidation } : {}),
    });

    if (lastProposal) {
      try {
        _updateContextAfterEvolve(skillName, lastProposal, evolveResult);
      } catch {
        // Memory writes should never fail the main operation
      }
    }

    // -----------------------------------------------------------------------
    // Step 16: Return complete result
    // -----------------------------------------------------------------------
    finishTui();
    return evolveResult;
  } catch (error) {
    tui.destroy();
    // Robust error handling: preserve partial results so callers can inspect progress
    const errorMessage = error instanceof Error ? error.message : String(error);
    return withStats({
      proposal: lastProposal,
      validation: lastValidation,
      deployed: false,
      auditEntries,
      reason: `Error during evolution: ${errorMessage}`,
    });
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      skill: { type: "string" },
      "skill-path": { type: "string" },
      "eval-set": { type: "string" },
      agent: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      confidence: { type: "string", default: "0.6" },
      "max-iterations": { type: "string", default: "3" },
      pareto: { type: "boolean", default: true },
      candidates: { type: "string", default: "3" },
      "token-efficiency": { type: "boolean", default: false },
      "with-baseline": { type: "boolean", default: false },
      "validation-model": { type: "string", default: "haiku" },
      "cheap-loop": { type: "boolean", default: true },
      "full-model": { type: "boolean", default: false },
      "gate-model": { type: "string" },
      "gate-effort": { type: "string" },
      "proposal-model": { type: "string" },
      "adaptive-gate": { type: "boolean", default: false },
      "sync-first": { type: "boolean", default: false },
      "sync-force": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune evolve — Evolve a skill description via failure patterns

Usage:
  selftune evolve --skill <name> --skill-path <path> [options]

Options:
  --skill             Skill name (required)
  --skill-path        Path to SKILL.md (required)
  --eval-set          Path to eval set JSON (optional, builds from logs if omitted)
  --agent             Agent CLI to use (claude, codex, opencode)
  --dry-run           Validate proposal without deploying
  --confidence        Confidence threshold 0.0-1.0 (default: 0.6)
  --max-iterations    Max retry iterations (default: 3)
  --pareto            Enable Pareto multi-candidate selection
  --candidates        Number of candidates to generate (default: 3, max: 5)
  --token-efficiency  Enable 5D Pareto with token efficiency scoring
  --with-baseline     Gate deployment on baseline lift > 0.05
  --validation-model  Model for trigger-check validation calls (default: haiku)
  --cheap-loop        Use cheap models for loop, expensive for gate (default: on)
  --full-model        Use same model for all stages (disables cheap-loop)
  --gate-model        Model for final gate validation (default: sonnet)
  --gate-effort       Thinking effort for final gate (low|medium|high|max)
  --adaptive-gate     Escalate risky gate checks to opus + high effort
  --proposal-model    Model for proposal generation LLM calls
  --sync-first        Refresh source-truth telemetry before building evals/failure patterns
  --sync-force        Force a full rescan during --sync-first
  --verbose           Output full EvolveResult JSON (default: compact summary)
  --help              Show this help message`);
    process.exit(0);
  }

  if (!values.skill || !values["skill-path"]) {
    throw new CLIError(
      "--skill and --skill-path are required",
      "MISSING_FLAG",
      "selftune evolve --skill <name> --skill-path <path>",
    );
  }
  if ((values["sync-force"] ?? false) && !(values["sync-first"] ?? false)) {
    throw new CLIError(
      "--sync-force requires --sync-first",
      "INVALID_FLAG",
      "Add --sync-first when using --sync-force",
    );
  }
  if (values["gate-effort"] && !["low", "medium", "high", "max"].includes(values["gate-effort"])) {
    throw new CLIError(
      `Invalid --gate-effort value: ${values["gate-effort"]}`,
      "INVALID_FLAG",
      "Use one of: low, medium, high, max",
    );
  }
  if (
    (values["gate-effort"] || values["adaptive-gate"]) &&
    (values["full-model"] ?? false) &&
    !values["gate-model"]
  ) {
    throw new CLIError(
      "--gate-effort and --adaptive-gate require --gate-model when --full-model is set",
      "INVALID_FLAG",
      "Add --gate-model <model> or drop --full-model",
    );
  }

  const { detectAgent } = await import("../utils/llm-call.js");
  const requestedAgent = values.agent;
  if (requestedAgent && !Bun.which(requestedAgent)) {
    throw new CLIError(
      `Agent CLI '${requestedAgent}' not found in PATH.`,
      "AGENT_NOT_FOUND",
      "Install it or omit --agent to use auto-detection.",
    );
  }
  const agent = requestedAgent ?? detectAgent();
  if (!agent) {
    throw new CLIError(
      "No agent CLI (claude/codex/opencode) found in PATH.",
      "AGENT_NOT_FOUND",
      "Install Claude Code, Codex, or OpenCode.",
    );
  }

  // -------------------------------------------------------------------------
  // Pre-flight validation: catch common misconfigurations before evolve()
  // -------------------------------------------------------------------------
  const skillPath = values["skill-path"];
  if (!skillPath) {
    throw new CLIError(
      "--skill-path is required.",
      "MISSING_FLAG",
      "selftune evolve --skill <name> --skill-path <path>",
    );
  }
  if (!existsSync(skillPath)) {
    throw new CLIError(
      `SKILL.md not found at: ${skillPath}`,
      "FILE_NOT_FOUND",
      "Verify the --skill-path argument points to an existing SKILL.md file.",
    );
  }

  const evalSetPath = values["eval-set"];
  if (evalSetPath && !existsSync(evalSetPath)) {
    throw new CLIError(
      `Eval set file not found at: ${evalSetPath}`,
      "FILE_NOT_FOUND",
      "Verify the --eval-set argument points to an existing JSON file.",
    );
  }

  // If no eval-set provided, check that log files exist for auto-generation
  if (!evalSetPath && !(values["sync-first"] ?? false)) {
    const dbCheck = getDb();
    const hasSkillLog = querySkillUsageRecords(dbCheck).length > 0;
    const hasQueryLog = existsSync(QUERY_LOG);
    if (!hasSkillLog && !hasQueryLog) {
      throw new CLIError(
        `No eval set provided and no telemetry logs found. Expected logs at: ${SKILL_LOG} and ${QUERY_LOG}`,
        "MISSING_DATA",
        "Either pass --eval-set <path> or generate logs first by using selftune-enabled skills.",
      );
    }
  }

  const tokenEfficiencyEnabled = values["token-efficiency"] ?? false;
  let telemetryRecords: SessionTelemetryRecord[] | undefined;
  if (tokenEfficiencyEnabled && !(values["sync-first"] ?? false)) {
    const dbTel2 = getDb();
    telemetryRecords = querySessionTelemetry(dbTel2) as SessionTelemetryRecord[];
  }
  const gradingResults = readGradingResultsForSkill(values.skill);

  if (values.verbose) {
    console.error("[verbose] Pre-flight checks passed");
    console.error(`[verbose] Skill: ${values.skill}`);
    console.error(`[verbose] Skill path: ${skillPath}`);
    console.error(`[verbose] Agent: ${agent}`);
    console.error(`[verbose] Eval set: ${evalSetPath ?? "(auto-generated from logs)"}`);
    console.error(`[verbose] Loaded grading results: ${gradingResults.length}`);
    console.error(`[verbose] Cheap loop: ${values["cheap-loop"] ?? false}`);
    console.error(`[verbose] Dry run: ${values["dry-run"] ?? false}`);
    console.error(`[verbose] Sync first: ${values["sync-first"] ?? false}`);
    console.error(`[verbose] Sync force: ${values["sync-force"] ?? false}`);
    console.error(`[verbose] Adaptive gate: ${values["adaptive-gate"] ?? false}`);
    console.error(`[verbose] Gate effort: ${values["gate-effort"] ?? "(default)"}`);
  }

  const result = await evolve({
    skillName: values.skill,
    skillPath: values["skill-path"],
    evalSetPath: values["eval-set"],
    agent,
    dryRun: values["dry-run"] ?? false,
    confidenceThreshold: Number.parseFloat(values.confidence ?? "0.6"),
    maxIterations: Number.parseInt(values["max-iterations"] ?? "3", 10),
    paretoEnabled: values.pareto ?? false,
    candidateCount: Number.parseInt(values.candidates ?? "3", 10),
    tokenEfficiencyEnabled,
    telemetryRecords,
    withBaseline: values["with-baseline"] ?? false,
    validationModel: values["validation-model"],
    cheapLoop: (values["cheap-loop"] ?? true) && !(values["full-model"] ?? false),
    gateModel: values["gate-model"],
    gateEffort: values["gate-effort"] as EffortLevel | undefined,
    proposalModel: values["proposal-model"],
    adaptiveGate: values["adaptive-gate"] ?? false,
    gradingResults,
    syncFirst: values["sync-first"] ?? false,
    syncForce: values["sync-force"] ?? false,
  });

  if (values.verbose) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const summary: EvolveResultSummary = {
      skill: values.skill,
      deployed: result.deployed,
      reason: result.reason,
      before: result.validation?.before_pass_rate ?? 0,
      after: result.validation?.after_pass_rate ?? 0,
      net_change: result.validation?.net_change ?? 0,
      improved: result.validation?.improved ?? false,
      regressions: result.validation?.regressions.length ?? 0,
      new_passes: result.validation?.new_passes.length ?? 0,
      confidence: result.proposal?.confidence ?? 0,
      llm_calls: result.llmCallCount,
      elapsed_s: +(result.elapsedMs / 1000).toFixed(1),
      proposal_id: result.proposal?.proposal_id ?? "",
      rationale: result.proposal?.rationale ?? "",
      ...(result.skillVersion ? { version: result.skillVersion } : {}),
      dashboard_url: `http://localhost:3141/report/${encodeURIComponent(values.skill)}`,
      ...(result.descriptionQualityBefore != null
        ? { description_quality_before: result.descriptionQualityBefore }
        : {}),
      ...(result.descriptionQualityAfter != null
        ? { description_quality_after: result.descriptionQualityAfter }
        : {}),
      ...(!result.deployed
        ? {
            suggestions: buildUnblockSuggestions(result, values.skill),
          }
        : {}),
    };
    console.log(JSON.stringify(summary, null, 2));
  }

  // Print human-readable status to stderr so agents always see outcome + next steps
  if (!result.deployed) {
    console.error(`\n[NOT DEPLOYED] ${result.reason}`);
    if (result.validation && !result.validation.improved) {
      console.error(
        `  Pass rate: ${(result.validation.before_pass_rate * 100).toFixed(1)}% -> ${(result.validation.after_pass_rate * 100).toFixed(1)}% (net: ${result.validation.net_change >= 0 ? "+" : ""}${(result.validation.net_change * 100).toFixed(1)}%)`,
      );
      if (result.validation.regressions.length > 0) {
        console.error(`  Regressions: ${result.validation.regressions.length} entries`);
      }
    }
    if (
      result.proposal &&
      result.proposal.confidence < Number.parseFloat(values.confidence ?? "0.6")
    ) {
      console.error(
        `  Confidence ${result.proposal.confidence.toFixed(2)} below threshold ${values.confidence ?? "0.6"}`,
      );
    }
    // Targeted suggestions based on specific failure reason
    const suggestions = buildUnblockSuggestions(result, values.skill);
    if (suggestions.length > 0) {
      console.error("\n  Next steps:");
      for (const s of suggestions) {
        console.error(`    → ${s}`);
      }
    }
  } else {
    console.error(`\n[DEPLOYED] ${result.reason}`);
    // Show quality improvement if available
    if (result.descriptionQualityBefore != null && result.descriptionQualityAfter != null) {
      const delta = result.descriptionQualityAfter - result.descriptionQualityBefore;
      if (delta !== 0) {
        console.error(
          `  Description quality: ${Math.round(result.descriptionQualityBefore * 100)}% → ${Math.round(result.descriptionQualityAfter * 100)}% (${delta >= 0 ? "+" : ""}${Math.round(delta * 100)}%)`,
        );
      }
    }
  }

  process.exit(result.deployed ? 0 : 1);
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
