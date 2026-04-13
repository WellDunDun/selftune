/**
 * evolve-body.ts
 *
 * Body evolution orchestrator: coordinates full body or routing-table evolution
 * through a pipeline of proposal generation, 3-gate validation, refinement,
 * and deployment.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { buildEvalSet } from "../eval/hooks-to-evals.js";
import { readGradingResultsForSkill } from "../grading/results.js";
import { getDb } from "../localdb/db.js";
import {
  type ReplayEntryResultInput,
  writeReplayEntryResultsToDb,
} from "../localdb/direct-write.js";
import { queryQueryLog, querySkillUsageRecords } from "../localdb/queries.js";
import type {
  BodyEvolutionProposal,
  BodyValidationResult,
  EvalEntry,
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  EvolutionTarget,
  FailurePattern,
  GradingResult,
  QueryLogRecord,
  SkillUsageRecord,
} from "../types.js";
import { CLIError, handleCLIError } from "../utils/cli-error.js";
import type { EffortLevel, SubagentCallOptions } from "../utils/llm-call.js";
import { callViaSubagent, detectLlmAgent } from "../utils/llm-call.js";
import { appendAuditEntry } from "./audit.js";
import { checkConstitutionSizeOnly } from "./constitutional.js";
import { parseSkillSections, replaceBody, replaceSection } from "./deploy-proposal.js";
import { appendEvidenceEntry, buildValidationEvidenceRef } from "./evidence.js";
import { extractFailurePatterns } from "./extract-patterns.js";
import { type ExecutionContext, generateBodyProposal } from "./propose-body.js";
import { generateRoutingProposal } from "./propose-routing.js";
import { refineBodyProposal } from "./refine-body.js";
import type { BodyValidationOptions } from "./validate-body.js";
import { validateBodyProposal } from "./validate-body.js";
import { buildRuntimeReplayValidationOptions } from "./validate-host-replay.js";
import { validateRoutingProposal } from "./validate-routing.js";
import { DEFAULT_VALIDATION_STRATEGY, type ValidationStrategy } from "./validation-contract.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvolveBodyOptions {
  skillName: string;
  skillPath: string;
  target: EvolutionTarget;
  teacherAgent: string;
  studentAgent: string;
  teacherModel?: string;
  studentModel?: string;
  evalSetPath?: string;
  dryRun: boolean;
  maxIterations: number;
  confidenceThreshold: number;
  taskDescription?: string;
  fewShotExamples?: string[];
  gradingResults?: GradingResult[];
  validationModel?: string;
  validationMode?: ValidationStrategy;
  teacherEffort?: EffortLevel;
  /** Run evolution-reviewer subagent as Gate 4 before deployment. */
  useReviewer?: boolean;
}

export interface EvolveBodyResult {
  proposal: BodyEvolutionProposal | null;
  validation: BodyValidationResult | null;
  deployed: boolean;
  auditEntries: EvolutionAuditEntry[];
  reason: string;
}

/**
 * Injectable dependencies for evolveBody(). When omitted, the real module
 * imports are used. Pass overrides in tests to avoid mock.module().
 */
