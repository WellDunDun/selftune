import * as Effect from "effect/Effect";

import { TELEMETRY_LOG } from "../constants.js";
import { getDb } from "../localdb/db.js";
import { querySessionTelemetry } from "../localdb/queries.js";
import type { ComposabilityReport, SessionTelemetryRecord } from "../types.js";
import { CLIError } from "../utils/cli-error.js";
import { readJsonl } from "../utils/jsonl.js";
import { analyzeComposability } from "./composability.js";

export interface ComposabilityInput {
  readonly skill?: string;
  readonly window?: string;
  readonly telemetryLog?: string;
}

export interface ComposabilityDependencies {
  readonly loadDatabaseTelemetry: () => ReadonlyArray<SessionTelemetryRecord>;
  readonly loadJsonlTelemetry: (path: string) => ReadonlyArray<SessionTelemetryRecord>;
  readonly analyze: (
    skill: string,
    telemetry: SessionTelemetryRecord[],
    window?: number,
  ) => ComposabilityReport;
  readonly print: (output: string) => void;
}

const liveComposabilityDependencies: ComposabilityDependencies = {
  loadDatabaseTelemetry: () => querySessionTelemetry(getDb()),
  loadJsonlTelemetry: (path) => readJsonl<SessionTelemetryRecord>(path),
  analyze: analyzeComposability,
  print: (output) => process.stdout.write(`${output}\n`),
};

function parseWindow(rawWindow: string | undefined): Effect.Effect<number | undefined, CLIError> {
  if (rawWindow === undefined) return Effect.succeed(undefined);
  const window = Number(rawWindow);
  if (!/^[1-9]\d*$/.test(rawWindow) || !Number.isSafeInteger(window)) {
    return Effect.fail(
      new CLIError(
        "Invalid --window value. Use a positive integer number of sessions within the safe integer range.",
        "INVALID_FLAG",
        "selftune eval composability --skill <name> --window 30",
      ),
    );
  }
  return Effect.succeed(window);
}

function readJsonlTelemetry(
  path: string,
  dependencies: ComposabilityDependencies,
): Effect.Effect<ReadonlyArray<SessionTelemetryRecord>, CLIError> {
  return Effect.try({
    try: () => dependencies.loadJsonlTelemetry(path),
    catch: (cause) =>
      cause instanceof CLIError
        ? cause
        : new CLIError(
            cause instanceof Error ? cause.message : String(cause),
            "OPERATION_FAILED",
            "selftune eval composability --help",
          ),
  });
}

const loadTelemetry = Effect.fn("selftune.composability.loadTelemetry")(function* (
  telemetryLog: string,
  dependencies: ComposabilityDependencies,
) {
  if (telemetryLog !== TELEMETRY_LOG) {
    return yield* readJsonlTelemetry(telemetryLog, dependencies);
  }

  return yield* Effect.try({
    try: dependencies.loadDatabaseTelemetry,
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => readJsonlTelemetry(telemetryLog, dependencies)));
});

export const runComposabilityProgram = Effect.fn("selftune.composability.run")(function* (
  input: ComposabilityInput,
  dependencies: ComposabilityDependencies = liveComposabilityDependencies,
) {
  const skill = input.skill;
  if (!skill) {
    return yield* Effect.fail(
      new CLIError(
        "--skill <name> is required.",
        "MISSING_FLAG",
        "selftune eval composability --skill <name>",
      ),
    );
  }

  const window = yield* parseWindow(input.window);
  const telemetry = yield* loadTelemetry(input.telemetryLog ?? TELEMETRY_LOG, dependencies);
  const report = yield* Effect.try({
    try: () => dependencies.analyze(skill, [...telemetry], window),
    catch: (cause) =>
      cause instanceof CLIError
        ? cause
        : new CLIError(
            cause instanceof Error ? cause.message : String(cause),
            "OPERATION_FAILED",
            "selftune eval composability --help",
          ),
  });
  yield* Effect.sync(() => dependencies.print(JSON.stringify(report, null, 2)));
  return report;
});
