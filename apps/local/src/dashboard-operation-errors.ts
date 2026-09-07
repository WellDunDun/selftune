import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { LibraryError } from "@selftune/library";
import { SkillSourceUpdateFailure } from "@selftune/runtime/skill-source-update";
import {
  CatalogSkillResolutionFailureDetail,
  CatalogSkillResolutionProgress,
  CatalogSkillSetResolutionError,
  SkillSetCreationError,
} from "@selftune/runtime/skill-sets/catalog-resolution";
import { SkillIntelligenceFeedbackError } from "@selftune/runtime/skill-intelligence/feedback";
import { CLIError } from "@selftune/runtime/utils/cli-error";
import { TeamSkillSetAssignmentError } from "@selftune/runtime/team-assignment";
import { TeamSkillSetContributionError } from "@selftune/runtime/team-contribution";

import { CloudTeamCollaborationError } from "./cloud-team-collaboration.js";

export class DashboardOperationError extends Schema.TaggedErrorClass<DashboardOperationError>()(
  "DashboardOperationError",
  {
    operation: Schema.String,
    code: Schema.String,
    message: Schema.String,
    status: Schema.Number,
    suggestion: Schema.optional(Schema.String),
    retryable: Schema.Boolean,
    failures: Schema.optional(Schema.Array(CatalogSkillResolutionFailureDetail)),
    progress: Schema.optional(Schema.Array(CatalogSkillResolutionProgress)),
  },
) {}

export function operationError(operation: string, cause: unknown): DashboardOperationError {
  if (cause instanceof DashboardOperationError) return cause;
  if (cause instanceof TeamSkillSetAssignmentError) {
    const conflict =
      cause.code.includes("MISMATCH") ||
      cause.code.includes("STALE") ||
      cause.code.includes("DRIFT") ||
      cause.code.includes("UNAVAILABLE") ||
      cause.code.includes("NOT_ACTIVE") ||
      cause.code.includes("NOT_READY");
    return DashboardOperationError.make({
      operation,
      code: cause.code,
      message: cause.message,
      status: conflict ? 409 : cause.code.includes("CONFIRMATION_REQUIRED") ? 400 : 500,
      retryable: cause.retryable,
    });
  }
  if (cause instanceof TeamSkillSetContributionError) {
    const conflict =
      cause.code.includes("STALE") ||
      cause.code.includes("CHANGED") ||
      cause.code.includes("REQUIRED") ||
      cause.code.includes("UNAVAILABLE");
    return DashboardOperationError.make({
      operation,
      code: cause.code,
      message: cause.message,
      status: conflict ? 409 : cause.code.includes("CORRUPT") ? 500 : 400,
      retryable: cause.retryable,
    });
  }
  if (cause instanceof CloudTeamCollaborationError) {
    const failure = {
      operation,
      code: cause.code,
      message: cause.message,
      status: cause.status,
      retryable: cause.retryable,
    };
    if (cause.suggestion)
      return DashboardOperationError.make({ ...failure, suggestion: cause.suggestion });
    return DashboardOperationError.make(failure);
  }
  if (cause instanceof CatalogSkillSetResolutionError) {
    return DashboardOperationError.make({
      operation,
      code: cause.code,
      message: cause.message,
      status: 422,
      suggestion: "Retry the catalog packages that failed or remove them from this Skill Set.",
      retryable: cause.retryable,
      failures: [...cause.failures],
      progress: [...cause.progress],
    });
  }
  if (cause instanceof SkillSetCreationError) {
    return DashboardOperationError.make({
      operation,
      code: cause.code,
      message: cause.message,
      status: cause.code === "GUARD_BLOCKED" ? 409 : 400,
      retryable: cause.retryable,
    });
  }
  if (cause instanceof SkillIntelligenceFeedbackError) {
    return DashboardOperationError.make({
      operation,
      code: cause.code,
      message: cause.message,
      status: cause.code === "STALE_SUGGESTION" ? 409 : 400,
      retryable: false,
    });
  }
  if (cause instanceof SkillSourceUpdateFailure) {
    const status =
      cause.code === "SKILL_NOT_FOUND"
        ? 404
        : cause.code === "LOCAL_CHANGES" || cause.code === "SOURCE_AMBIGUOUS"
          ? 409
          : 400;
    return DashboardOperationError.make({
      operation,
      code: cause.code,
      message: cause.message,
      status,
      retryable: false,
    });
  }
  if (cause instanceof CLIError || cause instanceof LibraryError) {
    const failure = {
      operation,
      code: cause.code,
      message: cause.message,
      status: cause.code === "FILE_NOT_FOUND" ? 404 : cause.code === "GUARD_BLOCKED" ? 409 : 400,
      retryable: cause.retryable,
    };
    if (cause.suggestion)
      return DashboardOperationError.make({ ...failure, suggestion: cause.suggestion });
    return DashboardOperationError.make(failure);
  }
  return DashboardOperationError.make({
    operation,
    code: "INTERNAL_ERROR",
    message: "The local dashboard operation failed.",
    status: 500,
    retryable: false,
  });
}

export function attempt<A>(operation: string, run: () => A | PromiseLike<A>) {
  return Effect.tryPromise({
    try: () => Promise.resolve().then(run),
    catch: (cause) => operationError(operation, cause),
  });
}
