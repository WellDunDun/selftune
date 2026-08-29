import * as Schema from "effect/Schema";

import type {
  TeamCollaborationSnapshotModel,
  TeamContributionStatusModel,
  TeamRolloutPolicyModel,
} from "@selftune/dashboard-core/models";
import { loadRemoteLibraryConfig } from "@selftune/runtime/remote-library-config";

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const UtcTimestamp = Schema.String.check(
  Schema.makeFilter((value) => {
    const epochMillis = Date.parse(value);
    return Number.isFinite(epochMillis) && new Date(epochMillis).toISOString() === value
      ? undefined
      : "Expected a canonical ISO-8601 UTC timestamp";
  }),
);
const RolloutPolicy = Schema.Literals(["manual", "notify", "automatic"]);
const ContributionStatus = Schema.Literals([
  "pending",
  "rejected",
  "adopted",
  "stale",
  "rolled_back",
]);
const ContributionFile = Schema.Struct({
  path: Schema.NonEmptyString,
  hash: Sha256,
  size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
const ContributionChange = Schema.Struct({
  path: Schema.NonEmptyString,
  kind: Schema.Literals(["added", "modified", "removed"]),
  baseHash: Schema.NullOr(Sha256),
  candidateHash: Schema.NullOr(Sha256),
});
const RevisionContribution = Schema.Struct({
  id: Schema.String,
  entryId: Schema.String,
  entryName: Schema.NonEmptyString,
  baseVersionId: Schema.String,
  baseVersion: Schema.NonEmptyString,
  candidateVersion: Schema.NonEmptyString,
  candidateContentHash: Sha256,
  files: Schema.Array(ContributionFile),
  changes: Schema.Array(ContributionChange),
  summary: Schema.NonEmptyString,
  submittedBy: Schema.String,
  submittedByName: Schema.NonEmptyString,
  status: ContributionStatus,
  reviewedBy: Schema.NullOr(Schema.String),
  adoptedVersionId: Schema.NullOr(Schema.String),
  createdAt: UtcTimestamp,
  reviewedAt: Schema.NullOr(UtcTimestamp),
});
const ManagedInstallation = Schema.Struct({
  id: Schema.String,
  entryId: Schema.String,
  entryName: Schema.NonEmptyString,
  deviceId: Schema.String,
  installedVersion: Schema.NonEmptyString,
  installedContentHash: Schema.NullOr(Sha256),
  latestVersion: Schema.NonEmptyString,
  latestContentHash: Sha256,
  rolloutPolicy: RolloutPolicy,
  updateStatus: Schema.Literals([
    "current",
    "update_available",
    "updated",
    "conflict",
    "failed",
    "rolled_back",
  ]),
  lastSyncedAt: UtcTimestamp,
  lastConflictAt: Schema.NullOr(UtcTimestamp),
  lastReceiptId: Schema.NullOr(Schema.String),
});
const RegistryEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.NonEmptyString,
  rolloutPolicy: RolloutPolicy,
  currentVersion: Schema.NullOr(Schema.NonEmptyString),
  pendingContributions: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  installations: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  conflicts: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
const CollaborationSnapshot = Schema.Struct({
  entries: Schema.Array(RegistryEntry),
  contributions: Schema.Array(RevisionContribution),
  installations: Schema.Array(ManagedInstallation),
});
const RolloutPolicyResult = Schema.Struct({
  entryId: Schema.String,
  policy: RolloutPolicy,
});
const ContributionDecisionResult = Schema.Struct({
  id: Schema.String,
  status: ContributionStatus,
  adoptedVersionId: Schema.optionalKey(Schema.String),
  restoredVersionId: Schema.optionalKey(Schema.String),
  rolloutPolicy: Schema.optionalKey(RolloutPolicy),
});
const CloudErrorResponse = Schema.Struct({
  error: Schema.Union([
    Schema.String,
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
      suggestion: Schema.optionalKey(Schema.String),
      retryable: Schema.optionalKey(Schema.Boolean),
    }),
  ]),
});
const TeamRole = Schema.Literals(["viewer", "member", "admin", "owner"]);
const TeamStatus = Schema.Struct({
  currentUserId: Schema.String,
  currentRole: TeamRole,
  readOnly: Schema.Boolean,
  seatUsage: Schema.Int,
  seatLimit: Schema.NullOr(Schema.Int),
  billingPath: Schema.String,
  members: Schema.Array(
    Schema.Struct({
      userId: Schema.String,
      email: Schema.String,
      name: Schema.NullOr(Schema.String),
      avatarUrl: Schema.NullOr(Schema.String),
      role: TeamRole,
      joinedAt: Schema.String,
    }),
  ),
  invitations: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      email: Schema.String,
      role: TeamRole,
      invitedBy: Schema.String,
      invitedAt: Schema.String,
    }),
  ),
});

