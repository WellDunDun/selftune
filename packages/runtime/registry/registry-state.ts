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
  version?: string;
  versionId?: string;
  installPath: string;
  localContentHash?: string;
  installationId?: string;
  receiptId?: string;
  previousVersionHash?: string;
  pendingRegistration?: {
    receiptId: string;
    installPath: string;
    installedContentHash?: string;
  };
  pendingReceipts?: ReadonlyArray<{
    receiptId: string;
    installedVersion: string;
    installedContentHash: string;
    previousVersionId: string | null;
    status: "updated" | "conflict";
  }>;
  pendingUpdate?: {
    receiptId: string;
    targetVersionHash: string;
    targetVersion: string;
    targetVersionId?: string;
    previousVersionId?: string;
    observedContentHashBefore: string;
    expectedInstalledContentHash: string;
  };
  automaticSuggestion?: {
    observedContentHash: string;
    baseVersionHash: string;
    baseVersionId?: string;
    stableAt: number;
    attemptCount: number;
    nextAttemptAt: number;
    lastFailure?: {
      kind: "blocked" | "retrying";
      code: string;
      at: number;
    };
  };
  lastSuggestion?: {
    observedContentHash: string;
    candidateContentHash: string;
    baseVersionHash: string;
    baseVersionId: string;
    contributionId: string;
    submittedAt: string;
  };
}

const RegistryState = Schema.Array(
  Schema.Struct({
    entryId: Schema.String,
    name: Schema.String,
    versionHash: Schema.String,
    version: Schema.optionalKey(Schema.String),
    versionId: Schema.optionalKey(Schema.String),
    installPath: Schema.String,
    localContentHash: Schema.optionalKey(Schema.String),
    installationId: Schema.optionalKey(Schema.String),
    receiptId: Schema.optionalKey(Schema.String),
    previousVersionHash: Schema.optionalKey(Schema.String),
    pendingRegistration: Schema.optionalKey(
      Schema.Struct({
        receiptId: Schema.String,
        installPath: Schema.String,
        installedContentHash: Schema.optionalKey(Schema.String),
      }),
    ),
    pendingReceipts: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          receiptId: Schema.String,
          installedVersion: Schema.String,
          installedContentHash: Schema.String,
          previousVersionId: Schema.Union([Schema.String, Schema.Null]),
          status: Schema.Literals(["updated", "conflict"]),
        }),
      ),
    ),
    pendingUpdate: Schema.optionalKey(
      Schema.Struct({
        receiptId: Schema.String,
        targetVersionHash: Schema.String,
        targetVersion: Schema.String,
        targetVersionId: Schema.optionalKey(Schema.String),
        previousVersionId: Schema.optionalKey(Schema.String),
        observedContentHashBefore: Schema.String,
        expectedInstalledContentHash: Schema.String,
      }),
    ),
    automaticSuggestion: Schema.optionalKey(
      Schema.Struct({
        observedContentHash: Schema.String,
        baseVersionHash: Schema.String,
        baseVersionId: Schema.optionalKey(Schema.String),
        stableAt: Schema.Number,
        attemptCount: Schema.Number,
        nextAttemptAt: Schema.Number,
        lastFailure: Schema.optionalKey(
          Schema.Struct({
            kind: Schema.Literals(["blocked", "retrying"]),
            code: Schema.String,
            at: Schema.Number,
          }),
        ),
      }),
    ),
    lastSuggestion: Schema.optionalKey(
      Schema.Struct({
        observedContentHash: Schema.String,
        candidateContentHash: Schema.String,
        baseVersionHash: Schema.String,
        baseVersionId: Schema.String,
        contributionId: Schema.String,
        submittedAt: Schema.String,
      }),
    ),
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
