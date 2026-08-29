import { Effect, Layer } from "effect";

import { registryClientLayer } from "./client.js";
import { runRegistryHistory } from "./history.js";
import { runRegistryInstall } from "./install.js";
import { runRegistryList } from "./list.js";
import { RegistryIdentifierValidationError, RegistryPathConfinementError } from "./path-policy.js";
import { registryPlatformLayer } from "./platform.js";
import { RegistryOperationError } from "./program-types.js";
import { runRegistryPush } from "./push.js";
import { runRegistryRollback } from "./rollback.js";
import { runRegistryStatus } from "./status.js";
import { runRegistrySync } from "./sync.js";
import { runRegistrySuggest } from "./suggest.js";
import { RegistryStateValidationError } from "./registry-state.js";
import type {
  FormattedRegistryResult,
  RegistryProgramInput,
  RegistryProgramResult,
} from "./program-types.js";

export type { RegistryProgramInput, RegistryProgramResult } from "./program-types.js";

export const registryLiveLayer = Layer.merge(registryClientLayer, registryPlatformLayer);

export function isRegistryInternalFailure(cause: unknown): boolean {
  return (
    cause instanceof RegistryStateValidationError ||
    cause instanceof RegistryIdentifierValidationError ||
    cause instanceof RegistryPathConfinementError ||
    cause instanceof RegistryOperationError
  );
}

export const runRegistryProgram = Effect.fn("selftune.registry.run")(function* (
  input: RegistryProgramInput,
) {
  switch (input.operation) {
    case "push":
      return yield* runRegistryPush(input);
    case "suggest":
      return yield* runRegistrySuggest(input);
    case "install":
      return yield* runRegistryInstall(input);
    case "sync":
      return yield* runRegistrySync({ automaticOnly: input.automaticOnly });
    case "status":
      return yield* runRegistryStatus();
    case "rollback":
      return yield* runRegistryRollback(input);
    case "history":
      return yield* runRegistryHistory(input);
    case "list":
      return yield* runRegistryList();
  }
});

export function formatRegistryResult(result: RegistryProgramResult): FormattedRegistryResult {
  return {
    stdout: result.stdout.length > 0 ? `${result.stdout.join("\n")}\n` : "",
    stderr: result.stderr.length > 0 ? `${result.stderr.join("\n")}\n` : "",
    exitCode: result.exitCode,
  };
}
