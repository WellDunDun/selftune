import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { CLIError, handleCLIError } from "@selftune/runtime/utils/cli-error";

import { makeEffectCliProgram } from "./program.js";
import { SyncLegacyParseFailure } from "./compatibility/sync.js";
import { WatchLegacyParseFailure, WatchLegacyRuntimeFailure } from "./compatibility/watch.js";

export function runEffectCliMain(command: string, args: ReadonlyArray<string>): void {
  const program = makeEffectCliProgram([command, ...args]).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.provide(BunServices.layer),
    Effect.catchIf(
      (error): error is CLIError => error instanceof CLIError,
      (error) => Effect.sync(() => handleCLIError(error)),
    ),
    Effect.catchIf(
      (error): error is SyncLegacyParseFailure => error instanceof SyncLegacyParseFailure,
      (error) => Effect.sync(() => handleCLIError(error.cause)),
    ),
    Effect.catchIf(
      (error): error is WatchLegacyParseFailure => error instanceof WatchLegacyParseFailure,
      (error) => Effect.sync(() => handleCLIError(error.cause)),
    ),
    Effect.catchIf(
      (error): error is WatchLegacyRuntimeFailure => error instanceof WatchLegacyRuntimeFailure,
      (error) => Effect.sync(() => handleCLIError(error.cause)),
    ),
  );

  BunRuntime.runMain(program);
}
