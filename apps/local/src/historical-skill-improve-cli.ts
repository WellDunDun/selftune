import { createHash } from "node:crypto";
import { dirname } from "node:path";

import {
  SELFTUNE_LOCAL_ANALYTICS_PATH,
  SELFTUNE_LOCAL_DATABASE_PATH,
} from "@selftune/config/paths";
import { LocalDatabaseService, makeLocalDatabaseLive } from "@selftune/local-store";
import { makeDuckDbNodeApiAnalyticalStoreLive } from "@selftune/observability/duckdb-node-api";
import { isLlmBackedAgent, type LlmBackedAgent } from "@selftune/runtime/utils/llm-call";
import { Effect, Layer } from "effect";

import {
  HistoricalSkillImprovement,
  makeHistoricalSkillImprovementLayer,
} from "./historical-skill-improvement-service.js";
import {
  historicalRoutingVerifierQualification,
  historicalTaskQualityVerifierQualification,
  HostHistoricalTaskCalibration,
  makeHostHistoricalTaskCalibrationLayer,
  HostHistoricalSkillReplay,
  HostHistoricalSkillReplayLive,
} from "./historical-skill-replay-executor.js";
import {
  executionPatternIdForSkill,
  makeTraceCandidatePreparationLayer,
} from "./trace-candidate-service.js";

export interface HistoricalSkillImproveCliInput {
  readonly skill: string;
  readonly skillPath: string;
  readonly agent?: string;
}

export interface HistoricalSkillImproveCliAttempt {
  readonly handled: boolean;
  readonly result?: {
    readonly mode: "historical_blind_replay";
    readonly source: "local_duckdb";
    readonly review_only: true;
    readonly skill: string;
    readonly agent: LlmBackedAgent;
    readonly student_model: string;
    readonly reasoning_effort: "max";
    readonly pattern_id: string;
    readonly status: "review_ready" | "not_ready" | "blocked";
    readonly evidence_level: "E0" | "E0.5" | "E2";
    readonly reason: string;
    readonly evaluation_id: string | null;
    readonly cohort_fingerprint: string | null;
    readonly cases: {
      readonly calibration: number;
      readonly selection: number;
      readonly audit_holdout: number;
      readonly active_regressions: number;
    };
    readonly search: {
      readonly requested_candidates: number;
      readonly generated_candidates: number;
      readonly calibrated_candidates: number;
      readonly required_calibration_repetitions: number;
      readonly current_calibration_passed_repetitions: number;
      readonly frontier_candidate_ids: readonly string[];
      readonly selected_candidate_id: string | null;
      readonly selection_method: "pareto_calibration_frontier";
      readonly candidate_summaries: readonly {
        readonly proposal_id: string;
        readonly calibration_passed: boolean;
        readonly scored_repetitions: number;
        readonly passed_repetitions: number;
        readonly calibration_score: number;
        readonly changed_lines: number;
        readonly input_tokens: number | null;
        readonly output_tokens: number | null;
        readonly wall_time_ms: number | null;
        readonly frontier_member: boolean;
        readonly selected: boolean;
      }[];
    } | null;
    readonly applies_change: false;
    readonly before_after?: {
      readonly case_id: string;
      readonly task: string;
      readonly current: { readonly passed: boolean; readonly output: string };
      readonly candidate: { readonly passed: boolean; readonly output: string };
    } | null;
  };
}

const fingerprint = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const CODEX_STUDENT_MODEL = "gpt-5.6-luna";
const CODEX_STUDENT_REASONING_EFFORT = "max" as const;
const HISTORICAL_SEARCH_CANDIDATES = 5;

function requestedAgent(value: string | undefined): LlmBackedAgent {
  const agent = value ?? "codex";
  if (!isLlmBackedAgent(agent)) {
    throw new Error(
      `Historical improvement supports these replay agents: claude, codex, opencode, pi. Received: ${agent}`,
    );
  }
  if (agent === "pi") {
    throw new Error("Historical host replay does not support the pi harness yet.");
  }
  return agent;
}

