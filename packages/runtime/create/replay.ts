import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "../command-surface.js";
import { parseSkillSections } from "../evolution/deploy-proposal.js";
import {
  buildRoutingReplayFixture,
  resolveRuntimeReplayPlatform,
  runHostRuntimeReplayFixture,
  type RuntimeReplayInvoker,
} from "../evolution/validate-host-replay.js";
import { writeReplayEntryResultsToDb } from "../localdb/direct-write.js";
import { getCanonicalEvalSetPath } from "../testing-readiness.js";
import type {
  EvalEntry,
  ReplayStagingMode,
  RoutingReplayEntryResult,
  RuntimeReplayAggregateMetrics,
} from "../types.js";
import { isLlmBackedAgent, detectLlmAgent } from "../utils/llm-call.js";
import { CLIError, handleCLIError } from "../utils/cli-error.js";
import { readCreateSkillContext } from "./readiness.js";

export type CreateReplayMode = ReplayStagingMode;

export interface CreateReplayResult {
  skill: string;
  skill_path: string;
  mode: CreateReplayMode;
  agent: string;
  proposal_id: string;
  total: number;
  passed: number;
  failed: number;
  pass_rate: number;
  fixture_id: string;
  results: RoutingReplayEntryResult[];
  runtime_metrics: RuntimeReplayAggregateMetrics;
}

export interface RunCreateReplayOptions {
  skillPath: string;
  mode: CreateReplayMode;
  agent?: string | null;
  evalSetPath?: string;
  includeTargetSkill?: boolean;
  runtimeInvoker?: RuntimeReplayInvoker;
}

export function loadCreateEvalSet(skillName: string, explicitPath?: string): EvalEntry[] {
  const path = explicitPath?.trim() || getCanonicalEvalSetPath(skillName);
  if (!existsSync(path)) {
    throw new CLIError(
      `No canonical eval set found for "${skillName}" at ${path}.`,
      "MISSING_DATA",
      `Run selftune eval generate --skill ${skillName} --skill-path /path/to/${skillName}/SKILL.md --auto-synthetic`,
    );
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("expected a JSON array");
    }
    return parsed as EvalEntry[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CLIError(
      `Eval set at ${path} is invalid: ${message}`,
      "INVALID_FLAG",
      `Regenerate the eval set with selftune eval generate --skill ${skillName}`,
    );
  }
}

function resolveReplayAgent(requestedAgent?: string | null): string {
  if (requestedAgent) {
    if (!isLlmBackedAgent(requestedAgent)) {
      throw new CLIError(
        `Unsupported --agent value "${requestedAgent}".`,
        "INVALID_FLAG",
        "Use claude, codex, opencode, or pi.",
      );
    }
    if (!Bun.which(requestedAgent)) {
      throw new CLIError(
        `Agent CLI '${requestedAgent}' not found in PATH`,
        "AGENT_NOT_FOUND",
        "Install it or omit --agent to use auto-detection",
      );
    }
    return requestedAgent;
  }

  const detected = detectLlmAgent();
  if (!detected) {
    throw new CLIError(
      "No supported runtime replay agent was found in PATH.",
      "AGENT_NOT_FOUND",
      "Install Claude Code, Codex, OpenCode, or Pi, or pass --agent explicitly.",
    );
  }
  return detected;
}

function buildReplayContent(
  skillContent: string,
  mode: CreateReplayMode,
): {
  content: string;
  contentTarget: "routing" | "body";
} {
  const parsed = parseSkillSections(skillContent);
  if (mode === "routing") {
    return {
      content: parsed.sections["Workflow Routing"] ?? "",
      contentTarget: "routing",
    };
  }

  const bodyParts: string[] = [];
  if (parsed.description.trim()) {
    bodyParts.push(parsed.description.trim());
  }
  for (const [sectionName, sectionContent] of Object.entries(parsed.sections)) {
    bodyParts.push(`## ${sectionName}`);
    bodyParts.push("");
    bodyParts.push(sectionContent.trim());
    bodyParts.push("");
  }

  return {
    content: bodyParts.join("\n").trim(),
    contentTarget: "body",
  };
}

function persistReplayResults(
  proposalId: string,
  skillName: string,
  mode: CreateReplayMode,
  results: RoutingReplayEntryResult[],
): void {
  writeReplayEntryResultsToDb(
    results.map((result) => ({
      proposal_id: proposalId,
      skill_name: skillName,
      validation_mode: "host_replay",
      phase: `current_${mode}`,
      query: result.query,
      should_trigger: result.should_trigger,
      triggered: result.triggered,
      passed: result.passed,
      evidence: result.evidence,
    })),
  );
}

function sumKnownMetric(values: Array<number | null | undefined>): {
  total: number | null;
  count: number;
} {
  let total = 0;
  let count = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    total += value;
    count += 1;
  }
  return {
    total: count > 0 ? total : null,
    count,
  };
}

