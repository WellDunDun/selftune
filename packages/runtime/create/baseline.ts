import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "../command-surface.js";
import { emitDashboardStepProgress } from "../dashboard-action-instrumentation.js";
import { writeGradingBaseline } from "../localdb/direct-write.js";
import type {
  BaselineResult,
  EvalEntry,
  RuntimeReplayAggregateMetrics,
  TokenUsageMetrics,
} from "../types.js";
import { CLIError, handleCLIError } from "../utils/cli-error.js";
import { detectLlmAgent } from "../utils/llm-call.js";
import { measureBaseline } from "../eval/baseline.js";
import { readCanonicalPackageEvaluationArtifact } from "../testing-readiness.js";
import { readCreateSkillContext } from "./readiness.js";
import { computeCreatePackageFingerprint } from "./package-fingerprint.js";
import {
  loadCreateEvalSet,
  runCreateReplay,
  type CreateReplayResult,
  type CreateReplayMode,
  type RunCreateReplayOptions,
} from "./replay.js";

export interface CreateBaselineResult {
  skill_name: string;
  mode: CreateReplayMode;
  baseline_pass_rate: number;
  with_skill_pass_rate: number;
  lift: number;
  adds_value: boolean;
  per_entry: BaselineResult[];
  measured_at: string;
  runtime_metrics?: {
    with_skill: RuntimeReplayAggregateMetrics;
    without_skill: RuntimeReplayAggregateMetrics;
  };
}

export interface CreateBaselineDeps {
  runCreateReplay?: (
    options: RunCreateReplayOptions,
  ) => Promise<Awaited<ReturnType<typeof runCreateReplay>>>;
  measureBaseline?: typeof measureBaseline;
  emitDashboardStepProgress?: typeof emitDashboardStepProgress;
  readCanonicalPackageEvaluationArtifact?: typeof readCanonicalPackageEvaluationArtifact;
  computeCreatePackageFingerprint?: typeof computeCreatePackageFingerprint;
}

export interface RunCreateBaselineOptions {
  skillPath: string;
  mode: CreateReplayMode;
  agent?: string;
  evalSetPath?: string;
  withSkillReplayResult?: CreateReplayResult;
}

function chooseBaselineAgent(requestedAgent?: string): string {
  if (requestedAgent) return requestedAgent;
  const detected = detectLlmAgent();
  if (!detected) {
    throw new CLIError(
      "No supported agent CLI was found in PATH.",
      "AGENT_NOT_FOUND",
      "Install Claude Code, Codex, OpenCode, or Pi, or pass --agent explicitly.",
    );
  }
  return detected;
}

function buildReplayTokenUsage(
  result: CreateReplayResult["results"][number],
): TokenUsageMetrics | undefined {
  const inputTokens = result.runtime_metrics?.input_tokens;
  const outputTokens = result.runtime_metrics?.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    return undefined;
  }
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    ...(typeof result.runtime_metrics?.total_cost_usd === "number"
      ? { estimated_cost_usd: result.runtime_metrics.total_cost_usd }
      : {}),
  };
}

type PackageEvaluationArtifact = NonNullable<
  ReturnType<typeof readCanonicalPackageEvaluationArtifact>
>;

function emitBaselineStepProgress(
  deps: CreateBaselineDeps,
  options: {
    current: number;
    total: number;
    status: "started" | "finished";
    phase: string;
    label: string;
    passed?: boolean | null;
    evidence?: string | null;
  },
): void {
  (deps.emitDashboardStepProgress ?? emitDashboardStepProgress)({
    current: options.current,
    total: options.total,
    status: options.status,
    phase: options.phase,
    label: options.label,
    unit: "step",
    passed: options.passed ?? null,
    evidence: options.evidence ?? null,
  });
}

function replayMatchesEvalSet(replay: CreateReplayResult, evalSet: EvalEntry[]): boolean {
  if (replay.results.length !== evalSet.length) return false;

  return replay.results.every((result, index) => {
    const entry = evalSet[index];
    return (
      entry != null &&
      result.query === entry.query &&
      result.should_trigger === entry.should_trigger
    );
  });
}

