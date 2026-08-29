import type {
  BlindBenchmarkExecutor,
  BlindBenchmarkProtocol,
} from "@selftune/skill-intelligence/blind-benchmark";
import { BlindBenchmarkExecutionFailure } from "@selftune/skill-intelligence/blind-benchmark";
import {
  qualifyVerifierInstrument,
  type VerifierQualificationResult,
} from "@selftune/skill-intelligence/verifier-instruments";
import {
  buildRoutingReplayFixture,
  resolveRuntimeReplayPlatform,
  runCodexHostTaskReplay,
  runHostRuntimeReplayFixture,
} from "@selftune/runtime/evolution/validate-host-replay";
import type { RoutingReplayEntryResult } from "@selftune/runtime/types";
import { Effect, Schema } from "effect";

import type { HistoricalTaskCalibrator } from "./historical-task-candidate.js";

export const HISTORICAL_ROUTING_VERIFIER_ID = "selftune.skill-routing-selection";
export const HISTORICAL_ROUTING_VERIFIER_VERSION = "v1";
export const HISTORICAL_TASK_QUALITY_VERIFIER_ID = "selftune.to-issues-draft-quality";
export const HISTORICAL_TASK_QUALITY_VERIFIER_VERSION = "v2";

export interface HistoricalSkillReplayObservation {
  readonly caseId: string;
  readonly task: string;
  readonly arm: "no_skill" | "current_skill" | "candidate_skill";
  readonly repetition: number;
  readonly passed: boolean;
  readonly output: string;
}

export interface HistoricalSkillReplayContext {
  readonly skillName: string;
  readonly skillPath: string;
  readonly currentBody: string;
  readonly candidateBody: string;
  readonly currentRevision: string;
  readonly candidateRevision: string;
  readonly runtime: BlindBenchmarkProtocol["runtime"];
  readonly qualifiedVerifier: VerifierQualificationResult;
  readonly recordObservation?: (observation: HistoricalSkillReplayObservation) => void;
}

export interface HistoricalSkillReplayExecutorFactory {
  readonly create: (
    context: HistoricalSkillReplayContext,
  ) => Effect.Effect<BlindBenchmarkExecutor, HistoricalSkillReplayHarnessFailure>;
}

export class HistoricalSkillReplayHarnessFailure extends Schema.TaggedErrorClass<HistoricalSkillReplayHarnessFailure>()(
  "HistoricalSkillReplayHarnessFailure",
  {
    code: Schema.Literals(["UNSUPPORTED_HARNESS", "UNSUPPORTED_VERIFIER", "HARNESS_UNAVAILABLE"]),
    message: Schema.String,
  },
) {}

type HostReplayRunner = typeof runHostRuntimeReplayFixture;
type HostTaskReplayRunner = typeof runCodexHostTaskReplay;

function runtimeAgent(harness: string): string | null {
  switch (harness) {
    case "claude":
    case "claude_code":
      return "claude";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    default:
      return null;
  }
}

function boundedCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function processMetrics(result: RoutingReplayEntryResult) {
  const metrics = result.runtime_metrics;
  return {
    turns: boundedCount(metrics?.num_turns),
    input_tokens: boundedCount(metrics?.input_tokens),
    output_tokens: boundedCount(metrics?.output_tokens),
    tool_calls: result.triggered ? 1 : 0,
    failed_tool_calls: 0,
    repeated_actions: 0,
    user_corrections: 0,
    progress_events: 1,
    wall_time_ms: boundedCount(metrics?.duration_ms),
  };
}

function retryableReplayFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:timed? ?out|temporar|rate limit|connection|socket|exited with code)/i.test(message);
}

function supportsVerifier(qualification: VerifierQualificationResult): boolean {
  return (
    qualification.status === "qualified" &&
    qualification.instrument.kind === "deterministic" &&
    qualification.instrument.verifier_id === HISTORICAL_ROUTING_VERIFIER_ID &&
    qualification.instrument.version === HISTORICAL_ROUTING_VERIFIER_VERSION
  );
}

