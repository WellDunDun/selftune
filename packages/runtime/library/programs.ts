import {
  CatalogMemory,
  CandidateStoreMemory,
  defaultSyncPreferences,
  RemoteLibrary,
  RemoteLibraryHttp,
} from "@selftune/control-plane";
import { LibraryError } from "@selftune/library/errors";
import {
  diagnoseRemoteEffect,
  exportRemoteLibraryEffect,
} from "@selftune/library/remote/effect-sync";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { loadLibraryCatalogEffect } from "./catalog.js";
import {
  type LibrarySynthesisProgramInput,
  runLibrarySynthesisOperation,
} from "./synthesis-programs.js";
import { loadRemoteLibraryConfig, saveRemoteLibraryConfig } from "../remote-library/config.js";
import {
  previewRemoteLibrarySyncEffect,
  syncRemoteLibraryEffect,
} from "../remote-library/effect-sync.js";
import { restoreRemoteLibraryEffect } from "../remote-library/effect-restore.js";
import { CLIError } from "../utils/cli-error.js";

export type LibraryProgramInput =
  | { readonly operation: "list" }
  | { readonly operation: "configure"; readonly url?: string; readonly apiKey?: string }
  | { readonly operation: "preview" }
  | { readonly operation: "sync" }
  | { readonly operation: "status" }
  | { readonly operation: "diagnostics" }
  | { readonly operation: "export"; readonly output?: string }
  | { readonly operation: "restore"; readonly target?: string }
  | LibrarySynthesisProgramInput;

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toProgramError(operation: string, cause: unknown): CLIError {
  if (cause instanceof CLIError) return cause;
  if (cause instanceof LibraryError) {
    return new CLIError(
      cause.message,
      cause.code,
      cause.suggestion,
      cause.exitCode,
      cause.retryable,
    );
  }
  return new CLIError(
    `Library ${operation} failed: ${failureMessage(cause)}`,
    "OPERATION_FAILED",
    `selftune library ${operation} --help`,
  );
}

const requireValue = Effect.fn("selftune.runtime.library.requireValue")(function* (
  value: string | undefined,
  flag: string,
) {
  if (!value) {
    return yield* Effect.fail(new CLIError(`${flag} is required.`, "MISSING_FLAG"));
  }
  return value;
});

const withRemoteLibrary = Effect.fn("selftune.runtime.library.withRemote")(function* <A, E, R>(
  operation: string,
  use: (
    config: ReturnType<typeof loadRemoteLibraryConfig>,
  ) => Effect.Effect<A, E, RemoteLibrary | R>,
) {
  const config = yield* Effect.try({
    try: () => loadRemoteLibraryConfig(),
    catch: (cause) => toProgramError(operation, cause),
  });
  return yield* use(config).pipe(
    Effect.provide(RemoteLibraryHttp({ baseUrl: config.url, apiKey: config.apiKey })),
    Effect.mapError((cause) => toProgramError(operation, cause)),
  );
});

const LibraryControlPlane = Layer.merge(CatalogMemory, CandidateStoreMemory);

const runLibraryProgramWithServices = Effect.fn("selftune.runtime.library.runWithServices")(
  function* (input: LibraryProgramInput) {
    switch (input.operation) {
      case "list": {
        const value = yield* loadLibraryCatalogEffect().pipe(
          Effect.mapError((cause) => toProgramError(input.operation, cause)),
        );
        return value;
      }
      case "configure": {
        const url = yield* requireValue(input.url, "--url");
        const apiKey = yield* requireValue(input.apiKey, "--api-key");
        const saved = yield* Effect.try({
          try: () => saveRemoteLibraryConfig({ url, apiKey, preferences: defaultSyncPreferences }),
          catch: (cause) => toProgramError(input.operation, cause),
        });
        return {
          configured: true,
          url: saved.url,
          preferences: saved.preferences,
        };
      }
      case "preview": {
        const config = yield* Effect.try({
          try: () => loadRemoteLibraryConfig(),
          catch: (cause) => toProgramError(input.operation, cause),
        });
        const value = yield* previewRemoteLibrarySyncEffect({
          preferences: config.preferences,
        }).pipe(Effect.mapError((cause) => toProgramError(input.operation, cause)));
        return value;
      }
      case "sync": {
        const value = yield* withRemoteLibrary(input.operation, (config) =>
          syncRemoteLibraryEffect({ preferences: config.preferences }),
        );
        return value;
      }
      case "status": {
        const value = yield* withRemoteLibrary(input.operation, (config) =>
          Effect.gen(function* () {
            const remote = yield* RemoteLibrary;
            const [capabilities, head, diagnostics] = yield* Effect.all(
              [remote.capabilities, remote.head, remote.diagnostics],
              { concurrency: "unbounded" },
            );
            return { url: config.url, capabilities, head, diagnostics };
          }),
        );
        return value;
      }
      case "diagnostics": {
        const value = yield* withRemoteLibrary(input.operation, () => diagnoseRemoteEffect());
        return value;
      }
      case "export": {
        const output = yield* requireValue(input.output, "--output");
        const value = yield* withRemoteLibrary(input.operation, () =>
          exportRemoteLibraryEffect({ outputPath: output }),
        );
        return value;
      }
      case "restore": {
        const target = yield* requireValue(input.target, "--target");
        const value = yield* withRemoteLibrary(input.operation, () =>
          restoreRemoteLibraryEffect({ targetRoot: target }),
        );
        return value;
      }
      case "synthesize.scan":
      case "synthesize.list":
      case "synthesize.review":
      case "synthesize.draft":
      case "synthesize.evaluate":
      case "synthesize.release":
        return yield* runLibrarySynthesisOperation(input);
    }
  },
);

export const runLibraryProgram = Effect.fn("selftune.runtime.library.run")(function* (
  input: LibraryProgramInput,
) {
  const value = yield* runLibraryProgramWithServices(input).pipe(
    Effect.provide(LibraryControlPlane),
  );
  return { operation: input.operation, value, text: JSON.stringify(value, null, 2) };
});

export type LibraryProgramResult = Effect.Success<ReturnType<typeof runLibraryProgram>>;

export function formatLibraryResult(result: Pick<LibraryProgramResult, "text">): string {
  return result.text;
}
