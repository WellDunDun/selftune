import { parseArgs } from "node:util";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "@selftune/runtime/command-surface";
import type { OrchestrateOptions, OrchestrateResult } from "../orchestrate.js";
import { CLIError } from "@selftune/runtime/utils/cli-error";

export interface ParsedOrchestrateCliArgs {
  showHelp: boolean;
  warnings: string[];
  loop: boolean;
  loopIntervalSeconds: number;
  runOptions: OrchestrateOptions;
}

function parsePositiveIntegerFlag(value: string, message: string, command: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new CLIError(message, "INVALID_FLAG", command);
  }
  return Number(value);
}

function parseNonNegativeIntegerFlag(value: string, message: string, command: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CLIError(message, "INVALID_FLAG", command);
  }
  return Number(value);
}

export function renderOrchestrateHelp(): string {
  return renderCommandHelp(PUBLIC_COMMAND_SURFACES.orchestrate);
}

export function parseOrchestrateCliArgs(
  argv: string[] = process.argv.slice(2),
): ParsedOrchestrateCliArgs {
  const { values } = parseArgs({
    args: argv,
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
    return {
      showHelp: true,
      warnings: [],
      loop: false,
      loopIntervalSeconds: 3600,
      runOptions: {
        dryRun: false,
        approvalMode: "auto",
        maxSkills: 5,
        recentWindowHours: 48,
        syncForce: false,
        maxAutoGrade: 5,
      },
    };
  }

  const loop = values.loop ?? false;
  const maxSkills = parsePositiveIntegerFlag(
    values["max-skills"] ?? "5",
    "--max-skills must be a positive integer",
    "selftune orchestrate --max-skills 5",
  );
  const recentWindowHours = parsePositiveIntegerFlag(
    values["recent-window"] ?? "48",
    "--recent-window must be a positive integer",
    "selftune orchestrate --recent-window 48",
  );
  const maxAutoGrade = parseNonNegativeIntegerFlag(
    values["max-auto-grade"] ?? "5",
    "--max-auto-grade must be a non-negative integer",
    "selftune orchestrate --max-auto-grade 5",
  );

  const loopIntervalRaw = values["loop-interval"] ?? "3600";
  if (!/^\d+$/.test(loopIntervalRaw) || (loop && Number(loopIntervalRaw) < 60)) {
    throw new CLIError(
      "--loop-interval must be an integer >= 60 (seconds)",
      "INVALID_FLAG",
      "selftune orchestrate --loop --loop-interval 3600",
    );
  }

  const warnings: string[] = [];
  if (values["auto-approve"]) {
    warnings.push(
      "[orchestrate] --auto-approve is deprecated; autonomous mode is now the default.",
    );
  }

  return {
    showHelp: false,
    warnings,
    loop,
    loopIntervalSeconds: Number(loopIntervalRaw),
    runOptions: {
      dryRun: values["dry-run"] ?? false,
      approvalMode: values["review-required"] ? "review" : "auto",
      skillFilter: values.skill,
      maxSkills,
      recentWindowHours,
      syncForce: values["sync-force"] ?? false,
      maxAutoGrade,
    },
  };
}

export function buildOrchestrateJsonOutput(result: OrchestrateResult) {
  return {
    ...result.summary,
    workflow_proposals: result.workflowProposals.map((proposal) => ({
      proposal_id: proposal.proposal_id,
      source_skill_name: proposal.source_skill_name,
      workflow_id: proposal.workflow.workflow_id,
      generated_skill_name: proposal.draft.skill_name,
      output_path: proposal.draft.skill_path,
      confidence: proposal.confidence,
      reason: proposal.rationale,
    })),
    decisions: result.candidates.map(buildDecision),
  };
}

type Candidate = OrchestrateResult["candidates"][number];
type Evolution = NonNullable<Candidate["evolveResult"]>;
type Watch = NonNullable<Candidate["watchResult"]>;
type Decision = Pick<Candidate, "skill" | "action" | "reason"> &
  Partial<Pick<Watch, "alert" | "rolledBack" | "recommendation">> & {
    deployed?: Evolution["deployed"];
    evolveReason?: Evolution["reason"];
    validation?: { before: number; after: number; improved: boolean } | null;
    passRate?: number | null;
  };

function buildDecision(candidate: Candidate): Decision {
  const decision: Decision = {
    skill: candidate.skill,
    action: candidate.action,
    reason: candidate.reason,
  };
  const evolution = candidate.evolveResult;
  if (evolution) {
    decision.deployed = evolution.deployed;
    decision.evolveReason = evolution.reason;
    decision.validation = evolution.validation
      ? {
          before: evolution.validation.before_pass_rate,
          after: evolution.validation.after_pass_rate,
          improved: evolution.validation.improved,
        }
      : null;
  }
  const watch = candidate.watchResult;
  if (watch) {
    decision.alert = watch.alert;
    decision.rolledBack = watch.rolledBack;
    decision.passRate = watch.snapshot?.pass_rate ?? null;
    decision.recommendation = watch.recommendation;
  }
  return decision;
}