export interface TeamCollaborationAccessModel {
  readonly currentRole: "viewer" | "member" | "admin" | "owner";
  readonly readOnly: boolean;
}

export interface TeamRolloutPolicyResultModel {
  readonly entryId: string;
  readonly policy: TeamRolloutPolicyModel;
}

export interface TeamContributionDecisionResultModel {
  readonly id: string;
  readonly status: TeamContributionStatusModel;
  readonly adoptedVersionId?: string;
  readonly restoredVersionId?: string;
  readonly rolloutPolicy?: TeamRolloutPolicyModel;
}

export class CloudTeamCollaborationError extends Schema.TaggedErrorClass<CloudTeamCollaborationError>()(
  "CloudTeamCollaborationError",
  {
    code: Schema.String,
    message: Schema.String,
    status: Schema.Number,
    suggestion: Schema.optionalKey(Schema.String),
    retryable: Schema.Boolean,
  },
) {}

export interface CloudTeamCollaborationTransportOptions {
  readonly fetch?: typeof fetch;
  readonly loadRemoteLibraryConfig?: typeof loadRemoteLibraryConfig;
}

function invalidResponse(): CloudTeamCollaborationError {
  return CloudTeamCollaborationError.make({
    code: "API_ERROR",
    message: "SelfTune Cloud returned an invalid team collaboration response.",
    status: 502,
    suggestion: "Retry in a moment.",
    retryable: true,
  });
}

