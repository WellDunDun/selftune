/** CLI adapter for the evolution pipeline. */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

import type { SourceSyncRunner } from "@selftune/source-management/sync";
import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "../../command-surface.js";
import { QUERY_LOG, SKILL_LOG } from "../../constants.js";
import { readGradingResultsForSkill } from "../../grading/results.js";
import { getDb } from "../../localdb/db.js";
import { querySessionTelemetry, querySkillUsageRecords } from "../../localdb/queries.js";
import type { EvolveResultSummary, SessionTelemetryRecord } from "../../types.js";
import { CLIError } from "../../utils/cli-error.js";
import type { ReplayValidationOptions } from "../engines/replay-engine.js";
import { buildRuntimeReplayValidationOptions } from "../validate-host-replay.js";
import { buildUnblockSuggestions } from "../unblock-suggestions.js";
import type { EvolveResult } from "./contracts.js";
import { evolve } from "./orchestrator.js";

export function summarizeEvolution(result: EvolveResult, skill: string): EvolveResultSummary {
  const summary: EvolveResultSummary = {
    skill,
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
    dashboard_url: `http://localhost:3141/report/${encodeURIComponent(skill)}`,
  };
  if (result.skillVersion) summary.version = result.skillVersion;
  if (result.descriptionQualityBefore != null) {
    summary.description_quality_before = result.descriptionQualityBefore;
  }
  if (result.descriptionQualityAfter != null) {
    summary.description_quality_after = result.descriptionQualityAfter;
  }
  if (!result.deployed) summary.suggestions = buildUnblockSuggestions(result, skill);
  return summary;
}

export async function cliMain(sourceSync?: SourceSyncRunner): Promise<void> {
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
      "validation-mode": { type: "string", default: "auto" },
      "sync-first": { type: "boolean", default: false },
      "sync-force": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.evolve));
    process.exit(0);
  }

  if (!values.skill || !values["skill-path"]) {
    throw new CLIError(
      "--skill and --skill-path are required",
      "MISSING_FLAG",
      "selftune evolve --skill <name> --skill-path <path>",
    );
  }
  const validationMode = (["auto", "replay", "judge"] as const).find(
    (mode) => mode === values["validation-mode"],
  );
  if (!validationMode) {
    throw new CLIError(
      `Invalid --validation-mode value: ${values["validation-mode"]}`,
      "INVALID_FLAG",
      "Use one of: auto, replay, judge",
    );
  }
  if ((values["sync-force"] ?? false) && !(values["sync-first"] ?? false)) {
    throw new CLIError(
      "--sync-force requires --sync-first",
      "INVALID_FLAG",
      "Add --sync-first when using --sync-force",
    );
  }
  const gateEffort = (["low", "medium", "high", "max"] as const).find(
    (effort) => effort === values["gate-effort"],
  );
  if (values["gate-effort"] !== undefined && !gateEffort) {
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

  const { detectLlmAgent } = await import("../../utils/llm-call.js");
  const requestedAgent = values.agent;
  if (requestedAgent && !Bun.which(requestedAgent)) {
    throw new CLIError(
      `Agent CLI '${requestedAgent}' not found in PATH.`,
      "AGENT_NOT_FOUND",
      "Install it or omit --agent to use auto-detection.",
    );
  }
  const agent = requestedAgent ?? detectLlmAgent();
  if (!agent) {
    throw new CLIError(
      "No agent CLI (claude/codex/opencode/pi) found in PATH.",
      "AGENT_NOT_FOUND",
      "Install Claude Code, Codex, OpenCode, or Pi.",
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
    telemetryRecords = querySessionTelemetry(dbTel2);
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

  // Build replay options automatically when a real runtime replay runner exists.
  let replayOptions: ReplayValidationOptions | undefined;
  if (values["validation-mode"] !== "judge") {
    replayOptions = buildRuntimeReplayValidationOptions({
      skillName: values.skill,
      skillPath: values["skill-path"],
      agent,
      contentTarget: "description",
    });
  }

  const result = await evolve(
    {
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
      gateEffort,
      proposalModel: values["proposal-model"],
      adaptiveGate: values["adaptive-gate"] ?? false,
      gradingResults,
      syncFirst: values["sync-first"] ?? false,
      syncForce: values["sync-force"] ?? false,
      validationMode,
      replayOptions,
    },
    { syncSources: sourceSync },
  );

  if (values.verbose) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const summary = summarizeEvolution(result, values.skill);
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
        `  Confidence ${result.proposal.confidence.toFixed(2)} below review threshold ${values.confidence ?? "0.6"} (validated anyway)`,
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