function canReuseCachedWithSkillReplay(
  cached: PackageEvaluationArtifact | null,
  agent: string,
  skillName: string,
  skillPath: string,
  packageFingerprint: string | null,
  evalSet: EvalEntry[],
): cached is PackageEvaluationArtifact {
  if (!cached || !packageFingerprint) return false;
  if (cached.summary.mode !== "package") return false;
  if (cached.summary.skill_name !== skillName) return false;
  if (cached.summary.skill_path !== skillPath) return false;
  if (cached.summary.package_fingerprint !== packageFingerprint) return false;
  if (cached.summary.replay.agent !== agent) return false;
  if (cached.summary.replay.validation_mode !== "host_replay") return false;
  if (cached.replay.mode !== "package") return false;
  if (!replayMatchesEvalSet(cached.replay, evalSet)) return false;
  return true;
}

function readReusableWithSkillReplay(
  options: RunCreateBaselineOptions,
  skillName: string,
  skillPath: string,
  agent: string,
  deps: CreateBaselineDeps,
): CreateReplayResult | null {
  try {
    const packageFingerprint = (
      deps.computeCreatePackageFingerprint ?? computeCreatePackageFingerprint
    )(skillPath);
    const evalSet = loadCreateEvalSet(skillName, options.evalSetPath);
    const cached = (
      deps.readCanonicalPackageEvaluationArtifact ?? readCanonicalPackageEvaluationArtifact
    )(skillName);
    if (
      !canReuseCachedWithSkillReplay(
        cached,
        agent,
        skillName,
        skillPath,
        packageFingerprint,
        evalSet,
      )
    ) {
      return null;
    }
    return cached.replay;
  } catch {
    return null;
  }
}

export function summarizePackageBaselineResults(
  skillName: string,
  withSkillResults: CreateReplayResult,
  baselineResults: CreateReplayResult,
): CreateBaselineResult {
  const measuredAt = new Date().toISOString();
  const perEntry: BaselineResult[] = [];
  for (const result of baselineResults.results) {
    perEntry.push({
      skill_name: skillName,
      query: result.query,
      with_skill: false,
      triggered: result.triggered,
      pass: result.passed,
      evidence: result.evidence,
      ...(typeof result.runtime_metrics?.duration_ms === "number"
        ? { latency_ms: result.runtime_metrics.duration_ms }
        : {}),
      ...(buildReplayTokenUsage(result) ? { tokens: buildReplayTokenUsage(result) } : {}),
      measured_at: measuredAt,
    });
  }
  for (const result of withSkillResults.results) {
    perEntry.push({
      skill_name: skillName,
      query: result.query,
      with_skill: true,
      triggered: result.triggered,
      pass: result.passed,
      evidence: result.evidence,
      ...(typeof result.runtime_metrics?.duration_ms === "number"
        ? { latency_ms: result.runtime_metrics.duration_ms }
        : {}),
      ...(buildReplayTokenUsage(result) ? { tokens: buildReplayTokenUsage(result) } : {}),
      measured_at: measuredAt,
    });
  }

  const lift = withSkillResults.pass_rate - baselineResults.pass_rate;
  return {
    skill_name: skillName,
    mode: "package",
    baseline_pass_rate: baselineResults.pass_rate,
    with_skill_pass_rate: withSkillResults.pass_rate,
    lift,
    adds_value: lift >= 0.05,
    per_entry: perEntry,
    measured_at: measuredAt,
    runtime_metrics: {
      with_skill: withSkillResults.runtime_metrics,
      without_skill: baselineResults.runtime_metrics,
    },
  };
}