async function collaborationRequest(input: {
  readonly configRoot: string;
  readonly fetch: typeof fetch;
  readonly loadConfig: typeof loadRemoteLibraryConfig;
  readonly path: string;
  readonly method: "GET" | "PATCH" | "POST";
  readonly body?: unknown;
}): Promise<unknown> {
  const remote = input.loadConfig(input.configRoot);
  let response: Response;
  try {
    response = await input.fetch(new URL(input.path, remote.url), {
      method: input.method,
      headers: {
        Authorization: `Bearer ${remote.apiKey}`,
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
  } catch (cause) {
    throw CloudTeamCollaborationError.make({
      code: "API_ERROR",
      message: cause instanceof Error ? cause.message : "Unable to reach SelfTune Cloud.",
      status: 503,
      suggestion: "Check the Cloud connection and retry.",
      retryable: true,
    });
  }

  const responseText = await response.text();
  if (!response.ok) {
    if (response.status === 404 && responseText.trim() === "404 Not Found") {
      throw CloudTeamCollaborationError.make({
        code: "API_ERROR",
        message: "The connected SelfTune deployment does not expose team collaboration yet.",
        status: 502,
        suggestion: "Deploy the current Cloud API, then retry.",
        retryable: false,
      });
    }
    try {
      const decoded = Schema.decodeUnknownSync(CloudErrorResponse)(JSON.parse(responseText));
      const error = typeof decoded.error === "string" ? { message: decoded.error } : decoded.error;
      throw CloudTeamCollaborationError.make({
        code: error.code ?? "API_ERROR",
        message: error.message ?? `Team collaboration request failed (${response.status}).`,
        status: response.status,
        ...(error.suggestion ? { suggestion: error.suggestion } : {}),
        retryable: error.retryable ?? response.status >= 500,
      });
    } catch (cause) {
      if (cause instanceof CloudTeamCollaborationError) throw cause;
    }
    throw CloudTeamCollaborationError.make({
      code: "API_ERROR",
      message: `Team collaboration request failed (${response.status}).`,
      status: response.status,
      ...(response.status >= 500 ? { suggestion: "Retry in a moment." } : {}),
      retryable: response.status >= 500,
    });
  }

  try {
    return JSON.parse(responseText);
  } catch {
    throw invalidResponse();
  }
}

function decodeSnapshot(body: unknown): TeamCollaborationSnapshotModel {
  try {
    const decoded = Schema.decodeUnknownSync(CollaborationSnapshot)(body);
    return {
      entries: decoded.entries.map((entry) => ({ ...entry })),
      contributions: decoded.contributions.map((contribution) => ({
        ...contribution,
        files: contribution.files.map((file) => ({ ...file })),
        changes: contribution.changes.map((change) => ({ ...change })),
      })),
      installations: decoded.installations.map((installation) => ({ ...installation })),
    };
  } catch {
    throw invalidResponse();
  }
}

function decodeAccess(body: unknown): TeamCollaborationAccessModel {
  try {
    const status = Schema.decodeUnknownSync(TeamStatus)(body);
    return { currentRole: status.currentRole, readOnly: status.readOnly };
  } catch {
    throw invalidResponse();
  }
}

function decodeRolloutPolicyResult(body: unknown): TeamRolloutPolicyResultModel {
  try {
    return Schema.decodeUnknownSync(RolloutPolicyResult)(body);
  } catch {
    throw invalidResponse();
  }
}

function decodeDecisionResult(body: unknown): TeamContributionDecisionResultModel {
  try {
    return Schema.decodeUnknownSync(ContributionDecisionResult)(body);
  } catch {
    throw invalidResponse();
  }
}

/** Retains the device credential in the sidecar and forwards only validated collaboration data. */
export function makeCloudTeamCollaborationOperations(
  configRoot: string,
  options: CloudTeamCollaborationTransportOptions = {},
) {
  const fetchImplementation = options.fetch ?? fetch;
  const loadConfig = options.loadRemoteLibraryConfig ?? loadRemoteLibraryConfig;
  const request = (
    input: Omit<Parameters<typeof collaborationRequest>[0], "configRoot" | "fetch" | "loadConfig">,
  ) =>
    collaborationRequest({
      ...input,
      configRoot,
      fetch: fetchImplementation,
      loadConfig,
    });
  const decide = (
    contributionId: string,
    action: "adopt" | "reject" | "rollback",
  ): Promise<TeamContributionDecisionResultModel> =>
    request({
      path: `/api/v1/collaboration/contributions/${encodeURIComponent(contributionId)}/${action}`,
      method: "POST",
    }).then(decodeDecisionResult);

  return {
    access: (): Promise<TeamCollaborationAccessModel> =>
      request({ path: "/api/v1/cloud/team", method: "GET" }).then(decodeAccess),
    snapshot: (): Promise<TeamCollaborationSnapshotModel> =>
      request({ path: "/api/v1/collaboration", method: "GET" }).then(decodeSnapshot),
    updateRolloutPolicy: (
      entryId: string,
      policy: TeamRolloutPolicyModel,
    ): Promise<TeamRolloutPolicyResultModel> =>
      request({
        path: `/api/v1/collaboration/registry/${encodeURIComponent(entryId)}/rollout-policy`,
        method: "PATCH",
        body: { policy },
      }).then(decodeRolloutPolicyResult),
    decide,
  } as const;
}
