import { Schema } from "effect";

import type { RegistryClientError } from "./client.js";

export type RegistryProgramInput =
  | {
      readonly operation: "push";
      readonly name?: string;
      readonly version?: string;
      readonly summary?: string;
    }
  | { readonly operation: "install"; readonly target?: string; readonly global: boolean }
  | { readonly operation: "sync" | "status" | "list" }
  | {
      readonly operation: "rollback";
      readonly name?: string;
      readonly targetVersion?: string;
      readonly reason?: string;
    }
  | { readonly operation: "history"; readonly name?: string };

export interface RegistryProgramResult {
  readonly operation: RegistryProgramInput["operation"];
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
  readonly exitCode: 0 | 1;
}

export interface FormattedRegistryResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: 0 | 1;
}

export class RegistryOperationError extends Schema.TaggedErrorClass<RegistryOperationError>()(
  "RegistryOperationError",
  { operation: Schema.String, message: Schema.String },
) {}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function success(
  operation: RegistryProgramInput["operation"],
  ...stdout: ReadonlyArray<string>
): RegistryProgramResult {
  return { operation, stdout, stderr: [], exitCode: 0 };
}

export function failure(
  operation: RegistryProgramInput["operation"],
  value: unknown,
): RegistryProgramResult {
  return { operation, stdout: [], stderr: [json(value)], exitCode: 1 };
}

export function registryFailure(
  operation: RegistryProgramInput["operation"],
  error: RegistryClientError,
): RegistryProgramResult {
  return failure(operation, { error: error.message });
}

export function operationError(operation: string, cause: unknown): RegistryOperationError {
  return RegistryOperationError.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}
