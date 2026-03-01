/**
 * evolve.ts
 *
 * Evolution orchestrator: coordinates failure pattern extraction, proposal
 * generation, validation, and deployment into a single pipeline with retry
 * logic and comprehensive audit tracking.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { QUERY_LOG, SKILL_LOG } from "../constants.js";
import { buildEvalSet } from "../eval/hooks-to-evals.js";
import type {
  EvalEntry,
  EvalPassRate,
  EvolutionAuditEntry,
  EvolutionProposal,
  QueryLogRecord,
  SkillUsageRecord,
} from "../types.js";
import { updateContextAfterEvolve } from "../memory/writer.js";
import { readJsonl } from "../utils/jsonl.js";
import { appendAuditEntry } from "./audit.js";
import { extractFailurePatterns } from "./extract-patterns.js";
import { generateProposal } from "./propose-description.js";
import type { ValidationResult } from "./validate-proposal.js";
import { validateProposal } from "./validate-proposal.js";

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
}

export interface EvolveResult {
  proposal: EvolutionProposal | null;
  validation: ValidationResult | null;
  deployed: boolean;
  auditEntries: EvolutionAuditEntry[];
  reason: string;
}

/**
 * Injectable dependencies for evolve(). When omitted, the real module
 * imports are used. Pass overrides in tests to avoid mock.module().
 */
export interface EvolveDeps {
  extractFailurePatterns?: typeof import("./extract-patterns.js").extractFailurePatterns;
  generateProposal?: typeof import("./propose-description.js").generateProposal;
  validateProposal?: typeof import("./validate-proposal.js").validateProposal;
  appendAuditEntry?: typeof import("./audit.js").appendAuditEntry;
  buildEvalSet?: typeof import("../eval/hooks-to-evals.js").buildEvalSet;
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

  // Resolve injectable dependencies with real-import fallbacks
  const _extractFailurePatterns = _deps.extractFailurePatterns ?? extractFailurePatterns;
  const _generateProposal = _deps.generateProposal ?? generateProposal;
  const _validateProposal = _deps.validateProposal ?? validateProposal;
  const _appendAuditEntry = _deps.appendAuditEntry ?? appendAuditEntry;
  const _buildEvalSet = _deps.buildEvalSet ?? buildEvalSet;

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

  try {
    // -----------------------------------------------------------------------
    // Step 1: Read current SKILL.md
    // -----------------------------------------------------------------------
    if (!existsSync(skillPath)) {
      return {
        proposal: null,
        validation: null,
        deployed: false,
        auditEntries,
        reason: `SKILL.md not found at ${skillPath}`,
      };
    }

    const currentDescription = readFileSync(skillPath, "utf-8");

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

    // -----------------------------------------------------------------------
    // Step 3: Load skill usage records
    // -----------------------------------------------------------------------
    const skillUsage = readJsonl<SkillUsageRecord>(SKILL_LOG);

    // -----------------------------------------------------------------------
    // Step 4: Extract failure patterns
    // -----------------------------------------------------------------------
    const failurePatterns = _extractFailurePatterns(evalSet, skillUsage, skillName);

    // -----------------------------------------------------------------------
    // Step 5: Early exit if no patterns
    // -----------------------------------------------------------------------
    if (failurePatterns.length === 0) {
      return {
        proposal: null,
        validation: null,
        deployed: false,
        auditEntries,
        reason: "No failure patterns found",
      };
    }

    // -----------------------------------------------------------------------
    // Step 6: Collect all missed queries
    // -----------------------------------------------------------------------
    const missedQueries = failurePatterns.flatMap((p) => p.missed_queries);

    // -----------------------------------------------------------------------
    // Steps 7-12: Retry loop for proposal generation and validation
    // -----------------------------------------------------------------------
    let lastProposal: EvolutionProposal | null = null;
    let lastValidation: ValidationResult | null = null;
    let feedbackReason = "";

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Step 7: Generate proposal
      const effectiveMissedQueries = feedbackReason
        ? [...missedQueries, `[Previous attempt failed: ${feedbackReason}]`]
        : missedQueries;

      const proposal = await _generateProposal(
        currentDescription,
        failurePatterns,
        effectiveMissedQueries,
        skillName,
        skillPath,
        agent,
      );

      lastProposal = proposal;

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

      // Step 10: Validate against eval set
      const validation = await _validateProposal(proposal, evalSet, agent);
      lastValidation = validation;

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
          return {
            proposal: lastProposal,
            validation: lastValidation,
            deployed: false,
            auditEntries,
            reason: `Validation failed after ${maxIterations} iterations: net_change=${validation.net_change.toFixed(3)}`,
          };
        }

        continue;
      }

      // Validation passed - break out of retry loop
      break;
    }

    // -----------------------------------------------------------------------
    // Step 13: Dry run check
    // -----------------------------------------------------------------------
    if (dryRun) {
      return {
        proposal: lastProposal,
        validation: lastValidation,
        deployed: false,
        auditEntries,
        reason: "Dry run - proposal validated but not deployed",
      };
    }

    // -----------------------------------------------------------------------
    // Step 14: Deploy (actual deploy wired in TASK-14)
    // -----------------------------------------------------------------------
    if (lastProposal) {
      recordAudit(
        lastProposal.proposal_id,
        "deployed",
        `Deployed proposal for ${skillName}`,
        lastValidation
          ? {
              total: evalSet.length,
              passed: Math.round(lastValidation.after_pass_rate * evalSet.length),
              failed: evalSet.length - Math.round(lastValidation.after_pass_rate * evalSet.length),
              pass_rate: lastValidation.after_pass_rate,
            }
          : undefined,
      );
    }

    // -----------------------------------------------------------------------
    // Step 15: Update evolution memory
    // -----------------------------------------------------------------------
    const evolveResult: EvolveResult = {
      proposal: lastProposal,
      validation: lastValidation,
      deployed: true,
      auditEntries,
      reason: "Evolution deployed successfully",
    };

    if (lastProposal) {
      try {
        updateContextAfterEvolve(skillName, lastProposal, evolveResult);
      } catch {
        // Memory writes should never fail the main operation
      }
    }

    // -----------------------------------------------------------------------
    // Step 16: Return complete result
    // -----------------------------------------------------------------------
    return evolveResult;
  } catch (error) {
    // Robust error handling: catch any unexpected errors and return gracefully
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      proposal: null,
      validation: null,
      deployed: false,
      auditEntries,
      reason: `Error during evolution: ${errorMessage}`,
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
      "eval-set": { type: "string" },
      agent: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      confidence: { type: "string", default: "0.6" },
      "max-iterations": { type: "string", default: "3" },
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

  const result = await evolve({
    skillName: values.skill,
    skillPath: values["skill-path"],
    evalSetPath: values["eval-set"],
    agent,
    dryRun: values["dry-run"] ?? false,
    confidenceThreshold: Number.parseFloat(values.confidence ?? "0.6"),
    maxIterations: Number.parseInt(values["max-iterations"] ?? "3", 10),
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
