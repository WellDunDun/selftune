import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { CLIError } from "../utils/cli-error.js";
import { callLlm, detectLlmAgent, stripMarkdownFences } from "../utils/llm-call.js";
import type { SkillAssertion } from "../types.js";
import { checkAssertion } from "./unit-test.js";

export interface OutputEvalCase {
  readonly id: string | number;
  readonly prompt: string;
  readonly expected_output: string;
  readonly files?: readonly string[];
  readonly assertions?: readonly string[];
  readonly selftune_assertions?: readonly SkillAssertion[];
}

export interface OutputEvalFile {
  readonly skill_name: string;
  readonly evals: readonly OutputEvalCase[];
}

export interface OutputEvalRunInput {
  readonly skillPath: string;
  readonly evalsPath?: string;
  readonly workspacePath?: string;
  readonly baselineSkillPath?: string;
  readonly feedbackPath?: string;
  readonly agent?: string;
  readonly model?: string;
}

export interface OutputEvalRunDeps {
  readonly execute?: (input: {
    system: string;
    prompt: string;
    agent: string;
    model?: string;
    workingDirectory: string;
  }) => Promise<{ output: string; totalTokens: number | null }>;
  readonly grade?: (input: {
    expectedOutput: string;
    assertions: readonly string[];
    output: string;
    agent: string;
    model?: string;
  }) => Promise<readonly GradingAssertionResult[]>;
  readonly compare?: (input: {
    prompt: string;
    outputA: string;
    outputB: string;
    agent: string;
    model?: string;
  }) => Promise<{ winner: "A" | "B" | "tie"; evidence: string }>;
}

interface GradingAssertionResult {
  readonly text: string;
  readonly passed: boolean;
  readonly evidence: string;
}

interface ArmResult {
  readonly pass_rate: number;
  readonly duration_ms: number;
  readonly total_tokens: number | null;
  readonly grading: {
    readonly assertion_results: readonly GradingAssertionResult[];
    readonly summary: {
      readonly passed: number;
      readonly failed: number;
      readonly total: number;
      readonly pass_rate: number;
    };
  };
  readonly output: string;
}

function skillFile(path: string): string {
  const absolute = resolve(path);
  return basename(absolute) === "SKILL.md" ? absolute : join(absolute, "SKILL.md");
}

export function loadOutputEvalFile(path: string): OutputEvalFile {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("skill_name" in parsed) ||
    typeof parsed.skill_name !== "string" ||
    !("evals" in parsed) ||
    !Array.isArray(parsed.evals)
  ) {
    throw new CLIError(
      `Invalid Agent Skills eval file: ${path}`,
      "INVALID_FLAG",
      "Use evals/evals.json with skill_name and evals fields.",
    );
  }
  for (const entry of parsed.evals) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("id" in entry) ||
      !("prompt" in entry) ||
      typeof entry.prompt !== "string" ||
      !("expected_output" in entry) ||
      typeof entry.expected_output !== "string"
    ) {
      throw new CLIError(
        `Invalid eval case in ${path}`,
        "INVALID_FLAG",
        "Every case needs id, prompt, and expected_output.",
      );
    }
  }
  return parsed as OutputEvalFile;
}

function nextIteration(workspace: string): number {
  if (!existsSync(workspace)) return 1;
  const entries = new Bun.Glob("iteration-*").scanSync({ cwd: workspace, onlyFiles: false });
  return (
    Math.max(
      0,
      ...[...entries]
        .map((entry) => Number(entry.slice("iteration-".length)))
        .filter(Number.isFinite),
    ) + 1
  );
}