export function summarizeReplayRuntimeMetrics(
  results: RoutingReplayEntryResult[],
): RuntimeReplayAggregateMetrics {
  const evalRuns = results.length;
  const totalDurationMs = results.reduce(
    (sum, result) => sum + (result.runtime_metrics?.duration_ms ?? 0),
    0,
  );
  const inputTokens = sumKnownMetric(results.map((result) => result.runtime_metrics?.input_tokens));
  const outputTokens = sumKnownMetric(
    results.map((result) => result.runtime_metrics?.output_tokens),
  );
  const cacheCreationTokens = sumKnownMetric(
    results.map((result) => result.runtime_metrics?.cache_creation_input_tokens),
  );
  const cacheReadTokens = sumKnownMetric(
    results.map((result) => result.runtime_metrics?.cache_read_input_tokens),
  );
  const totalCost = sumKnownMetric(results.map((result) => result.runtime_metrics?.total_cost_usd));
  const totalTurns = sumKnownMetric(results.map((result) => result.runtime_metrics?.num_turns));
  const usageObservations = results.filter((result) => {
    const metrics = result.runtime_metrics;
    return Boolean(
      metrics &&
      (metrics.input_tokens != null ||
        metrics.output_tokens != null ||
        metrics.total_cost_usd != null ||
        metrics.num_turns != null),
    );
  }).length;

  return {
    eval_runs: evalRuns,
    usage_observations: usageObservations,
    total_duration_ms: totalDurationMs,
    avg_duration_ms: evalRuns > 0 ? totalDurationMs / evalRuns : 0,
    total_input_tokens: inputTokens.total,
    total_output_tokens: outputTokens.total,
    total_cache_creation_input_tokens: cacheCreationTokens.total,
    total_cache_read_input_tokens: cacheReadTokens.total,
    total_cost_usd: totalCost.total,
    total_turns: totalTurns.total,
  };
}

export async function runCreateReplay(
  options: RunCreateReplayOptions,
): Promise<CreateReplayResult> {
  const context = readCreateSkillContext(options.skillPath);
  const agent = resolveReplayAgent(options.agent);
  const platform = resolveRuntimeReplayPlatform(agent);
  if (!platform) {
    throw new CLIError(
      `Runtime replay is unavailable for agent "${agent}".`,
      "REPLAY_UNAVAILABLE",
      "Use claude, codex, or opencode for create replay.",
    );
  }

  const evalSet = loadCreateEvalSet(context.skill_name, options.evalSetPath);
  const { content, contentTarget } = buildReplayContent(context.skill_content, options.mode);
  const fixture = buildRoutingReplayFixture({
    skillName: context.skill_name,
    skillPath: context.skill_path,
    platform,
    stagingMode: options.mode,
  });

  const results = await runHostRuntimeReplayFixture({
    routing: content,
    evalSet,
    fixture,
    contentTarget,
    includeTargetSkill: options.includeTargetSkill,
    runtimeInvoker: options.runtimeInvoker,
  });

  const passed = results.filter((result) => result.passed).length;
  const total = results.length;
  const proposalId = `create-replay-${context.skill_name}-${options.mode}-${Date.now()}`;
  persistReplayResults(proposalId, context.skill_name, options.mode, results);
  const runtimeMetrics = summarizeReplayRuntimeMetrics(results);

  return {
    skill: context.skill_name,
    skill_path: context.skill_path,
    mode: options.mode,
    agent,
    proposal_id: proposalId,
    total,
    passed,
    failed: total - passed,
    pass_rate: total > 0 ? passed / total : 0,
    fixture_id: fixture.fixture_id,
    results,
    runtime_metrics: runtimeMetrics,
  };
}

function formatReplayResult(result: CreateReplayResult): string {
  return [
    `Skill: ${result.skill}`,
    `Mode: ${result.mode}`,
    `Agent: ${result.agent}`,
    `Pass rate: ${(result.pass_rate * 100).toFixed(1)}% (${result.passed}/${result.total})`,
    `Replay record: ${result.proposal_id}`,
  ].join("\n");
}

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "skill-path": { type: "string" },
      mode: { type: "string", default: "routing" },
      agent: { type: "string" },
      "eval-set": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createReplay));
    process.exit(0);
  }

  const mode = values.mode;
  if (mode !== "routing" && mode !== "package") {
    throw new CLIError(
      `Unsupported --mode value "${mode}".`,
      "INVALID_FLAG",
      "Use --mode routing or --mode package.",
    );
  }

  const result = await runCreateReplay({
    skillPath: values["skill-path"] ?? "",
    mode,
    agent: values.agent,
    evalSetPath: values["eval-set"],
  });

  if (values.json || !process.stdout.isTTY) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReplayResult(result));
  }

  process.exit(result.failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