/** Open the real local stores, run the review transaction, and close both stores. */
export async function runHistoricalSkillImproveCli(
  input: HistoricalSkillImproveCliInput,
): Promise<HistoricalSkillImproveCliAttempt> {
  const agent = requestedAgent(input.agent);
  const patternId = executionPatternIdForSkill(input.skill);
  const searchDirs = [dirname(dirname(input.skillPath))];
  const taskQualityReplay = input.skill.trim().toLowerCase() === "to-issues";

  const program = Effect.gen(function* () {
    const { sqlite } = yield* LocalDatabaseService;
    const executorFactory = yield* HostHistoricalSkillReplay;
    const historicalTaskCalibrator = taskQualityReplay
      ? yield* HostHistoricalTaskCalibration.pipe(
          Effect.provide(
            makeHostHistoricalTaskCalibrationLayer({
              agent,
              model: agent === "codex" ? CODEX_STUDENT_MODEL : "configured-default",
            }),
          ),
        )
      : undefined;
    const preparationLayer = Layer.provide(
      makeTraceCandidatePreparationLayer({
        sqlite,
        teacherAgent: agent,
        searchDirs,
        studentAgent: agent,
        studentModel: agent === "codex" ? CODEX_STUDENT_MODEL : undefined,
        historicalTaskCalibrator,
      }),
      makeDuckDbNodeApiAnalyticalStoreLive(SELFTUNE_LOCAL_ANALYTICS_PATH),
    );
    const improvementLayer = Layer.provide(
      makeHistoricalSkillImprovementLayer({
        sqlite,
        executorFactory,
        searchDirs,
      }),
      preparationLayer,
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const improvement = yield* HistoricalSkillImprovement;
        return yield* improvement.evaluate({
          pattern_id: patternId,
          candidate_count: HISTORICAL_SEARCH_CANDIDATES,
          qualified_verifier: taskQualityReplay
            ? historicalTaskQualityVerifierQualification()
            : historicalRoutingVerifierQualification(),
          runtime: {
            harness: agent === "claude" ? "claude_code" : agent,
            model: agent === "codex" ? CODEX_STUDENT_MODEL : "configured-default",
            config_digest: fingerprint(
              JSON.stringify({
                schema_version: 1,
                agent,
                model: agent === "codex" ? CODEX_STUDENT_MODEL : "configured-default",
                reasoning_effort:
                  agent === "codex" ? CODEX_STUDENT_REASONING_EFFORT : "configured-default",
                candidate_count: HISTORICAL_SEARCH_CANDIDATES,
                replay: taskQualityReplay
                  ? "isolated-host-execution-quality"
                  : "isolated-host-routing",
                verifier: taskQualityReplay
                  ? "selftune.to-issues-draft-quality@v2"
                  : "selftune.skill-routing-selection@v1",
              }),
            ),
          },
          required_scored_repetitions: 3,
          max_attempts_per_arm: 3,
          controls: {
            entitlement_proactive_managed: true,
            proactive_generation_enabled: true,
            managed_execution_enabled: true,
            kill_switch_enabled: false,
            active_runs: 0,
            max_concurrency: 1,
            budget_remaining_usd: 20,
            estimated_cost_usd: 5,
          },
          recorded_at: new Date().toISOString(),
        });
      }).pipe(Effect.provide(improvementLayer)),
    );
  }).pipe(
    Effect.provide(
      Layer.merge(
        HostHistoricalSkillReplayLive,
        makeLocalDatabaseLive(SELFTUNE_LOCAL_DATABASE_PATH),
      ),
    ),
  );

  const response = await Effect.runPromise(Effect.scoped(program));
  const unsupportedContrast = response.reason.startsWith(
    "The exact pattern is no longer supported",
  );
  if (response.status === "not_ready" && unsupportedContrast) {
    return { handled: false };
  }
  return {
    handled: true,
    result: {
      mode: "historical_blind_replay",
      source: "local_duckdb",
      review_only: true,
      skill: input.skill,
      agent,
      student_model: agent === "codex" ? CODEX_STUDENT_MODEL : "configured-default",
      reasoning_effort: CODEX_STUDENT_REASONING_EFFORT,
      pattern_id: response.pattern_id,
      status: response.status,
      evidence_level: response.evidence_level,
      reason: response.reason,
      evaluation_id: response.evaluation_id,
      cohort_fingerprint: response.cohort_fingerprint,
      cases: response.cases,
      search: response.search ?? null,
      applies_change: false,
      before_after: response.before_after ?? null,
    },
  };
}