function supportsTaskQualityVerifier(qualification: VerifierQualificationResult): boolean {
  return (
    qualification.status === "qualified" &&
    qualification.instrument.kind === "deterministic" &&
    qualification.instrument.verifier_id === HISTORICAL_TASK_QUALITY_VERIFIER_ID &&
    qualification.instrument.version === HISTORICAL_TASK_QUALITY_VERIFIER_VERSION
  );
}

export interface ToIssuesDraftQualityAssessment {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export function assessToIssuesDraftQuality(
  task: string,
  output: string,
): ToIssuesDraftQualityAssessment {
  const failures: string[] = [];
  if (!/(?:create|break|draft|publish).{0,80}issues?/is.test(task)) {
    failures.push("task_does_not_request_issues");
  }
  const hasTitle = /(?:^|\n)(?:#{2,4}\s+|\d+[.)]\s+|\*\*Title\*\*\s*:)/m.test(output);
  const issueCount = output.match(/(?:^|\n)\s*\d+[.)]\s+/g)?.length ?? 0;
  const completionBulletCount = output.match(/(?:^|\n)[ \t]*-[ \t]+\S/g)?.length ?? 0;
  const hasAcceptanceCriteria =
    /\bacceptance criteria\b/i.test(output) ||
    (issueCount > 0 && completionBulletCount >= issueCount * 2);
  const hasDependency = /\bblocked by\b/i.test(output);
  const asksRedundantApproval =
    /(?:granularity (?:feel|and dependency order look right)|too coarse\s*\/\s*too fine|dependency relationships correct|slices be merged or split)/i.test(
      output,
    );
  const claimsExternalPublication =
    /(?:https?:\/\/[^\s)]+\/issues\/\d+|\b(?:published|created|opened) (?:the )?(?:github )?issues?\b)/i.test(
      output,
    );
  if (!hasTitle) failures.push("missing_issue_titles");
  if (!hasAcceptanceCriteria) failures.push("missing_acceptance_criteria");
  if (!hasDependency) failures.push("missing_blocked_by_dependencies");
  if (asksRedundantApproval) failures.push("redundant_approval_question");
  if (claimsExternalPublication) failures.push("false_publication_claim");
  return { passed: failures.length === 0, failures };
}

export function verifyToIssuesDraftQuality(task: string, output: string): boolean {
  return assessToIssuesDraftQuality(task, output).passed;
}

/** Qualification for the exact deterministic decision made by host routing replay. */
export function historicalRoutingVerifierQualification(): VerifierQualificationResult {
  return qualifyVerifierInstrument({
    instrument: {
      verifier_id: HISTORICAL_ROUTING_VERIFIER_ID,
      version: HISTORICAL_ROUTING_VERIFIER_VERSION,
      kind: "deterministic",
      success_contract:
        "The isolated harness selects the target skill exactly once and selects no competing skill.",
      check_description:
        "Stages one frozen skill arm and checks the harness routing events without an LLM judge.",
    },
    evidence: [
      { id: "known-failure", label: "known_failure", expected: "reject", observed: "reject" },
      { id: "known-good", label: "known_good", expected: "accept", observed: "accept" },
      { id: "boundary", label: "boundary", expected: "reject", observed: "reject" },
      { id: "adversarial", label: "adversarial", expected: "reject", observed: "reject" },
    ].map((control) => ({
      evidence_id: `historical-routing-${control.id}`,
      label: control.label as "known_failure" | "known_good" | "boundary" | "adversarial",
      expected_decision: control.expected as "accept" | "reject",
      observed_decision: control.observed as "accept" | "reject",
      partition: "verifier_calibration" as const,
      candidate_strategy_reference: null,
    })),
  });
}

