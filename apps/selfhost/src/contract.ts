import * as Schema from "effect/Schema";

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
