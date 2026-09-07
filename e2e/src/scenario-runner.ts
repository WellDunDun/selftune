import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { optionalEvidence } from "@selftune/runtime/utils/transcript-contract";

import type { ScenarioError } from "./services";

interface ScenarioResultBase {
  target: string;
  scenario: string;
  source: string;
  timestamp: string;
  duration_ms: number;
  run_directory: string;
}

export interface PassedScenarioResult<A> extends ScenarioResultBase {
  status: "passed";
  observable_outcome: A;
}

export interface SkippedScenarioResult extends ScenarioResultBase {
  status: "skipped";
  missing_capability: string;
  skip_reason: string;
}

export interface FailedScenarioResult extends ScenarioResultBase {
  status: "failed";
  failed_step: string;
  error: string;
}

export type ScenarioResult<A = typeof Schema.Json.Type | void> =
  | PassedScenarioResult<A>
  | SkippedScenarioResult
  | FailedScenarioResult;

type ScenarioOutcome<A> =
  | { kind: "passed"; value: A }
  | { kind: "skipped"; error: Extract<ScenarioError, { _tag: "CapabilityUnavailable" }> }
  | { kind: "failed"; error: Extract<ScenarioError, { _tag: "ScenarioFailure" }> };

export interface RunScenarioOptions<A, R> {
  target: string;
  scenario: string;
  source: string;
  runsRoot: string;
  layer: Layer.Layer<R> | ((runDirectory: string) => Layer.Layer<R>);
  program: Effect.Effect<A, ScenarioError, R>;
  now?: () => Date;
}

const ResultBase = {
  target: Schema.String,
  scenario: Schema.String,
  source: Schema.String,
  timestamp: Schema.String,
  duration_ms: Schema.Number,
  run_directory: Schema.String,
};
const PersistedResult = Schema.Union([
  Schema.Struct({
    ...ResultBase,
    status: Schema.Literal("passed"),
    observable_outcome: Schema.optionalKey(Schema.Json),
  }),
  Schema.Struct({
    ...ResultBase,
    status: Schema.Literal("skipped"),
    missing_capability: Schema.String,
    skip_reason: Schema.String,
  }),
  Schema.Struct({
    ...ResultBase,
    status: Schema.Literal("failed"),
    failed_step: Schema.String,
    error: Schema.String,
  }),
]);
const Matrix = Schema.Struct({ results: Schema.Array(Schema.Json) });
const ParityEvidence = Schema.Struct({
  installed_hash: optionalEvidence(Schema.String),
  receipt_status: optionalEvidence(Schema.String),
});

function parityEntry(result: typeof PersistedResult.Type) {
  const base = { target: result.target, scenario: result.scenario, status: result.status };
  if (result.status === "skipped") {
    return { ...base, missing_capability: result.missing_capability, reason: result.skip_reason };
  }
  if (result.status === "failed") {
    return { ...base, failed_step: result.failed_step, error: result.error };
  }
  const evidence = Schema.decodeUnknownOption(ParityEvidence)(result.observable_outcome);
  return Option.isNone(evidence) ? base : { ...base, ...evidence.value };
}

function updateMatrix(runsRoot: string, result: typeof PersistedResult.Type): void {
  const path = join(runsRoot, "matrix.json");
  let results: (typeof PersistedResult.Type)[] = [];
  if (existsSync(path)) {
    try {
      const previous = Schema.decodeUnknownSync(Schema.fromJsonString(Matrix))(
        readFileSync(path, "utf8"),
      );
      results = previous.results.flatMap((entry) =>
        Option.toArray(Schema.decodeUnknownOption(PersistedResult)(entry)),
      );
    } catch {
      results = [];
    }
  }
  const nextResults = [
    ...results.filter(
      (entry) => entry.target !== result.target || entry.scenario !== result.scenario,
    ),
    result,
  ];
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        generated_at: result.timestamp,
        parity: nextResults.map(parityEntry),
        results: nextResults,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function runScenario<A, R>(
  options: RunScenarioOptions<A, R>,
): Promise<ScenarioResult<A>> {
  const startedAt = options.now?.() ?? new Date();
  const timestamp = startedAt.toISOString();
  const runDirectory = join(
    resolve(options.runsRoot),
    options.target,
    options.scenario,
    `${timestamp.replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(join(runDirectory, "screenshots"), { recursive: true });
  mkdirSync(join(runDirectory, "logs"), { recursive: true });
  copyFileSync(options.source, join(runDirectory, basename(options.source)));
  const layer = Predicate.isFunction(options.layer) ? options.layer(runDirectory) : options.layer;

  const outcome = await Effect.runPromise(
    options.program.pipe(
      Effect.provide(layer),
      Effect.match({
        onSuccess: (value): ScenarioOutcome<A> => ({ kind: "passed", value }),
        onFailure: (error): ScenarioOutcome<A> =>
          error._tag === "CapabilityUnavailable"
            ? { kind: "skipped", error }
            : { kind: "failed", error },
      }),
    ),
  );
  const base: ScenarioResultBase = {
    target: options.target,
    scenario: options.scenario,
    source: options.source,
    timestamp,
    duration_ms: Math.max(0, (options.now?.() ?? new Date()).getTime() - startedAt.getTime()),
    run_directory: runDirectory,
  };
  const result: ScenarioResult<A> =
    outcome.kind === "passed"
      ? { ...base, status: "passed", observable_outcome: outcome.value }
      : outcome.kind === "skipped"
        ? {
            ...base,
            status: "skipped",
            missing_capability: outcome.error.capability,
            skip_reason: outcome.error.reason,
          }
        : {
            ...base,
            status: "failed",
            failed_step: outcome.error.step,
            error: outcome.error.message,
          };

  const encodedResult = `${JSON.stringify(result, null, 2)}\n`;
  writeFileSync(join(runDirectory, "result.json"), encodedResult, "utf8");
  writeFileSync(
    join(runDirectory, "logs", "scenario.log"),
    `${timestamp} ${result.status} ${options.target}/${options.scenario}\n`,
    "utf8",
  );
  if (result.status === "skipped")
    writeFileSync(join(runDirectory, "skipped.json"), encodedResult, "utf8");
  updateMatrix(
    resolve(options.runsRoot),
    Schema.decodeUnknownSync(Schema.fromJsonString(PersistedResult))(encodedResult),
  );
  return result;
}