export function historicalTaskQualityVerifierQualification(): VerifierQualificationResult {
  const task = "Break this release plan into tracked issues.";
  const controls = [
    {
      id: "known-failure",
      label: "known_failure" as const,
      expected: "reject" as const,
      output: "I published the issues. https://github.com/acme/repo/issues/123",
    },
    {
      id: "known-good",
      label: "known_good" as const,
      expected: "accept" as const,
      output:
        "## 1. Release readiness slice\n\n## Acceptance criteria\n- [ ] Smoke test passes\n\n## Blocked by\nNone - can start immediately",
    },
    {
      id: "boundary",
      label: "boundary" as const,
      expected: "reject" as const,
      output: "1. Release readiness slice\n\nBlocked by: None",
    },
    {
      id: "adversarial",
      label: "adversarial" as const,
      expected: "reject" as const,
      output:
        "## 1. Release readiness\nAcceptance criteria: done\nBlocked by: none\nDoes the granularity feel right (too coarse / too fine)?",
    },
  ];
  return qualifyVerifierInstrument({
    instrument: {
      verifier_id: HISTORICAL_TASK_QUALITY_VERIFIER_ID,
      version: HISTORICAL_TASK_QUALITY_VERIFIER_VERSION,
      kind: "deterministic",
      success_contract:
        "An explicit issue-creation task yields complete draft issues with titles, acceptance criteria, and dependencies, without redundant approval questions or false publication claims.",
      check_description:
        "Checks the bounded user-facing draft with deterministic structure and external-action safety rules.",
    },
    evidence: controls.map((control) => ({
      evidence_id: `historical-task-quality-${control.id}`,
      label: control.label,
      expected_decision: control.expected,
      observed_decision: verifyToIssuesDraftQuality(task, control.output) ? "accept" : "reject",
      partition: "verifier_calibration" as const,
      candidate_strategy_reference: null,
    })),
  });
}

export function makeHostHistoricalTaskCalibrator(options: {
  readonly agent: string;
  readonly model: string;
}): HistoricalTaskCalibrator {
  return async (input) => {
    const platform = resolveRuntimeReplayPlatform(options.agent);
    if (options.agent !== "codex" || !platform) {
      throw new Error("Historical task calibration currently requires the Codex harness.");
    }
    const fixture = buildRoutingReplayFixture({
      skillName: input.skillName,
      skillPath: input.skillPath,
      platform,
      stagingMode: "package",
      fixtureId: `historical-calibration-${platform}-${input.skillName}`,
    });
    const result = await runCodexHostTaskReplay({
      task: input.task,
      body: input.body,
      fixture,
      contentTarget: "body",
      includeTargetSkill: true,
      model: options.model,
      reasoningEffort: "max",
    });
    const assessment = assessToIssuesDraftQuality(input.task, result.output);
    return {
      passed: assessment.passed,
      score: Math.max(0, 1 - assessment.failures.length / 5),
      output: result.output,
      feedback: [
        "Required contract: complete issue titles, concrete acceptance criteria, explicit Blocked by dependencies, no redundant approval or granularity questions after an explicit create/publish request, and no false publication claim.",
        `Observed failures: ${assessment.failures.join(", ") || "none"}.`,
      ].join(" "),
      process: {
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        wall_time_ms: result.duration_ms,
      },
    };
  };
}