function safeCaseName(entry: OutputEvalCase): string {
  const value = String(entry.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `eval-${value || "case"}`;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

async function defaultExecute(input: {
  system: string;
  prompt: string;
  agent: string;
  model?: string;
  workingDirectory: string;
}) {
  return {
    output: await callLlm(
      input.system,
      input.prompt,
      input.agent,
      input.model,
      undefined,
      undefined,
      input.workingDirectory,
    ),
    totalTokens: null,
  };
}

async function defaultCompare(input: {
  prompt: string;
  outputA: string;
  outputB: string;
  agent: string;
  model?: string;
}): Promise<{ winner: "A" | "B" | "tie"; evidence: string }> {
  const response = await callLlm(
    "Blindly compare two outputs. Do not infer which used a skill. Return only JSON with winner A, B, or tie and concrete evidence.",
    JSON.stringify({ prompt: input.prompt, output_a: input.outputA, output_b: input.outputB }),
    input.agent,
    input.model,
  );
  return JSON.parse(stripMarkdownFences(response)) as {
    winner: "A" | "B" | "tie";
    evidence: string;
  };
}

async function defaultGrade(input: {
  expectedOutput: string;
  assertions: readonly string[];
  output: string;
  agent: string;
  model?: string;
}): Promise<readonly GradingAssertionResult[]> {
  if (input.assertions.length === 0) return [];
  const response = await callLlm(
    "You grade output assertions strictly. Return only JSON. A PASS requires concrete evidence from the output.",
    JSON.stringify({
      expected_output: input.expectedOutput,
      assertions: input.assertions,
      output: input.output,
      response_schema: {
        assertion_results: [
          { text: "assertion", passed: true, evidence: "specific output evidence" },
        ],
      },
    }),
    input.agent,
    input.model,
  );
  const parsed = JSON.parse(stripMarkdownFences(response)) as {
    assertion_results?: GradingAssertionResult[];
  };
  return parsed.assertion_results ?? [];
}

function copyInputs(entry: OutputEvalCase, skillDir: string, runDir: string): string[] {
  const copied: string[] = [];
  for (const relative of entry.files ?? []) {
    const source = resolve(skillDir, relative);
    if (!source.startsWith(`${skillDir}/`) || !existsSync(source)) {
      throw new CLIError(
        `Eval input file not found or outside the skill: ${relative}`,
        "FILE_NOT_FOUND",
        "Keep eval inputs under the skill directory.",
      );
    }
    const target = join(runDir, "inputs", relative.replace(/^evals\/files\//, ""));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
    copied.push(target);
  }
  return copied;
}

async function runArm(
  entry: OutputEvalCase,
  runDir: string,
  skillContent: string | null,
  skillDir: string,
  agent: string,
  model: string | undefined,
  deps: OutputEvalRunDeps,
): Promise<ArmResult> {
  mkdirSync(join(runDir, "outputs"), { recursive: true });
  const files = copyInputs(entry, skillDir, runDir);
  const system =
    skillContent == null
      ? "Complete the task without access to the evaluated skill."
      : `Follow this Agent Skill exactly:\n\n${skillContent}`;
  const started = Date.now();
  const execution = await (deps.execute ?? defaultExecute)({
    system,
    prompt: `${entry.prompt}\n\nInput files: ${files.join(", ") || "none"}\nSave or describe the completed output.`,
    agent,
    model,
    workingDirectory: runDir,
  });
  const duration = Date.now() - started;
  const totalTokens = execution.totalTokens ?? Math.ceil(execution.output.length / 4);
  writeFileSync(join(runDir, "outputs", "response.md"), execution.output, "utf-8");
  writeFileSync(
    join(runDir, "timing.json"),
    JSON.stringify(
      {
        total_tokens: totalTokens,
        token_measurement: execution.totalTokens == null ? "estimated" : "reported",
        duration_ms: duration,
      },
      null,
      2,
    ),
    "utf-8",
  );

  const judged = await (deps.grade ?? defaultGrade)({
    expectedOutput: entry.expected_output,
    assertions: entry.assertions ?? [],
    output: execution.output,
    agent,
    model,
  });
  const mechanical = (entry.selftune_assertions ?? []).map((assertion) => {
    const result = checkAssertion(assertion, execution.output);
    return {
      text: assertion.description ?? `${assertion.type}: ${assertion.value}`,
      passed: result.passed,
      evidence: result.actual ?? "No mechanical evidence was produced.",
    };
  });
  const assertionResults = [...judged, ...mechanical];
  const passed = assertionResults.filter((result) => result.passed).length;
  const total = assertionResults.length;
  const grading = {
    assertion_results: assertionResults,
    summary: { passed, failed: total - passed, total, pass_rate: total === 0 ? 0 : passed / total },
  };
  writeFileSync(join(runDir, "grading.json"), JSON.stringify(grading, null, 2), "utf-8");
  return {
    pass_rate: grading.summary.pass_rate,
    duration_ms: duration,
    total_tokens: totalTokens,
    grading,
    output: execution.output,
  };
}

export async function runOutputQualityEvaluation(
  input: OutputEvalRunInput,
  deps: OutputEvalRunDeps = {},
) {
  const currentSkillFile = skillFile(input.skillPath);
  if (!existsSync(currentSkillFile))
    throw new CLIError(
      `SKILL.md not found: ${currentSkillFile}`,
      "FILE_NOT_FOUND",
      "Pass --skill-path to a valid skill package.",
    );
  const skillDir = dirname(currentSkillFile);
  const evalsPath = resolve(input.evalsPath ?? join(skillDir, "evals", "evals.json"));
  const contract = loadOutputEvalFile(evalsPath);
  const agent = input.agent ?? detectLlmAgent();
  if (!agent)
    throw new CLIError(
      "No supported agent CLI found",
      "AGENT_NOT_FOUND",
      "Install Claude, Codex, OpenCode, or Pi.",
    );
  const workspace = resolve(
    input.workspacePath ?? join(dirname(skillDir), `${contract.skill_name}-workspace`),
  );
  const iterationNumber = nextIteration(workspace);
  const iterationDir = join(workspace, `iteration-${iterationNumber}`);
  mkdirSync(iterationDir, { recursive: true });
  const currentContent = readFileSync(currentSkillFile, "utf-8");
  const baselineContent = input.baselineSkillPath
    ? readFileSync(skillFile(input.baselineSkillPath), "utf-8")
    : null;
  const baselineArm = baselineContent ? "old_skill" : "without_skill";
  const caseResults: Array<{
    id: string | number;
    with_skill: ArmResult;
    baseline: ArmResult;
    blind_comparison: { winner: "with_skill" | "baseline" | "tie"; evidence: string };
  }> = [];

  for (const entry of contract.evals) {
    const caseDir = join(iterationDir, safeCaseName(entry));
    const withSkill = await runArm(
      entry,
      join(caseDir, "with_skill"),
      currentContent,
      skillDir,
      agent,
      input.model,
      deps,
    );
    const baseline = await runArm(
      entry,
      join(caseDir, baselineArm),
      baselineContent,
      skillDir,
      agent,
      input.model,
      deps,
    );
    const swap = Number(entry.id) % 2 === 0;
    const comparison = await (deps.compare ?? defaultCompare)({
      prompt: entry.prompt,
      outputA: swap ? baseline.output : withSkill.output,
      outputB: swap ? withSkill.output : baseline.output,
      agent,
      model: input.model,
    });
    const winner =
      comparison.winner === "tie"
        ? "tie"
        : comparison.winner === (swap ? "B" : "A")
          ? "with_skill"
          : "baseline";
    caseResults.push({
      id: entry.id,
      with_skill: withSkill,
      baseline,
      blind_comparison: { winner, evidence: comparison.evidence },
    });
  }

  const summarize = (values: readonly ArmResult[]) => ({
    pass_rate: {
      mean: mean(values.map((value) => value.pass_rate)),
      stddev: stddev(values.map((value) => value.pass_rate)),
    },
    time_seconds: {
      mean: mean(values.map((value) => value.duration_ms / 1000)),
      stddev: stddev(values.map((value) => value.duration_ms / 1000)),
    },
    tokens: {
      mean: mean(
        values.flatMap((value) => (value.total_tokens == null ? [] : [value.total_tokens])),
      ),
      stddev: stddev(
        values.flatMap((value) => (value.total_tokens == null ? [] : [value.total_tokens])),
      ),
    },
  });
  const withSummary = summarize(caseResults.map((result) => result.with_skill));
  const baselineSummary = summarize(caseResults.map((result) => result.baseline));
  const assertionPairs = caseResults.flatMap((result) => {
    const baselineByText = new Map(
      result.baseline.grading.assertion_results.map((assertion) => [assertion.text, assertion]),
    );
    return result.with_skill.grading.assertion_results.flatMap((withSkill) => {
      const baseline = baselineByText.get(withSkill.text);
      return baseline ? [{ id: result.id, text: withSkill.text, withSkill, baseline }] : [];
    });
  });
  const alwaysPass = assertionPairs
    .filter((pair) => pair.withSkill.passed && pair.baseline.passed)
    .map((pair) => ({ eval_id: pair.id, assertion: pair.text }));
  const alwaysFail = assertionPairs
    .filter((pair) => !pair.withSkill.passed && !pair.baseline.passed)
    .map((pair) => ({ eval_id: pair.id, assertion: pair.text }));
  const benchmark = {
    iteration: iterationNumber,
    skill_name: contract.skill_name,
    baseline: baselineArm,
    run_summary: {
      with_skill: withSummary,
      [baselineArm]: baselineSummary,
      delta: {
        pass_rate: withSummary.pass_rate.mean - baselineSummary.pass_rate.mean,
        time_seconds: withSummary.time_seconds.mean - baselineSummary.time_seconds.mean,
        tokens: withSummary.tokens.mean - baselineSummary.tokens.mean,
      },
    },
    assertion_analysis: { always_pass_both_arms: alwaysPass, always_fail_both_arms: alwaysFail },
    cases: caseResults.map((result) => ({
      id: result.id,
      with_skill_pass_rate: result.with_skill.pass_rate,
      baseline_pass_rate: result.baseline.pass_rate,
      blind_comparison: result.blind_comparison,
    })),
  };
  writeFileSync(join(iterationDir, "benchmark.json"), JSON.stringify(benchmark, null, 2), "utf-8");
  const feedback =
    input.feedbackPath && existsSync(input.feedbackPath)
      ? JSON.parse(readFileSync(input.feedbackPath, "utf-8"))
      : Object.fromEntries(contract.evals.map((entry) => [safeCaseName(entry), ""]));
  writeFileSync(join(iterationDir, "feedback.json"), JSON.stringify(feedback, null, 2), "utf-8");
  return { iteration_dir: iterationDir, benchmark };
}
