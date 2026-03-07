/**
 * evolve.ts
 *
 * Evolution orchestrator: coordinates failure pattern extraction, proposal
 * generation, validation, and deployment into a single pipeline with retry
 * logic and comprehensive audit tracking.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "../constants.js";
import type { BaselineMeasurement } from "../eval/baseline.js";
import { measureBaseline } from "../eval/baseline.js";
import { buildEvalSet } from "../eval/hooks-to-evals.js";
import { updateContextAfterEvolve } from "../memory/writer.js";
import type {
  EvalEntry,
  EvalPassRate,
  EvolutionAuditEntry,
  EvolutionProposal,
  EvolveResultSummary,
  FailurePattern,
  GradingResult,
  ParetoCandidate,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { parseFrontmatter, replaceFrontmatterDescription } from "../utils/frontmatter.js";
import { readJsonl } from "../utils/jsonl.js";
import { createEvolveTUI } from "../utils/tui.js";
import { appendAuditEntry } from "./audit.js";
import { extractFailurePatterns } from "./extract-patterns.js";
import {
  computeInvocationScores,
  computeParetoFrontier,
  computeTokenEfficiencyScore,
  selectFromFrontier,
} from "./pareto.js";
import { generateMultipleProposals, generateProposal } from "./propose-description.js";
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
  proposalModel?: string;
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
  buildEvalSet?: typeof import("../eval/hooks-to-evals.js").buildEvalSet;
  updateContextAfterEvolve?: typeof import("../memory/writer.js").updateContextAfterEvolve;
  measureBaseline?: typeof import("../eval/baseline.js").measureBaseline;
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

function createAuditEntry(
  proposalId: string,
  action: EvolutionAuditEntry["action"],
  details: string,
  evalSnapshot?: EvalPassRate,
): EvolutionAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    proposal_id: proposalId,
    action,
    details,
    ...(evalSnapshot ? { eval_snapshot: evalSnapshot } : {}),
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
  const _buildEvalSet = _deps.buildEvalSet ?? buildEvalSet;
  const _updateContextAfterEvolve = _deps.updateContextAfterEvolve ?? updateContextAfterEvolve;
  const _measureBaseline = _deps.measureBaseline ?? measureBaseline;

  const auditEntries: EvolutionAuditEntry[] = [];

  function recordAudit(
    proposalId: string,
    action: EvolutionAuditEntry["action"],
    details: string,
    evalSnapshot?: EvalPassRate,
  ): void {
    const entry = createAuditEntry(proposalId, action, details, evalSnapshot);
    auditEntries.push(entry);
    try {
      _appendAuditEntry(entry);
    } catch {
      // Fail-open: audit write failures should not break the pipeline
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
  const withStats = (r: Omit<EvolveResult, "llmCallCount" | "elapsedMs">): EvolveResult => ({
    ...r,
    llmCallCount,
    elapsedMs: Date.now() - pipelineStart,
  });

  // Hoisted so catch block can preserve partial results on error
  let lastProposal: EvolutionProposal | null = null;
  let lastValidation: ValidationResult | null = null;

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
    tui.done(`Loaded SKILL.md (desc: ${currentDescription.length} chars${versionTag})`);

    // -----------------------------------------------------------------------
    // Step 2: Load eval set
    // -----------------------------------------------------------------------
    let evalSet: EvalEntry[];

    if (evalSetPath && existsSync(evalSetPath)) {
      const raw = readFileSync(evalSetPath, "utf-8");
      evalSet = JSON.parse(raw) as EvalEntry[];
    } else {
      // Build from logs
      const skillRecords = readJsonl<SkillUsageRecord>(SKILL_LOG);
      const queryRecords = readJsonl<QueryLogRecord>(QUERY_LOG);
      evalSet = _buildEvalSet(skillRecords, queryRecords, skillName);
    }

    const posCount = evalSet.filter((e) => e.should_trigger).length;
    const negCount = evalSet.filter((e) => !e.should_trigger).length;
    tui.done(`Loaded eval set (${evalSet.length} entries: ${posCount}+, ${negCount}-)`);

    // -----------------------------------------------------------------------
    // Step 3: Load skill usage records
    // -----------------------------------------------------------------------
    const skillUsage = readJsonl<SkillUsageRecord>(SKILL_LOG);

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

    // -----------------------------------------------------------------------
    // Step 5: Early exit if no patterns
    // -----------------------------------------------------------------------
    if (failurePatterns.length === 0) {
      finishTui();
      return withStats({
        proposal: null,
        validation: null,
        deployed: false,
        auditEntries,
        reason: "No failure patterns found",
      });
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
    const paretoEnabled = options.paretoEnabled ?? false;
    const candidateCount = options.candidateCount ?? 3;
    const tokenEfficiencyEnabled = options.tokenEfficiencyEnabled ?? false;

    // Compute token efficiency score if enabled and telemetry is available
    let tokenEffScore: number | undefined;
    if (tokenEfficiencyEnabled && options.telemetryRecords && options.telemetryRecords.length > 0) {
      tokenEffScore = computeTokenEfficiencyScore(skillName, options.telemetryRecords);
      recordAudit(
        "system",
        "created",
        `Token efficiency score for ${skillName}: ${tokenEffScore.toFixed(3)}`,
      );
    }

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
      );

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
        recordAudit(proposal.proposal_id, "created", `Pareto candidate for ${skillName}`);

        const validation = await _validateProposal(
          proposal,
          evalSet,
          agent,
          options.validationModel,
        );
        recordAudit(
          proposal.proposal_id,
          "validated",
          `Pareto validation: improved=${validation.improved}`,
        );

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

      // Skip the standard retry loop — we already have our result
    } else {
      // Standard single-candidate retry loop
      let feedbackReason = "";

      for (let iteration = 0; iteration < maxIterations; iteration++) {
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
        );
        llmCallCount++;

        lastProposal = proposal;
        tui.done(`Proposal generated (conf: ${proposal.confidence.toFixed(2)})`);

        // Step 8: Audit "created"
        recordAudit(
          proposal.proposal_id,
          "created",
          `Proposal created for ${skillName} (iteration ${iteration + 1})`,
        );

        // Step 9: Check confidence threshold
        if (proposal.confidence < confidenceThreshold) {
          feedbackReason = `Confidence ${proposal.confidence} below threshold ${confidenceThreshold}`;
          recordAudit(
            proposal.proposal_id,
            "rejected",
            `Confidence ${proposal.confidence} below threshold ${confidenceThreshold}`,
          );

          // If this is the last iteration, return early with rejection
          if (iteration === maxIterations - 1) {
            finishTui();
            return withStats({
              proposal: lastProposal,
              validation: null,
              deployed: false,
              auditEntries,
              reason: `Confidence ${proposal.confidence} below threshold ${confidenceThreshold}`,
            });
          }

          continue;
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
        llmCallCount += batchCount * 2 * VALIDATION_RUNS;
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
        recordAudit(
          proposal.proposal_id,
          "validated",
          `Validation complete: improved=${validation.improved}`,
          evalSnapshot,
        );

        // Step 12: Check validation result
        if (!validation.improved) {
          feedbackReason = `Validation failed: net_change=${validation.net_change.toFixed(3)}, improved=false`;
          recordAudit(
            proposal.proposal_id,
            "rejected",
            `Validation failed: net_change=${validation.net_change.toFixed(3)}`,
          );

          // If this is the last iteration, return with rejection
          if (iteration === maxIterations - 1) {
            finishTui();
            return withStats({
              proposal: lastProposal,
              validation: lastValidation,
              deployed: false,
              auditEntries,
              reason: `Validation failed after ${maxIterations} iterations: net_change=${validation.net_change.toFixed(3)}`,
            });
          }

          continue;
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
      tui.step(`Gate validation (${options.gateModel})...`);
      gateValidation = await _gateValidateProposal(lastProposal, evalSet, agent, options.gateModel);
      tui.done(
        `Gate (${options.gateModel}): improved=${gateValidation.improved}, net_change=${gateValidation.net_change.toFixed(3)}`,
      );

      recordAudit(
        lastProposal.proposal_id,
        "validated",
        `Gate validation (${options.gateModel}): improved=${gateValidation.improved}, net_change=${gateValidation.net_change.toFixed(3)}`,
      );

      if (!gateValidation.improved) {
        finishTui();
        return withStats({
          proposal: lastProposal,
          validation: lastValidation,
          deployed: false,
          auditEntries,
          reason: `Gate validation failed (${options.gateModel}): net_change=${gateValidation.net_change.toFixed(3)}`,
          gateValidation,
          ...(baselineResult ? { baselineResult } : {}),
        });
      }
    }

    // -----------------------------------------------------------------------
    // Step 14: Deploy — write updated description to SKILL.md
    // -----------------------------------------------------------------------
    if (lastProposal && lastValidation?.improved) {
      // Create backup before modifying
      const backupPath = `${skillPath}.bak`;
      copyFileSync(skillPath, backupPath);
      tui.done(`Backup created at ${backupPath}`);

      // Replace the frontmatter description
      const updatedContent = replaceFrontmatterDescription(
        rawContent,
        lastProposal.proposed_description,
      );
      writeFileSync(skillPath, updatedContent, "utf-8");
      tui.done(`Deployed updated description to ${skillPath}`);

      recordAudit(lastProposal.proposal_id, "deployed", `Deployed proposal for ${skillName}`, {
        total: evalSet.length,
        passed: Math.round(lastValidation.after_pass_rate * evalSet.length),
        failed: evalSet.length - Math.round(lastValidation.after_pass_rate * evalSet.length),
        pass_rate: lastValidation.after_pass_rate,
      });
    }

    // -----------------------------------------------------------------------
    // Step 15: Update evolution memory
    // -----------------------------------------------------------------------
    const wasDeployed = lastProposal !== null && lastValidation !== null && lastValidation.improved;
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
      pareto: { type: "boolean", default: false },
      candidates: { type: "string", default: "3" },
      "token-efficiency": { type: "boolean", default: false },
      "with-baseline": { type: "boolean", default: false },
      "validation-model": { type: "string", default: "haiku" },
      "cheap-loop": { type: "boolean", default: false },
      "gate-model": { type: "string" },
      "proposal-model": { type: "string" },
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
  --cheap-loop        Use cheap models for loop, expensive model for final gate
  --gate-model        Model for final gate validation (default: sonnet when --cheap-loop)
  --proposal-model    Model for proposal generation LLM calls
  --verbose           Output full EvolveResult JSON (default: compact summary)
  --help              Show this help message`);
    process.exit(0);
  }

  if (!values.skill || !values["skill-path"]) {
    console.error("[ERROR] --skill and --skill-path are required");
    process.exit(1);
  }

  const { detectAgent } = await import("../utils/llm-call.js");
  const requestedAgent = values.agent;
  if (requestedAgent && !Bun.which(requestedAgent)) {
    console.error(
      JSON.stringify({
        level: "error",
        code: "agent_not_in_path",
        message: `Agent CLI '${requestedAgent}' not found in PATH.`,
        action: "Install it or omit --agent to use auto-detection.",
      }),
    );
    process.exit(1);
  }
  const agent = requestedAgent ?? detectAgent();
  if (!agent) {
    console.error(
      JSON.stringify({
        level: "error",
        code: "agent_not_found",
        message: "No agent CLI (claude/codex/opencode) found in PATH.",
        action: "Install Claude Code, Codex, or OpenCode.",
      }),
    );
    process.exit(1);
  }

  const tokenEfficiencyEnabled = values["token-efficiency"] ?? false;
  let telemetryRecords: SessionTelemetryRecord[] | undefined;
  if (tokenEfficiencyEnabled) {
    telemetryRecords = readJsonl<SessionTelemetryRecord>(TELEMETRY_LOG);
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
    cheapLoop: values["cheap-loop"] ?? false,
    gateModel: values["gate-model"],
    proposalModel: values["proposal-model"],
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
    };
    console.log(JSON.stringify(summary, null, 2));
  }
  process.exit(result.deployed ? 0 : 1);
}

if (import.meta.main) {
  cliMain().catch((err) => {
    console.error(`[FATAL] ${err}`);
    process.exit(1);
  });
}