export interface EvolveBodyDeps {
  extractFailurePatterns?: (
    evalEntries: EvalEntry[],
    skillUsage: SkillUsageRecord[],
    skillName: string,
    gradingResults?: GradingResult[],
  ) => FailurePattern[];
  generateBodyProposal?: typeof import("./propose-body.js").generateBodyProposal;
  generateRoutingProposal?: typeof import("./propose-routing.js").generateRoutingProposal;
  validateBodyProposal?: typeof import("./validate-body.js").validateBodyProposal;
  validateRoutingProposal?: typeof import("./validate-routing.js").validateRoutingProposal;
  refineBodyProposal?: typeof import("./refine-body.js").refineBodyProposal;
  appendAuditEntry?: typeof import("./audit.js").appendAuditEntry;
  appendEvidenceEntry?: typeof import("./evidence.js").appendEvidenceEntry;
  buildEvalSet?: typeof import("../eval/hooks-to-evals.js").buildEvalSet;
  readEffectiveSkillUsageRecords?: () => SkillUsageRecord[];
  readFileSync?: typeof readFileSync;
  writeFileSync?: (path: string, data: string, encoding: string) => void;
  callViaSubagent?: (options: SubagentCallOptions) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

function createAuditEntry(
  proposalId: string,
  action: EvolutionAuditEntry["action"],
  details: string,
  skillName?: string,
  provenance?: Pick<
    EvolutionAuditEntry,
    "validation_mode" | "validation_agent" | "validation_fixture_id" | "validation_evidence_ref"
  >,
): EvolutionAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    proposal_id: proposalId,
    skill_name: skillName,
    action,
    details,
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

// ---------------------------------------------------------------------------
// Pipeline defaults — enforced even when the calling agent omits flags
// ---------------------------------------------------------------------------

/** Default teacher model: Opus 4.6 for highest-quality proposals. */
const DEFAULT_TEACHER_MODEL = "opus";

/** Default student model: Haiku for cheap, fast validation gates. */
const DEFAULT_STUDENT_MODEL = "haiku";

/** Default teacher effort: extended thinking for multi-constraint reasoning. */
const DEFAULT_TEACHER_EFFORT: EffortLevel = "high";

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function evolveBody(
  options: EvolveBodyOptions,
  _deps: EvolveBodyDeps = {},
): Promise<EvolveBodyResult> {
  const {
    skillName,
    skillPath,
    target,
    teacherAgent,
    studentAgent,
    evalSetPath,
    dryRun,
    maxIterations,
    confidenceThreshold,
    fewShotExamples,
  } = options;

  // Apply pipeline defaults for models/effort when not explicitly provided
  const teacherModel = options.teacherModel ?? DEFAULT_TEACHER_MODEL;
  const studentModel = options.studentModel ?? DEFAULT_STUDENT_MODEL;
  const teacherEffort = options.teacherEffort ?? DEFAULT_TEACHER_EFFORT;
  const effectiveValidationMode = options.validationMode ?? DEFAULT_VALIDATION_STRATEGY;

  // Resolve injectable dependencies
  const _extractFailurePatterns = _deps.extractFailurePatterns ?? extractFailurePatterns;
  const _generateBodyProposal = _deps.generateBodyProposal ?? generateBodyProposal;
  const _generateRoutingProposal = _deps.generateRoutingProposal ?? generateRoutingProposal;
  const _validateBodyProposal = _deps.validateBodyProposal ?? validateBodyProposal;
  const _validateRoutingProposal = _deps.validateRoutingProposal ?? validateRoutingProposal;
  const _refineBodyProposal = _deps.refineBodyProposal ?? refineBodyProposal;
  const _appendAuditEntry = _deps.appendAuditEntry ?? appendAuditEntry;
  const _appendEvidenceEntry = _deps.appendEvidenceEntry ?? appendEvidenceEntry;
  const _buildEvalSet = _deps.buildEvalSet ?? buildEvalSet;
  const _readEffectiveSkillUsageRecords =
    _deps.readEffectiveSkillUsageRecords ??
    (() => {
      const db = getDb();
      return querySkillUsageRecords(db) as SkillUsageRecord[];
    });
  const _readFileSync = _deps.readFileSync ?? readFileSync;
  const _writeFileSync = _deps.writeFileSync ?? (await import("node:fs")).writeFileSync;
  const _callViaSubagent = _deps.callViaSubagent ?? callViaSubagent;

  const auditEntries: EvolutionAuditEntry[] = [];

  function recordAudit(
    proposalId: string,
    action: EvolutionAuditEntry["action"],
    details: string,
    provenance?: Pick<
      EvolutionAuditEntry,
      "validation_mode" | "validation_agent" | "validation_fixture_id" | "validation_evidence_ref"
    >,
  ): void {
    const entry = createAuditEntry(proposalId, action, details, skillName, provenance);
    auditEntries.push(entry);
    try {
      _appendAuditEntry(entry);
    } catch {
      // Fail-open
    }
  }

  function recordEvidence(entry: EvolutionEvidenceEntry): void {
    try {
      _appendEvidenceEntry(entry);
    } catch {
      // Fail-open
    }
  }

  try {
    // Step 1: Read current SKILL.md
    if (!existsSync(skillPath)) {
      return {
        proposal: null,
        validation: null,
        deployed: false,
        auditEntries,
        reason: `SKILL.md not found at ${skillPath}`,
      };
    }

    const currentContent = _readFileSync(skillPath, "utf-8");
    const parsed = parseSkillSections(currentContent);
    const createdAuditDetails = (): string => `original_description:${currentContent}`;
    const skillUsage = _readEffectiveSkillUsageRecords();

    // Step 2: Load eval set
    let evalSet: EvalEntry[];
    if (evalSetPath && existsSync(evalSetPath)) {
      const raw = _readFileSync(evalSetPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error("Eval set must be a JSON array");
      }
      evalSet = parsed as EvalEntry[];
    } else {
      const dbForQuery = getDb();
      const queryRecords = queryQueryLog(dbForQuery) as QueryLogRecord[];
      evalSet = _buildEvalSet(skillUsage, queryRecords, skillName);
    }

    // Step 3: Load skill usage and extract failure patterns
    const failurePatterns = _extractFailurePatterns(
      evalSet,
      skillUsage,
      skillName,
      options.gradingResults,
    );

    if (failurePatterns.length === 0) {
      return {
        proposal: null,
        validation: null,
        deployed: false,
        auditEntries,
        reason: "No failure patterns found",
      };
    }

    const missedQueries = failurePatterns.flatMap((p) => p.missed_queries);

    // Compute execution context from session telemetry (fail-open)
    let executionContext: ExecutionContext | undefined;
    try {
      const { querySessionTelemetry } = await import("../localdb/queries.js");
      const db = getDb();
      const allTelemetry = querySessionTelemetry(db);

      // Find session IDs that used this skill
      const skillSessionIds = new Set(
        skillUsage
          .filter((r) => r.skill_name?.toLowerCase() === skillName.toLowerCase() && r.triggered)
          .map((r) => r.session_id),
      );

      // Filter telemetry to skill sessions
      const telemetryForSkill = allTelemetry.filter((t) => skillSessionIds.has(t.session_id));

      if (telemetryForSkill.length > 0) {
        const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

        const toolCallCounts = telemetryForSkill.map((t) => t.total_tool_calls ?? 0);
        const errorCounts = telemetryForSkill.map((t) => t.errors_encountered ?? 0);
        const turnCounts = telemetryForSkill.map((t) => t.assistant_turns ?? 0);

        // Count tool frequency across all sessions
        const toolFreq = new Map<string, number>();
        const failureToolFreq = new Map<string, number>();

        for (const t of telemetryForSkill) {
          const tools: Record<string, number> = t.tool_calls ?? {};
          const isFailure = (t.errors_encountered ?? 0) > 2;

          for (const [tool, count] of Object.entries(tools)) {
            toolFreq.set(tool, (toolFreq.get(tool) ?? 0) + count);
            if (isFailure) {
              failureToolFreq.set(tool, (failureToolFreq.get(tool) ?? 0) + count);
            }
          }
        }

        const topN = (freq: Map<string, number>, n: number) =>
          [...freq.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([k]) => k);

        executionContext = {
          avgToolCalls: mean(toolCallCounts),
          avgErrors: mean(errorCounts),
          avgTurns: mean(turnCounts),
          commonTools: topN(toolFreq, 5),
          failureTools: topN(failureToolFreq, 3),
        };
      }
    } catch {
      // fail-open: body evolution works without execution context
    }

    // Step 4: Generate -> validate -> refine loop
    let lastProposal: BodyEvolutionProposal | null = null;
    let lastValidation: BodyValidationResult | null = null;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Generate proposal based on target
      let proposal: BodyEvolutionProposal;

      if (iteration === 0) {
        if (target === "routing") {
          const currentRouting = parsed.sections["Workflow Routing"] || "";
          proposal = await _generateRoutingProposal(
            currentRouting,
            currentContent,
            failurePatterns,
            missedQueries,
            skillName,
            skillPath,
            teacherAgent,
            teacherModel,
            teacherEffort,
          );
        } else {
          proposal = await _generateBodyProposal(
            currentContent,
            failurePatterns,
            missedQueries,
            skillName,
            skillPath,
            teacherAgent,
            teacherModel,
            fewShotExamples,
            executionContext,
            teacherEffort,
          );
        }
      } else if (lastProposal && lastValidation) {
        // Refine from previous failed attempt
        proposal = await _refineBodyProposal(
          lastProposal,
          lastValidation,
          teacherAgent,
          teacherModel,
          options.teacherEffort,
        );
      } else {
        break;
      }

      lastProposal = proposal;

      recordAudit(proposal.proposal_id, "created", createdAuditDetails());
      recordEvidence({
        timestamp: new Date().toISOString(),
        proposal_id: proposal.proposal_id,
        skill_name: skillName,
        skill_path: skillPath,
        target,
        stage: "created",
        rationale: proposal.rationale,
        confidence: proposal.confidence,
        details: `${target} proposal created for ${skillName} (iteration ${iteration + 1})`,
        original_text: proposal.original_body,
        proposed_text: proposal.proposed_body,
        eval_set: evalSet,
      });

      // Constitutional size check (deterministic, pre-validation — body only)
      if (target === "body") {
        const constitution = checkConstitutionSizeOnly(
          proposal.proposed_body,
          proposal.original_body,
        );
        if (!constitution.passed) {
          const reason = `Constitutional: ${constitution.violations.join("; ")}`;
          recordAudit(proposal.proposal_id, "rejected", reason);
          recordEvidence({
            timestamp: new Date().toISOString(),
            proposal_id: proposal.proposal_id,
            skill_name: skillName,
            skill_path: skillPath,
            target,
            stage: "rejected",
            rationale: proposal.rationale,
            confidence: proposal.confidence,
            details: reason,
            original_text: proposal.original_body,
            proposed_text: proposal.proposed_body,
          });
          return {
            proposal: lastProposal,
            validation: null,
            deployed: false,
            auditEntries,
            reason,
          };
        }
      }

      // Check confidence threshold
      if (proposal.confidence < confidenceThreshold) {
        recordAudit(
          proposal.proposal_id,
          "rejected",
          `Confidence ${proposal.confidence} below threshold ${confidenceThreshold}`,
        );
        recordEvidence({
          timestamp: new Date().toISOString(),
          proposal_id: proposal.proposal_id,
          skill_name: skillName,
          skill_path: skillPath,
          target,
          stage: "rejected",
          rationale: proposal.rationale,
          confidence: proposal.confidence,
          details: `Confidence ${proposal.confidence} below threshold ${confidenceThreshold}`,
        });

        if (iteration === maxIterations - 1) {
          return {
            proposal: lastProposal,
            validation: null,
            deployed: false,
            auditEntries,
            reason: `Confidence ${proposal.confidence} below threshold ${confidenceThreshold}`,
          };
        }
        continue;
      }

      // Validate (validationModel overrides studentModel for validation calls)
      const validationModelFlag = options.validationModel ?? studentModel;
      let validation: BodyValidationResult;
      let replayFallbackReason: string | undefined;

      // Build replay fixture + runner for targets that can use runtime replay.
      const replayOptions = buildRuntimeReplayValidationOptions({
        skillName,
        skillPath,
        agent: studentAgent,
        contentTarget: target === "body" ? "body" : "routing",
      });
      const replayFixture = replayOptions?.replayFixture;
      const replayRunner = replayOptions?.replayRunner;

      if (target === "routing") {
        validation = await _validateRoutingProposal(
          proposal,
          evalSet,
          studentAgent,
          validationModelFlag,
          {
            ...(replayFixture ? { replayFixture } : {}),
            ...(replayRunner ? { replayRunner } : {}),
            mode: effectiveValidationMode,
            onReplayFallback: (reason) => {
              replayFallbackReason = reason;
              if (reason) {
                console.error(
                  `[evolve-body] Replay not available (${reason}), falling back to LLM judge validation.`,
                );
                return;
              }
              console.error(
                "[evolve-body] Replay not available, falling back to LLM judge validation.",
              );
            },
          },
        );
      } else {
        const bodyReplayOptions: BodyValidationOptions = {
          ...(replayFixture
            ? {
                replay: {
                  replayFixture,
                  ...(replayRunner ? { replayRunner } : {}),
                },
              }
            : {}),
          mode: effectiveValidationMode,
          onReplayFallback: (reason) => {
            replayFallbackReason = reason;
            if (reason) {
              console.error(
                `[evolve-body] Replay not available (${reason}), falling back to LLM judge validation.`,
              );
              return;
            }
            console.error(
              "[evolve-body] Replay not available, falling back to LLM judge validation.",
            );
          },
        };
        validation = await _validateBodyProposal(
          proposal,
          evalSet,
          studentAgent,
          validationModelFlag,
          undefined,
          bodyReplayOptions,
        );
      }
      if (replayFallbackReason && !validation.validation_fallback_reason) {
        validation = {
          ...validation,
          validation_fallback_reason: replayFallbackReason,
        };
      }
      lastValidation = validation;
      const validatedEvidenceRef = buildValidationEvidenceRef(proposal.proposal_id, "validated");

      recordAudit(
        proposal.proposal_id,
        "validated",
        `Validation: ${validation.gates_passed}/${validation.gates_total} gates passed${
          validation.validation_fallback_reason
            ? ` (replay fallback: ${validation.validation_fallback_reason})`
            : ""
        }`,
        {
          validation_mode: validation.validation_mode,
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
        target,
        stage: "validated",
        rationale: proposal.rationale,
        confidence: proposal.confidence,
        details: `Validation: ${validation.gates_passed}/${validation.gates_total} gates passed${
          validation.validation_fallback_reason
            ? ` (replay fallback: ${validation.validation_fallback_reason})`
            : ""
        }`,
        validation: {
          improved: validation.improved,
          gates_passed: validation.gates_passed,
          gates_total: validation.gates_total,
          gate_results: validation.gate_results,
          regressions: validation.regressions,
          before_pass_rate: validation.before_pass_rate,
          after_pass_rate: validation.after_pass_rate,
          validation_mode: validation.validation_mode,
          validation_agent: validation.validation_agent,
          validation_fixture_id: validation.validation_fixture_id,
          validation_fallback_reason: validation.validation_fallback_reason,
          validation_evidence_ref: validatedEvidenceRef,
        },
      });

      // Persist per-entry replay results to SQLite
      try {
        const entryResults: ReplayEntryResultInput[] = [];
        if (validation.before_entry_results) {
          for (const r of validation.before_entry_results) {
            entryResults.push({
              proposal_id: proposal.proposal_id,
              skill_name: skillName,
              validation_mode: validation.validation_mode ?? "llm_judge",
              phase: "before",
              query: r.query,
              should_trigger: r.should_trigger,
              triggered: r.triggered,
              passed: r.passed,
              evidence: r.evidence,
            });
          }
        }
        if (validation.per_entry_results) {
          for (const r of validation.per_entry_results) {
            entryResults.push({
              proposal_id: proposal.proposal_id,
              skill_name: skillName,
              validation_mode: validation.validation_mode ?? "llm_judge",
              phase: "after",
              query: r.query,
              should_trigger: r.should_trigger,
              triggered: r.triggered,
              passed: r.passed,
              evidence: r.evidence,
            });
          }
        }
        if (entryResults.length > 0) {
          writeReplayEntryResultsToDb(entryResults);
        }
      } catch {
        // Fail-open: replay entry persistence is non-blocking
      }

      if (validation.improved) {
        break;
      }

      recordAudit(
        proposal.proposal_id,
        "rejected",
        `Validation failed: ${validation.gates_passed}/${validation.gates_total} gates${
          validation.validation_fallback_reason
            ? ` (replay fallback: ${validation.validation_fallback_reason})`
            : ""
        }`,
        {
          validation_mode: validation.validation_mode,
          validation_agent: validation.validation_agent,
          validation_fixture_id: validation.validation_fixture_id,
          validation_evidence_ref: buildValidationEvidenceRef(proposal.proposal_id, "rejected"),
        },
      );
      recordEvidence({
        timestamp: new Date().toISOString(),
        proposal_id: proposal.proposal_id,
        skill_name: skillName,
        skill_path: skillPath,
        target,
        stage: "rejected",
        rationale: proposal.rationale,
        confidence: proposal.confidence,
        details: `Validation failed: ${validation.gates_passed}/${validation.gates_total} gates${
          validation.validation_fallback_reason
            ? ` (replay fallback: ${validation.validation_fallback_reason})`
            : ""
        }`,
        validation: {
          improved: validation.improved,
          gates_passed: validation.gates_passed,
          gates_total: validation.gates_total,
          gate_results: validation.gate_results,
          regressions: validation.regressions,
          before_pass_rate: validation.before_pass_rate,
          after_pass_rate: validation.after_pass_rate,
          validation_mode: validation.validation_mode,
          validation_agent: validation.validation_agent,
          validation_fixture_id: validation.validation_fixture_id,
          validation_fallback_reason: validation.validation_fallback_reason,
          validation_evidence_ref: buildValidationEvidenceRef(proposal.proposal_id, "rejected"),
        },
      });

      if (iteration === maxIterations - 1) {
        return {
          proposal: lastProposal,
          validation: lastValidation,
          deployed: false,
          auditEntries,
          reason: `Validation failed after ${maxIterations} iterations: ${validation.gates_passed}/${validation.gates_total} gates`,
        };
      }
    }

    // Step 5: Optional evolution-reviewer gate (Gate 4)
    if (options.useReviewer && lastProposal && lastValidation?.improved) {
      try {
        const reviewPrompt = [
          `Review this ${target} evolution proposal for the "${skillName}" skill.`,
          ``,
          `Proposal ID: ${lastProposal.proposal_id}`,
          `Skill path: ${skillPath}`,
          `Target: ${target}`,
          `Confidence: ${lastProposal.confidence}`,
          `Validation: ${lastValidation.gates_passed}/${lastValidation.gates_total} gates passed`,
          `Regressions: ${lastValidation.regressions.length > 0 ? lastValidation.regressions.join(", ") : "none"}`,
          ``,
          `Original content:`,
          lastProposal.original_body,
          ``,
          `Proposed content:`,
          lastProposal.proposed_body,
          ``,
          `Rationale: ${lastProposal.rationale}`,
        ].join("\n");

        const reviewOutput = await _callViaSubagent({
          agentName: "evolution-reviewer",
          prompt: reviewPrompt,
          maxTurns: 8,
          allowedTools: ["Read", "Grep", "Glob", "Bash"],
        });

        const isRejected = /\bREJECT\b/.test(reviewOutput) && !/\bAPPROVE\b/.test(reviewOutput);
        recordAudit(
          lastProposal.proposal_id,
          isRejected ? "rejected" : "validated",
          `Evolution reviewer: ${isRejected ? "REJECTED" : "APPROVED"}`,
        );

        if (isRejected) {
          return {
            proposal: lastProposal,
            validation: lastValidation,
            deployed: false,
            auditEntries,
            reason: `Evolution reviewer rejected proposal: ${reviewOutput.slice(0, 500)}`,
          };
        }
      } catch (reviewError) {
        // Fail-open: if reviewer crashes, log it and continue to deploy
        const msg = reviewError instanceof Error ? reviewError.message : String(reviewError);
        recordAudit(
          lastProposal.proposal_id,
          "validated",
          `Evolution reviewer failed (fail-open): ${msg}`,
        );
      }
    }

    // Step 6: Deploy or dry-run
    if (dryRun) {
      return {
        proposal: lastProposal,
        validation: lastValidation,
        deployed: false,
        auditEntries,
        reason: "Dry run - proposal validated but not deployed",
      };
    }

    if (lastProposal && lastValidation?.improved) {
      // Deploy: write updated SKILL.md
      if (target === "routing") {
        const updatedContent = replaceSection(
          currentContent,
          "Workflow Routing",
          lastProposal.proposed_body,
        );
        _writeFileSync(skillPath, updatedContent, "utf-8");
      } else {
        const updatedContent = replaceBody(currentContent, lastProposal.proposed_body);
        _writeFileSync(skillPath, updatedContent, "utf-8");
      }

      recordAudit(
        lastProposal.proposal_id,
        "deployed",
        `Deployed ${target} proposal for ${skillName}${
          lastValidation.validation_fallback_reason
            ? ` (replay fallback: ${lastValidation.validation_fallback_reason})`
            : ""
        }`,
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
        target,
        stage: "deployed",
        rationale: lastProposal.rationale,
        confidence: lastProposal.confidence,
        details: `Deployed ${target} proposal for ${skillName}`,
        validation: {
          improved: lastValidation.improved,
          gates_passed: lastValidation.gates_passed,
          gates_total: lastValidation.gates_total,
          gate_results: lastValidation.gate_results,
          regressions: lastValidation.regressions,
          before_pass_rate: lastValidation.before_pass_rate,
          after_pass_rate: lastValidation.after_pass_rate,
          validation_mode: lastValidation.validation_mode,
          validation_agent: lastValidation.validation_agent,
          validation_fixture_id: lastValidation.validation_fixture_id,
          validation_fallback_reason: lastValidation.validation_fallback_reason,
          validation_evidence_ref: buildValidationEvidenceRef(lastProposal.proposal_id, "deployed"),
        },
      });

      return {
        proposal: lastProposal,
        validation: lastValidation,
        deployed: true,
        auditEntries,
        reason: "Evolution deployed successfully",
      };
    }

