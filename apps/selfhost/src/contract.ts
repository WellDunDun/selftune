import * as Schema from "effect/Schema";
import {
  HostedContributorAggregate,
  HostedContributorSignal,
  HostedManifestRequest,
} from "@selftune/control-plane";

export const RemoteArtifactType = Schema.Literals([
  "skill_revision",
  "draft_revision",
  "skill_set",
  "decision_history",
  "evidence_summary",
]);

export type RemoteArtifactType = typeof RemoteArtifactType.Type;

const MetadataValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);

export const RemoteArtifact = Schema.Struct({
  artifact_id: Schema.String,
  artifact_type: RemoteArtifactType,
  object_sha256: Schema.String,
  revision: Schema.String,
  metadata: Schema.Record(Schema.String, MetadataValue),
});

export type RemoteArtifact = typeof RemoteArtifact.Type;

export const CreateSnapshotRequest = Schema.Struct({
  schema_version: Schema.Literal("selftune.remote-library.snapshot.v1"),
  expected_parent_id: Schema.NullOr(Schema.String),
  artifacts: Schema.Array(RemoteArtifact),
});

export type CreateSnapshotRequest = typeof CreateSnapshotRequest.Type;

export interface RemoteSnapshot {
  readonly id: string;
  readonly parent_snapshot_id: string | null;
  readonly schema_version: "selftune.remote-library.snapshot.v1";
  readonly artifacts: ReadonlyArray<RemoteArtifact>;
  readonly created_at: string;
}

export const CreateShareRequest = Schema.Struct({
  snapshot_id: Schema.String,
  artifact_id: Schema.String,
  recipient_email: Schema.String,
  expires_at: Schema.optional(Schema.NullOr(Schema.String)),
});

export type CreateShareRequest = typeof CreateShareRequest.Type;

export const CreatePackRequest = Schema.Struct({
  snapshot_id: Schema.String,
  artifact_id: Schema.String,
  mode: Schema.Literals(["reusable_unlisted", "private_single_claim"]),
  expires_at: Schema.optional(Schema.NullOr(Schema.String)),
});

export type CreatePackRequest = typeof CreatePackRequest.Type;

export interface SelfHostPackPreview {
  readonly protocol: "selftune.skill-set-pack.v1";
  readonly packId: string;
  readonly artifactId: string;
  readonly name: string;
  readonly description: string;
  readonly skillSetRevisionSha256: string;
  readonly objectSha256: string;
  readonly mode: "reusable_unlisted" | "private_single_claim";
  readonly expiresAt: string;
  readonly requiresSignIn: false;
  readonly components: ReadonlyArray<{
    readonly logicalSkillId: string;
    readonly licenseExpression: string;
  }>;
}

export interface SelfHostPackManagementItem {
  readonly packId: string;
  readonly artifactId: string;
  readonly name: string;
  readonly description: string;
  readonly mode: "reusable_unlisted" | "private_single_claim";
  readonly status: "active" | "claimed" | "expired" | "revoked";
  readonly packUrl: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly revokedAt: string | null;
  readonly skillSetRevisionSha256: string;
  readonly objectSha256: string;
  readonly componentCount: number;
}

export const SharedSetManifest = Schema.Struct({
  skills: Schema.Array(Schema.Struct({ content_hash: Schema.String })),
});

export type UserRole = "admin" | "member" | "viewer";

export interface SelfHostUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly orgId: string;
  readonly orgName: string;
  readonly role: UserRole;
}

export interface ConfiguredUser {
  readonly email: string;
  readonly name: string | null;
  readonly orgId: string | null;
  readonly orgName: string;
  readonly role: UserRole;
  readonly token: string;
}

export const ContributorSignalPayload = HostedContributorSignal;
export type ContributorSignalPayload = typeof HostedContributorSignal.Type;

export const DesktopManifestPayload = HostedManifestRequest;
export type DesktopManifestPayload = typeof HostedManifestRequest.Type;

export type ContributorSignalAggregate = typeof HostedContributorAggregate.Type;

export type RemoteShareStatus = "pending" | "accepted" | "imported" | "revoked" | "expired";

export interface RemoteShare {
  readonly id: string;
  readonly owner_org_id: string;
  readonly source_snapshot_id: string;
  readonly root_artifact_id: string;
  readonly root_artifact_type: RemoteArtifactType;
  readonly artifacts: ReadonlyArray<RemoteArtifact>;
  readonly owner: { readonly org_id: string; readonly name: string };
  readonly recipient: {
    readonly user_id: string;
    readonly email: string;
    readonly name: string | null;
  };
  readonly created_by: string;
  readonly status: RemoteShareStatus;
  readonly expires_at: string | null;
  readonly accepted_at: string | null;
  readonly imported_at: string | null;
  readonly imported_org_id: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RemoteDiagnostics {
  readonly status: "ok" | "degraded";
  readonly object_count: number;
  readonly snapshot_count: number;
  readonly referenced_object_count: number;
  readonly total_bytes: number;
  readonly missing_objects: ReadonlyArray<string>;
  readonly orphaned_objects: ReadonlyArray<string>;
}

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