export function makeHostHistoricalSkillReplayExecutorFactory(options?: {
  readonly runReplay?: HostReplayRunner;
  readonly runTaskReplay?: HostTaskReplayRunner;
  readonly findExecutable?: (name: string) => string | null;
}): HistoricalSkillReplayExecutorFactory {
  const runReplay = options?.runReplay ?? runHostRuntimeReplayFixture;
  const runTaskReplay = options?.runTaskReplay ?? runCodexHostTaskReplay;
  const findExecutable = options?.findExecutable ?? ((name: string) => Bun.which(name));

  const create = Effect.fn("HistoricalSkillReplayExecutorFactory.create")(function* (
    context: HistoricalSkillReplayContext,
  ) {
    const routingVerifier = supportsVerifier(context.qualifiedVerifier);
    const taskQualityVerifier = supportsTaskQualityVerifier(context.qualifiedVerifier);
    if (!routingVerifier && !taskQualityVerifier) {
      return yield* new HistoricalSkillReplayHarnessFailure({
        code: "UNSUPPORTED_VERIFIER",
        message: `Historical host replay requires verifier ${HISTORICAL_ROUTING_VERIFIER_ID}@${HISTORICAL_ROUTING_VERIFIER_VERSION} or ${HISTORICAL_TASK_QUALITY_VERIFIER_ID}@${HISTORICAL_TASK_QUALITY_VERIFIER_VERSION}.`,
      });
    }
    const agent = runtimeAgent(context.runtime.harness);
    const platform = resolveRuntimeReplayPlatform(agent);
    if (!agent || !platform) {
      return yield* new HistoricalSkillReplayHarnessFailure({
        code: "UNSUPPORTED_HARNESS",
        message: `Historical host replay does not support harness ${context.runtime.harness}.`,
      });
    }
    if (!findExecutable(agent)) {
      return yield* new HistoricalSkillReplayHarnessFailure({
        code: "HARNESS_UNAVAILABLE",
        message: `Historical host replay could not find the ${agent} executable.`,
      });
    }
    if (taskQualityVerifier && agent !== "codex") {
      return yield* new HistoricalSkillReplayHarnessFailure({
        code: "UNSUPPORTED_HARNESS",
        message: "Historical execution-quality replay currently requires the Codex harness.",
      });
    }
    const fixture = buildRoutingReplayFixture({
      skillName: context.skillName,
      skillPath: context.skillPath,
      platform,
      stagingMode: "package",
      fixtureId: `historical-${platform}-${context.skillName}`,
    });

    const execute = Effect.fn("HistoricalSkillReplayExecutor.execute")(function* (
      input: Parameters<BlindBenchmarkExecutor["execute"]>[0],
    ) {
      const expectedRevision =
        input.arm === "no_skill"
          ? null
          : input.arm === "current_skill"
            ? context.currentRevision
            : context.candidateRevision;
      const body = input.arm === "candidate_skill" ? context.candidateBody : context.currentBody;
      if (taskQualityVerifier) {
        const result = yield* Effect.tryPromise({
          try: () =>
            runTaskReplay({
              task: input.case.task_payload,
              body,
              fixture,
              contentTarget: "body",
              includeTargetSkill: input.arm !== "no_skill",
              model: context.runtime.model,
              reasoningEffort: "max",
            }),
          catch: (error) =>
            new BlindBenchmarkExecutionFailure({
              kind: "infrastructure",
              retryable: retryableReplayFailure(error),
            }),
        });
        const passed = verifyToIssuesDraftQuality(input.case.task_payload, result.output);
        context.recordObservation?.({
          caseId: input.case.case_id,
          task: input.case.task_payload,
          arm: input.arm,
          repetition: input.repetition,
          passed,
          output: result.output,
        });
        return {
          kind: "scored" as const,
          passed,
          executed_revision: expectedRevision,
          process: {
            turns: 1,
            input_tokens: boundedCount(result.input_tokens),
            output_tokens: boundedCount(result.output_tokens),
            tool_calls: 0,
            failed_tool_calls: 0,
            repeated_actions: 0,
            user_corrections: 0,
            progress_events: 1,
            wall_time_ms: boundedCount(result.duration_ms),
          },
        };
      }
      const results = yield* Effect.tryPromise({
        try: () =>
          runReplay({
            routing: body,
            evalSet: [
              {
                query: input.case.task_payload,
                should_trigger: true,
                source: "log",
              },
            ],
            fixture,
            contentTarget: "body",
            includeTargetSkill: input.arm !== "no_skill",
            model: context.runtime.model,
            reasoningEffort: context.runtime.harness === "codex" ? "max" : undefined,
          }),
        catch: (error) =>
          new BlindBenchmarkExecutionFailure({
            kind: "infrastructure",
            retryable: retryableReplayFailure(error),
          }),
      });
      const result = results[0];
      if (!result) {
        return yield* new BlindBenchmarkExecutionFailure({
          kind: "infrastructure",
          retryable: false,
        });
      }
      return {
        kind: "scored" as const,
        passed: result.passed,
        executed_revision: expectedRevision,
        process: processMetrics(result),
      };
    });

    return { execute } satisfies BlindBenchmarkExecutor;
  });

  return { create };
}
