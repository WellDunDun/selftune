/**
 * evolve-body.ts
 *
 * Body evolution orchestrator: coordinates full body or routing-table evolution
 * through a pipeline of proposal generation, 3-gate validation, refinement,
 * and deployment.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { QUERY_LOG, SKILL_LOG } from "../constants.js";
import { buildEvalSet } from "../eval/hooks-to-evals.js";
import type {
  BodyEvolutionProposal,
  BodyValidationResult,
  EvalEntry,
  EvolutionAuditEntry,
  EvolutionTarget,
  FailurePattern,
  GradingResult,
  QueryLogRecord,
  SkillUsageRecord,
} from "../types.js";
import { readJsonl } from "../utils/jsonl.js";
import { appendAuditEntry } from "./audit.js";
import { parseSkillSections, replaceBody, replaceSection } from "./deploy-proposal.js";
import { extractFailurePatterns } from "./extract-patterns.js";
import { generateBodyProposal } from "./propose-body.js";
import { generateRoutingProposal } from "./propose-routing.js";
import { refineBodyProposal } from "./refine-body.js";
import { validateBodyProposal } from "./validate-body.js";
import { validateRoutingProposal } from "./validate-routing.js";

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
  buildEvalSet?: typeof import("../eval/hooks-to-evals.js").buildEvalSet;
  readFileSync?: typeof readFileSync;
  writeFileSync?: (path: string, data: string, encoding: string) => void;
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

function createAuditEntry(
  proposalId: string,
  action: EvolutionAuditEntry["action"],
  details: string,
  skillName?: string,
): EvolutionAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    proposal_id: proposalId,
    skill_name: skillName,
    action,
    details,
  };
}

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
    teacherModel,
    studentModel,
    evalSetPath,
    dryRun,
    maxIterations,
    confidenceThreshold,
    fewShotExamples,
  } = options;

  // Resolve injectable dependencies
  const _extractFailurePatterns = _deps.extractFailurePatterns ?? extractFailurePatterns;
  const _generateBodyProposal = _deps.generateBodyProposal ?? generateBodyProposal;
  const _generateRoutingProposal = _deps.generateRoutingProposal ?? generateRoutingProposal;
  const _validateBodyProposal = _deps.validateBodyProposal ?? validateBodyProposal;
  const _validateRoutingProposal = _deps.validateRoutingProposal ?? validateRoutingProposal;
  const _refineBodyProposal = _deps.refineBodyProposal ?? refineBodyProposal;
  const _appendAuditEntry = _deps.appendAuditEntry ?? appendAuditEntry;
  const _buildEvalSet = _deps.buildEvalSet ?? buildEvalSet;
  const _readFileSync = _deps.readFileSync ?? readFileSync;
  const _writeFileSync = _deps.writeFileSync ?? (await import("node:fs")).writeFileSync;

  const auditEntries: EvolutionAuditEntry[] = [];

  function recordAudit(
    proposalId: string,
    action: EvolutionAuditEntry["action"],
    details: string,
  ): void {
    const entry = createAuditEntry(proposalId, action, details, skillName);
    auditEntries.push(entry);
    try {
      _appendAuditEntry(entry);
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

    // Step 2: Load eval set
    let evalSet: EvalEntry[];
    if (evalSetPath && existsSync(evalSetPath)) {
      const raw = _readFileSync(evalSetPath, "utf-8");
      evalSet = JSON.parse(raw) as EvalEntry[];
    } else {
      const skillRecords = readJsonl<SkillUsageRecord>(SKILL_LOG);
      const queryRecords = readJsonl<QueryLogRecord>(QUERY_LOG);
      evalSet = _buildEvalSet(skillRecords, queryRecords, skillName);
    }

    // Step 3: Load skill usage and extract failure patterns
    const skillUsage = readJsonl<SkillUsageRecord>(SKILL_LOG);
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
          );
        }
      } else if (lastProposal && lastValidation) {
        // Refine from previous failed attempt
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
          );
        } else {
          proposal = await _refineBodyProposal(
            lastProposal,
            lastValidation,
            teacherAgent,
            teacherModel,
          );
        }
      } else {
        break;
      }

      lastProposal = proposal;

      recordAudit(
        proposal.proposal_id,
        "created",
        `${target} proposal created for ${skillName} (iteration ${iteration + 1})`,
      );

      // Check confidence threshold
      if (proposal.confidence < confidenceThreshold) {
        recordAudit(
          proposal.proposal_id,
          "rejected",
          `Confidence ${proposal.confidence} below threshold ${confidenceThreshold}`,
        );

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

      // Validate
      let validation: BodyValidationResult;
      if (target === "routing") {
        validation = await _validateRoutingProposal(
          proposal,
          evalSet,
          studentAgent,
          studentModel,
        );
      } else {
        validation = await _validateBodyProposal(
          proposal,
          evalSet,
          studentAgent,
          studentModel,
        );
      }
      lastValidation = validation;

      recordAudit(
        proposal.proposal_id,
        "validated",
        `Validation: ${validation.gates_passed}/${validation.gates_total} gates passed`,
      );

      if (validation.improved) {
        break;
      }

      recordAudit(
        proposal.proposal_id,
        "rejected",
        `Validation failed: ${validation.gates_passed}/${validation.gates_total} gates`,
      );

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

    // Step 5: Deploy or dry-run
    if (dryRun) {
      return {
        proposal: lastProposal,
        validation: lastValidation,
        deployed: false,
        auditEntries,
        reason: "Dry run - proposal validated but not deployed",
      };
    }

    if (lastProposal && lastValidation && lastValidation.improved) {
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
        `Deployed ${target} proposal for ${skillName} (gates: ${lastValidation.gates_passed}/${lastValidation.gates_total})`,
      );

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
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune evolve-body — Evolve a skill body or routing table

Usage:
  selftune evolve-body --skill <name> --skill-path <path> [options]

Options:
  --skill             Skill name (required)
  --skill-path        Path to SKILL.md (required)
  --target            Evolution target: body, routing (default: body)
  --teacher-agent     Teacher agent CLI (claude, codex, etc.)
  --student-agent     Student agent CLI for validation
  --teacher-model     Model flag for teacher agent
  --student-model     Model flag for student agent
  --eval-set          Path to eval set JSON
  --dry-run           Validate without deploying
  --max-iterations    Max refinement iterations (default: 3)
  --confidence        Confidence threshold 0.0-1.0 (default: 0.6)
  --task-description  Optional task description context
  --few-shot          Comma-separated paths to example skill files
  --help              Show this help message`);
    process.exit(0);
  }

  if (!values.skill || !values["skill-path"]) {
    console.error("[ERROR] --skill and --skill-path are required");
    process.exit(1);
  }

  const { detectAgent } = await import("../utils/llm-call.js");
  const teacherAgent = values["teacher-agent"] ?? detectAgent() ?? "";
  const studentAgent = values["student-agent"] ?? teacherAgent;

  if (!teacherAgent) {
    console.error("[ERROR] No agent CLI found. Install Claude Code, Codex, or OpenCode.");
    process.exit(1);
  }

  // Parse target
  const targetStr = values.target ?? "body";
  if (targetStr !== "body" && targetStr !== "routing") {
    console.error("[ERROR] --target must be 'body' or 'routing'");
    process.exit(1);
  }

  // Parse few-shot examples
  let fewShotExamples: string[] | undefined;
  if (values["few-shot"]) {
    const paths = values["few-shot"].split(",").map((p) => p.trim());
    fewShotExamples = paths
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, "utf-8"));
  }

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
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.deployed ? 0 : 1);
}

if (import.meta.main) {
  cliMain().catch((err) => {
    console.error(`[FATAL] ${err}`);
    process.exit(1);
  });
}
