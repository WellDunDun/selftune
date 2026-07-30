import * as Schema from "effect/Schema";

export class UninstallCleanupFailure extends Schema.TaggedErrorClass<UninstallCleanupFailure>()(
  "UninstallCleanupFailure",
  {
    operation: Schema.Literals(["remove-agents", "remove-hooks"]),
    message: Schema.String,
  },
) {}

export function uninstallCleanupFailure(
  operation: UninstallCleanupFailure["operation"],
  cause: unknown,
): UninstallCleanupFailure {
  return UninstallCleanupFailure.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}