    return {
      proposal: lastProposal,
      validation: lastValidation,
      deployed: false,
      auditEntries,
      reason: "Evolution not deployed: validation did not pass",
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      proposal: null,
      validation: null,
      deployed: false,
      auditEntries,
      reason: `Error during body evolution: ${errorMessage}`,
    };
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
      target: { type: "string", default: "body" },
      "teacher-agent": { type: "string" },
      "student-agent": { type: "string" },
      "teacher-model": { type: "string" },
      "student-model": { type: "string" },
      "eval-set": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "max-iterations": { type: "string", default: "3" },
      confidence: { type: "string", default: "0.6" },
      "task-description": { type: "string" },
      "few-shot": { type: "string" },
      "validation-model": { type: "string" },
      "validation-mode": { type: "string", default: DEFAULT_VALIDATION_STRATEGY },
      "teacher-effort": { type: "string", default: "high" },
      review: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune evolve body — Evolve a skill body or routing table

Usage:
  selftune evolve body --skill <name> --skill-path <path> [options]

Options:
  --skill             Skill name (required)
  --skill-path        Path to SKILL.md (required)
  --target            Evolution target: body, routing (default: body)
  --teacher-agent     Teacher agent CLI (claude, codex, etc.)
  --student-agent     Student agent CLI for validation
  --teacher-model     Model flag for teacher agent (default: opus)
  --student-model     Model flag for student agent (default: haiku)
  --eval-set          Path to eval set JSON
  --dry-run           Validate without deploying
  --max-iterations    Max refinement iterations (default: 3)
  --confidence        Confidence threshold 0.0-1.0 (default: 0.6)
  --task-description  Optional task description context
  --few-shot          Comma-separated paths to example skill files
  --validation-model  Model for trigger-check validation calls (overrides --student-model for validation)
  --validation-mode   Validation strategy: auto, replay, or judge (default: auto)
  --teacher-effort    Effort level for teacher LLM: low, medium, high, max (default: high)
  --review            Run evolution-reviewer subagent before deployment (Gate 4)
  --help              Show this help message`);
    process.exit(0);
  }

  if (!values.skill || !values["skill-path"]) {
    throw new CLIError(
      "--skill and --skill-path are required",
      "MISSING_FLAG",
      "selftune evolve body --skill <name> --skill-path <path>",
    );
  }

  if (
    values["validation-mode"] &&
    !["auto", "replay", "judge"].includes(values["validation-mode"])
  ) {
    throw new CLIError(
      `Invalid --validation-mode value: ${values["validation-mode"]}`,
      "INVALID_FLAG",
      "Use one of: auto, replay, judge",
    );
  }
  const teacherAgent = values["teacher-agent"] ?? detectLlmAgent() ?? "";
  const studentAgent = values["student-agent"] ?? teacherAgent;

  if (!teacherAgent) {
    throw new CLIError(
      "No agent CLI found. Install Claude Code, Codex, OpenCode, or Pi.",
      "AGENT_NOT_FOUND",
      "Install Claude Code, Codex, OpenCode, or Pi.",
    );
  }

  // Parse target
  const targetStr = values.target ?? "body";
  if (targetStr !== "body" && targetStr !== "routing") {
    throw new CLIError(
      "--target must be 'body' or 'routing'",
      "INVALID_FLAG",
      "Use --target body or --target routing",
    );
  }

  // Parse few-shot examples
  let fewShotExamples: string[] | undefined;
  if (values["few-shot"]) {
    const paths = values["few-shot"].split(",").map((p) => p.trim());
    fewShotExamples = paths.filter((p) => existsSync(p)).map((p) => readFileSync(p, "utf-8"));
  }
  const gradingResults = readGradingResultsForSkill(values.skill);

  const result = await evolveBody({
    skillName: values.skill,
    skillPath: values["skill-path"],
    target: targetStr as EvolutionTarget,
    teacherAgent,
    studentAgent,
    teacherModel: values["teacher-model"],
    studentModel: values["student-model"],
    evalSetPath: values["eval-set"],
    dryRun: values["dry-run"] ?? false,
    maxIterations: Number.parseInt(values["max-iterations"] ?? "3", 10),
    confidenceThreshold: Number.parseFloat(values.confidence ?? "0.6"),
    taskDescription: values["task-description"],
    fewShotExamples,
    gradingResults,
    validationModel: values["validation-model"],
    validationMode:
      (values["validation-mode"] as ValidationStrategy | undefined) ?? DEFAULT_VALIDATION_STRATEGY,
    teacherEffort: (values["teacher-effort"] as EffortLevel) ?? "high",
    useReviewer: values.review ?? false,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.deployed ? 0 : 1);
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
