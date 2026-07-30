import { Effect } from "effect";

import { RegistryIdentifierValidationError, RegistryPathConfinementError } from "./path-policy.js";
import type { RegistryStateValidationError } from "./registry-state.js";
import { operationError, type RegistryOperationError } from "./program-types.js";

export type RegistryProgramFailure =
  | RegistryOperationError
  | RegistryIdentifierValidationError
  | RegistryPathConfinementError
  | RegistryStateValidationError;

export function fromPromise<A>(operation: string, thunk: () => Promise<A>) {
  return Effect.tryPromise({ try: thunk, catch: (cause) => operationError(operation, cause) });
}

export function validate<A>(
  operation: string,
  thunk: () => A,
): Effect.Effect<A, RegistryProgramFailure> {
  return Effect.try({
    try: thunk,
    catch: (cause) =>
      cause instanceof RegistryIdentifierValidationError ||
      cause instanceof RegistryPathConfinementError
        ? cause
        : operationError(operation, cause),
  });
}
