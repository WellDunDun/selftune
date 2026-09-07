/** Evolution pipeline orchestration. */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as Schema from "effect/Schema";

import type { BaselineMeasurement } from "../../eval/baseline.js";
import { measureBaseline } from "../../eval/baseline.js";
import { buildEvalSet } from "../../eval/hooks-to-evals.js";
import { getDb } from "../../localdb/db.js";
import {
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "../../localdb/queries.js";
import { updateContextAfterEvolve } from "../../memory/writer.js";
import type { SyncResult } from "@selftune/source-management/sync";
import type {
  EvalPassRate,
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  EvolutionProposal,
  FailurePattern,
  ParetoCandidate,
} from "../../types.js";
import { EvalEntry } from "../../types/evaluation.js";
import { CLIError } from "../../utils/cli-error.js";
import { parseFrontmatter, replaceDescription } from "../../utils/frontmatter.js";
import { createEvolveTUI } from "../../utils/tui.js";
import { appendAuditEntry } from "../audit.js";
import { checkConstitution } from "../constitutional.js";
import { scoreDescription } from "../description-quality.js";
import { appendEvidenceEntry, buildValidationEvidenceRef } from "../evidence.js";
import { extractFailurePatterns } from "../extract-patterns.js";
import {
  computeInvocationScores,
  computeParetoFrontier,
  computeTokenEfficiencyScore,
  selectFromFrontier,
} from "../pareto.js";
import { generateMultipleProposals, generateProposal } from "../propose-description.js";
import { evaluateStoppingCriteria } from "../stopping-criteria.js";
import { DEFAULT_VALIDATION_STRATEGY } from "../validation-contract.js";
import type { ValidationResult } from "../validate-proposal.js";
import {
  TRIGGER_CHECK_BATCH_SIZE,
  VALIDATION_RUNS,
  validateProposal,
} from "../validate-proposal.js";
import type { EvolveDeps, EvolveOptions, EvolveResult } from "./contracts.js";
import { computeAggregateMetrics } from "./analysis.js";
import { createAuditEntry, formatSimpleDiff } from "./output.js";
import { countValidationLlmCalls, resolveGateDecision, validateWithMode } from "./validation.js";

export async function evolve(
  options: EvolveOptions,
  _deps: EvolveDeps = {},
): Promise<EvolveResult> {
  const { skillName, skillPath, evalSetPath, agent, dryRun, confidenceThreshold, maxIterations } =
    options;
  const effectiveValidationMode = options.validationMode ?? DEFAULT_VALIDATION_STRATEGY;

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
      return querySkillUsageRecords(db);
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
    const result: EvolveResult = {
      ...r,
      llmCallCount,
      elapsedMs: Date.now() - pipelineStart,
    };
    if (syncResult) result.sync_result = syncResult;
    if (descQualityBeforeScore != null) result.descriptionQualityBefore = descQualityBeforeScore;
    if (descQualityAfterScore != null) result.descriptionQualityAfter = descQualityAfterScore;
    return result;
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
      const syncRunner = _deps.syncSources;
      if (!syncRunner) {
        throw new CLIError(
          "Source sync is not configured for this runtime.",
          "OPERATION_FAILED",
          "Run this command through the SelfTune CLI composition root.",
        );
      }
      syncResult = await syncRunner({ force: options.syncForce ?? false });
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

    if (evalSetPath) {
      try {
        const raw = readFileSync(evalSetPath, "utf-8");
        evalSet = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.mutable(Schema.Array(EvalEntry))),
        )(raw);
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
    } else {
      // Build from logs
      const dbForQuery = getDb();
      const queryRecords = queryQueryLog(dbForQuery);
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
    const aggregateMetrics = computeAggregateMetrics(options.gradingResults);

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
            return querySessionTelemetry(dbTel);
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

      // Validate each candidate
      const paretoCandidates: ParetoCandidate[] = [];
      for (const proposal of candidates) {
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

        const { result: validation, modeUsed: paretoModeUsed } = await validateWithMode(
          effectiveValidationMode,
          proposal,
          evalSet,
          agent,
          options.replayOptions,
          _validateProposal,
          options.validationModel,
        );
        if (paretoModeUsed === "llm_judge") {
          llmCallCount += countValidationLlmCalls(evalSet.length);
        }
        const evidenceRef = buildValidationEvidenceRef(proposal.proposal_id, "validated");
        recordAudit(
          proposal.proposal_id,
          "validated",
          `Pareto validation (${paretoModeUsed}): improved=${validation.improved}${
            validation.validation_fallback_reason
              ? ` (replay fallback: ${validation.validation_fallback_reason})`
              : ""
          }`,
          undefined,
          undefined,
          {
            validation_mode: paretoModeUsed,
            validation_agent: validation.validation_agent,
            validation_fixture_id: validation.validation_fixture_id,
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
          details: `Pareto validation: improved=${validation.improved}${
            validation.validation_fallback_reason
              ? ` (replay fallback: ${validation.validation_fallback_reason})`
              : ""
          }`,
          validation: {
            improved: validation.improved,
            before_pass_rate: validation.before_pass_rate,
            after_pass_rate: validation.after_pass_rate,
            net_change: validation.net_change,
            regressions: validation.regressions,
            new_passes: validation.new_passes,
            per_entry_results: validation.per_entry_results,
            before_entry_results: validation.before_entry_results,
            validation_mode: validation.validation_mode,
            validation_agent: validation.validation_agent,
            validation_fixture_id: validation.validation_fixture_id,
            validation_fallback_reason: validation.validation_fallback_reason,
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
          proposal: candidates[0] ?? null,
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
          // evaluateStoppingCriteria() with the current iteration/maxIterations.
          const constitutionStop = evaluateStoppingCriteria(
            previousPassRates.at(-1) ?? 0,
            previousPassRates.slice(0, -1),
            iteration + 1,
            maxIterations,
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

        // Step 9: Validate against eval set
        const batchCount = Math.ceil(evalSet.length / TRIGGER_CHECK_BATCH_SIZE);
        tui.step(
          `Validating ${evalSet.length} entries (mode=${effectiveValidationMode}, ${batchCount} batches, ${VALIDATION_RUNS}x majority-vote)...`,
        );
        const { result: validation, modeUsed: retryModeUsed } = await validateWithMode(
          effectiveValidationMode,
          proposal,
          evalSet,
          agent,
          options.replayOptions,
          _validateProposal,
          options.validationModel,
        );
        lastValidation = validation;
        if (retryModeUsed === "llm_judge") {
          llmCallCount += countValidationLlmCalls(evalSet.length);
        }
        tui.done(
          `Validation: ${(validation.before_pass_rate * 100).toFixed(1)}% \u2192 ${(validation.after_pass_rate * 100).toFixed(1)}% (improved: ${validation.improved})`,
        );

        // Step 10: Audit "validated"
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
          `Validation complete (${retryModeUsed}): improved=${validation.improved}${
            validation.validation_fallback_reason
              ? ` (replay fallback: ${validation.validation_fallback_reason})`
              : ""
          }`,
          evalSnapshot,
          undefined,
          {
            validation_mode: retryModeUsed,
            validation_agent: validation.validation_agent,
            validation_fixture_id: validation.validation_fixture_id,
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
          details: `Validation complete (${retryModeUsed}): improved=${validation.improved}${
            validation.validation_fallback_reason
              ? ` (replay fallback: ${validation.validation_fallback_reason})`
              : ""
          }`,
          validation: {
            improved: validation.improved,
            before_pass_rate: validation.before_pass_rate,
            after_pass_rate: validation.after_pass_rate,
            net_change: validation.net_change,
            regressions: validation.regressions,
            new_passes: validation.new_passes,
            per_entry_results: validation.per_entry_results,
            before_entry_results: validation.before_entry_results,
            validation_mode: retryModeUsed,
            validation_agent: validation.validation_agent,
            validation_fixture_id: validation.validation_fixture_id,
            validation_fallback_reason: validation.validation_fallback_reason,
            validation_evidence_ref: validatedEvidenceRef,
          },
        });

        // Step 11: Evaluate stopping criteria after validation
        const stopping = evaluateStoppingCriteria(
          validation.after_pass_rate,
          previousPassRates,
          iteration + 1,
          maxIterations,
        );
        previousPassRates.push(validation.after_pass_rate);

        if (!validation.improved) {
          feedbackReason = `Validation failed: net_change=${validation.net_change.toFixed(3)}, improved=false`;
          const rejectedEvidenceRef = buildValidationEvidenceRef(proposal.proposal_id, "rejected");
          recordAudit(
            proposal.proposal_id,
            "rejected",
            `Validation failed (${retryModeUsed}): net_change=${validation.net_change.toFixed(3)} (stopping: ${stopping.reason})`,
            undefined,
            undefined,
            {
              validation_mode: retryModeUsed,
              validation_agent: validation.validation_agent,
              validation_fixture_id: validation.validation_fixture_id,
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
            details: `Validation failed (${retryModeUsed}): net_change=${validation.net_change.toFixed(3)} (stopping: ${stopping.reason})`,
            validation: {
              improved: validation.improved,
              before_pass_rate: validation.before_pass_rate,
              after_pass_rate: validation.after_pass_rate,
              net_change: validation.net_change,
              regressions: validation.regressions,
              new_passes: validation.new_passes,
              per_entry_results: validation.per_entry_results,
              before_entry_results: validation.before_entry_results,
              validation_mode: retryModeUsed,
              validation_agent: validation.validation_agent,
              validation_fixture_id: validation.validation_fixture_id,
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
          recordAudit(
            proposal.proposal_id,
            "validated",
            `Stopping early: ${stopping.reason}`,
            undefined,
            undefined,
            {
              validation_mode: retryModeUsed,
              validation_agent: validation.validation_agent,
              validation_fixture_id: validation.validation_fixture_id,
            },
          );
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
            before_entry_results: gateValidation.before_entry_results,
            validation_mode: gateValidation.validation_mode,
            validation_agent: gateValidation.validation_agent,
            validation_fixture_id: gateValidation.validation_fixture_id,
            validation_fallback_reason: gateValidation.validation_fallback_reason,
          },
        });
        finishTui();
        const result = withStats({
          proposal: lastProposal,
          validation: lastValidation,
          deployed: false,
          auditEntries,
          reason: `${gatePrefix} failed (${gateLabel}): net_change=${gateValidation.net_change.toFixed(3)}`,
          gateValidation,
        });
        if (baselineResult) result.baselineResult = baselineResult;
        return result;
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
        `Deployed proposal for ${skillName}${
          lastValidation.validation_fallback_reason
            ? ` (replay fallback: ${lastValidation.validation_fallback_reason})`
            : ""
        }`,
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
          validation_fixture_id: lastValidation.validation_fixture_id,
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
        details: `Deployed proposal for ${skillName}${
          lastValidation.validation_fallback_reason
            ? ` (replay fallback: ${lastValidation.validation_fallback_reason})`
            : ""
        }`,
        validation: {
          improved: lastValidation.improved,
          before_pass_rate: lastValidation.before_pass_rate,
          after_pass_rate: lastValidation.after_pass_rate,
          net_change: lastValidation.net_change,
          regressions: lastValidation.regressions,
          new_passes: lastValidation.new_passes,
          per_entry_results: lastValidation.per_entry_results,
          before_entry_results: lastValidation.before_entry_results,
          validation_mode: lastValidation.validation_mode,
          validation_agent: lastValidation.validation_agent,
          validation_fixture_id: lastValidation.validation_fixture_id,
          validation_fallback_reason: lastValidation.validation_fallback_reason,
          validation_evidence_ref: buildValidationEvidenceRef(lastProposal.proposal_id, "deployed"),
        },
      });
    }

    // -----------------------------------------------------------------------
    // Step 15: Update evolution memory
    // -----------------------------------------------------------------------
    const wasDeployed = Boolean(lastProposal && lastValidation?.improved);
    const evolveResult: EvolveResult = withStats({
      proposal: lastProposal,
      validation: lastValidation,
      deployed: wasDeployed,
      auditEntries,
      reason: wasDeployed
        ? "Evolution deployed successfully"
        : "Evolution not deployed: proposal or validation missing",
    });
    if (skillVersion) evolveResult.skillVersion = skillVersion;
    if (baselineResult) evolveResult.baselineResult = baselineResult;
    if (gateValidation) evolveResult.gateValidation = gateValidation;

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