export async function runCreateBaseline(
  options: RunCreateBaselineOptions,
  deps: CreateBaselineDeps = {},
): Promise<CreateBaselineResult> {
  const context = readCreateSkillContext(options.skillPath);
  const agent = chooseBaselineAgent(options.agent);

  if (options.mode === "routing") {
    const evalSet = loadCreateEvalSet(context.skill_name, options.evalSetPath);
    const result = await (deps.measureBaseline ?? measureBaseline)({
      evalSet,
      skillDescription: readFileSync(context.skill_path, "utf-8"),
      skillName: context.skill_name,
      agent,
    });
    return {
      skill_name: result.skill_name,
      mode: "routing",
      baseline_pass_rate: result.baseline_pass_rate,
      with_skill_pass_rate: result.with_skill_pass_rate,
      lift: result.lift,
      adds_value: result.adds_value,
      per_entry: result.per_entry,
      measured_at: result.measured_at,
    };
  }

  const replay = deps.runCreateReplay ?? runCreateReplay;
  const reusedWithSkillReplay =
    options.withSkillReplayResult == null
      ? readReusableWithSkillReplay(options, context.skill_name, context.skill_path, agent, deps)
      : null;

  emitBaselineStepProgress(deps, {
    current: 1,
    total: 2,
    status: "started",
    phase: "with_skill_replay",
    label: "Replay with draft package enabled",
    evidence:
      reusedWithSkillReplay != null
        ? "Reusing fresh package replay from the canonical artifact"
        : null,
  });
  let withSkillResults: CreateReplayResult;
  try {
    withSkillResults =
      options.withSkillReplayResult ??
      reusedWithSkillReplay ??
      (await replay({
        skillPath: context.skill_path,
        mode: "package",
        agent,
        evalSetPath: options.evalSetPath,
      }));
    emitBaselineStepProgress(deps, {
      current: 1,
      total: 2,
      status: "finished",
      phase: "with_skill_replay",
      label: "Replay with draft package enabled",
      passed: true,
      evidence:
        reusedWithSkillReplay != null
          ? `Reused fresh package replay at ${(withSkillResults.pass_rate * 100).toFixed(1)}% pass rate`
          : `Finished with ${(withSkillResults.pass_rate * 100).toFixed(1)}% pass rate`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitBaselineStepProgress(deps, {
      current: 1,
      total: 2,
      status: "finished",
      phase: "with_skill_replay",
      label: "Replay with draft package enabled",
      passed: false,
      evidence: message,
    });
    throw error;
  }

  emitBaselineStepProgress(deps, {
    current: 2,
    total: 2,
    status: "started",
    phase: "without_skill_replay",
    label: "Replay with the target skill hidden",
  });
  let baselineResults: CreateReplayResult;
  try {
    baselineResults = await replay({
      skillPath: context.skill_path,
      mode: "package",
      agent,
      evalSetPath: options.evalSetPath,
      includeTargetSkill: false,
    });
    emitBaselineStepProgress(deps, {
      current: 2,
      total: 2,
      status: "finished",
      phase: "without_skill_replay",
      label: "Replay with the target skill hidden",
      passed: true,
      evidence: `Finished with ${(baselineResults.pass_rate * 100).toFixed(1)}% pass rate`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitBaselineStepProgress(deps, {
      current: 2,
      total: 2,
      status: "finished",
      phase: "without_skill_replay",
      label: "Replay with the target skill hidden",
      passed: false,
      evidence: message,
    });
    throw error;
  }

  return summarizePackageBaselineResults(context.skill_name, withSkillResults, baselineResults);
}

function formatBaselineResult(result: CreateBaselineResult): string {
  return [
    `Skill: ${result.skill_name}`,
    `Mode: ${result.mode}`,
    `Baseline pass rate: ${(result.baseline_pass_rate * 100).toFixed(1)}%`,
    `With-skill pass rate: ${(result.with_skill_pass_rate * 100).toFixed(1)}%`,
    `Lift: ${result.lift.toFixed(3)}`,
    `Adds value: ${result.adds_value ? "yes" : "no"}`,
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
    console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createBaseline));
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

  const result = await runCreateBaseline({
    skillPath: values["skill-path"] ?? "",
    mode,
    agent: values.agent,
    evalSetPath: values["eval-set"],
  });

  writeGradingBaseline({
    skill_name: result.skill_name,
    proposal_id: null,
    measured_at: result.measured_at,
    pass_rate: result.with_skill_pass_rate,
    mean_score: null,
    sample_size: result.per_entry.filter((entry) => entry.with_skill).length,
    grading_results_json: JSON.stringify(result),
  });

  if (values.json || !process.stdout.isTTY) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatBaselineResult(result));
  }

  process.exit(result.adds_value ? 0 : 1);
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
