import * as Schema from "effect/Schema";

import {
  RegistryIdentifierValidationError,
  RegistryPathConfinementError,
  validatePersistedRegistryInstallPath,
} from "./path-policy.js";

export interface RegistryStateEntry {
  entryId: string;
  name: string;
  versionHash: string;
  installPath: string;
}

const RegistryState = Schema.Array(
  Schema.Struct({
    entryId: Schema.String,
    name: Schema.String,
    versionHash: Schema.String,
    installPath: Schema.String,
  }),
);

export class RegistryStateValidationError extends Schema.TaggedErrorClass<RegistryStateValidationError>()(
  "RegistryStateValidationError",
  {
    message: Schema.String,
  },
) {}

export function isRegistryStateValidationFailure(
  error: unknown,
): error is
  | RegistryStateValidationError
  | RegistryIdentifierValidationError
  | RegistryPathConfinementError {
  return (
    error instanceof RegistryStateValidationError ||
    error instanceof RegistryIdentifierValidationError ||
    error instanceof RegistryPathConfinementError
  );
}

export function registryStateValidationError(cause: unknown): RegistryStateValidationError {
  return RegistryStateValidationError.make({
    message: `Invalid registry state: ${cause instanceof Error ? cause.message : String(cause)}`,
  });
}

export function decodeRegistryState(input: unknown): RegistryStateEntry[] {
  try {
    const decoded = Schema.decodeUnknownSync(RegistryState)(input);
    const entries = decoded.map((entry) => ({ ...entry }));
    for (const entry of entries) {
      validatePersistedRegistryInstallPath(entry.installPath, entry.name);
    }
    return entries;
  } catch (error) {
    if (isRegistryStateValidationFailure(error)) throw error;
    throw registryStateValidationError(error);
  }
}

export function parseRegistryState(raw: string): RegistryStateEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw registryStateValidationError(error);
  }
  return decodeRegistryState(parsed);
}

export function isRegistryStateFileMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
