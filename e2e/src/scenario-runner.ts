import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

export type ScenarioResult<A = unknown> =
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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parityEntry(result: ScenarioResult): Record<string, unknown> {
  const base = { target: result.target, scenario: result.scenario, status: result.status };
  if (result.status === "skipped") {
    return { ...base, missing_capability: result.missing_capability, reason: result.skip_reason };
  }
  if (result.status === "failed") {
    return { ...base, failed_step: result.failed_step, error: result.error };
  }
  const outcome = result.observable_outcome;
  if (typeof outcome !== "object" || outcome === null) return base;
  const installedHash = Reflect.get(outcome, "installed_hash");
  const receiptStatus = Reflect.get(outcome, "receipt_status");
  return {
    ...base,
    ...(typeof installedHash === "string" ? { installed_hash: installedHash } : {}),
    ...(typeof receiptStatus === "string" ? { receipt_status: receiptStatus } : {}),
  };
}

function updateMatrix(runsRoot: string, result: ScenarioResult): void {
  const path = join(runsRoot, "matrix.json");
  let previous: unknown = null;
  if (existsSync(path)) {
    try {
      previous = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      previous = null;
    }
  }
  const results =
    typeof previous === "object" &&
    previous !== null &&
    Array.isArray(Reflect.get(previous, "results"))
      ? Reflect.get(previous, "results").filter(
          (entry: unknown) =>
            typeof entry !== "object" ||
            entry === null ||
            Reflect.get(entry, "target") !== result.target ||
            Reflect.get(entry, "scenario") !== result.scenario,
        )
      : [];
  const nextResults = [...results, result];
  writeJson(path, {
    generated_at: result.timestamp,
    parity: nextResults.map(parityEntry),
    results: nextResults,
  });
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
  const layer = typeof options.layer === "function" ? options.layer(runDirectory) : options.layer;

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

  writeJson(join(runDirectory, "result.json"), result);
  writeFileSync(
    join(runDirectory, "logs", "scenario.log"),
    `${timestamp} ${result.status} ${options.target}/${options.scenario}\n`,
    "utf8",
  );
  if (result.status === "skipped") writeJson(join(runDirectory, "skipped.json"), result);
  updateMatrix(resolve(options.runsRoot), result);
  return result;
}
