import * as Schema from "effect/Schema";

export interface RemoteLibraryConnection {
  readonly apiKey: string;
  readonly url: string;
}

export const RemoteLibraryShareArtifact = Schema.Struct({
  artifact_id: Schema.String,
  artifact_type: Schema.Literals([
    "skill_revision",
    "draft_revision",
    "skill_set",
    "decision_history",
    "evidence_summary",
  ]),
  object_sha256: Schema.String,
  revision: Schema.String,
  metadata: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]),
  ),
});
export type RemoteLibraryShareArtifact = typeof RemoteLibraryShareArtifact.Type;

export const RemoteLibraryShare = Schema.Struct({
  id: Schema.String,
  owner_org_id: Schema.String,
  source_snapshot_id: Schema.String,
  root_artifact_id: Schema.String,
  root_artifact_type: RemoteLibraryShareArtifact.fields.artifact_type,
  artifacts: Schema.mutable(Schema.Array(RemoteLibraryShareArtifact)),
  owner: Schema.Struct({ org_id: Schema.String, name: Schema.String }),
  recipient: Schema.Struct({
    user_id: Schema.String,
    email: Schema.String,
    name: Schema.NullOr(Schema.String),
  }),
  created_by: Schema.String,
  status: Schema.Literals(["pending", "accepted", "imported", "revoked", "expired"]),
  expires_at: Schema.NullOr(Schema.String),
  accepted_at: Schema.NullOr(Schema.String),
  imported_at: Schema.NullOr(Schema.String),
  imported_org_id: Schema.NullOr(Schema.String),
  revoked_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type RemoteLibraryShare = typeof RemoteLibraryShare.Type;

export const RemoteLibrarySharesResponse = Schema.Struct({
  inbox: Schema.mutable(Schema.Array(RemoteLibraryShare)),
  outbox: Schema.mutable(Schema.Array(RemoteLibraryShare)),
});
export type RemoteLibrarySharesResponse = typeof RemoteLibrarySharesResponse.Type;

export interface CreateRemoteLibraryShareRequest {
  snapshot_id: string;
  artifact_id: string;
  recipient_email: string;
  expires_at?: string | null;
}

export type CreateSkillShareGrantRequest =
  | {
      skillId: string;
      snapshotId: string;
      artifactId: string;
      mode: "reusable_unlisted" | "private_single_claim";
      delivery: "copy_link";
    }
  | {
      skillId: string;
      snapshotId: string;
      artifactId: string;
      mode: "private_single_claim";
      delivery: "email";
      recipientEmail: string;
    }
  | {
      skillSetId: string;
      mode: "reusable_unlisted" | "private_single_claim";
      delivery: "copy_link";
    }
  | {
      skillSetId: string;
      mode: "private_single_claim";
      delivery: "email";
      recipientEmail: string;
    };

export const SkillShareGrantReceipt = Schema.Struct({
  shareId: Schema.String,
  mode: Schema.Literals(["reusable_unlisted", "private_single_claim"]),
  delivery: Schema.Literals(["copy_link", "email"]),
  shareUrl: Schema.NullOr(Schema.String),
  expiresAt: Schema.String,
});
export type SkillShareGrantReceipt = typeof SkillShareGrantReceipt.Type;

export const WorkspaceSkillSetPolicyAction = Schema.Literals([
  "allow",
  "require_approval",
  "block",
  "require",
]);
export type WorkspaceSkillSetPolicyAction = typeof WorkspaceSkillSetPolicyAction.Type;

export const WorkspaceSkillSetPolicy = Schema.Struct({
  skill_set_id: Schema.String,
  skill_set_name: Schema.String,
  owner_scope: Schema.Literal("workspace"),
  action: WorkspaceSkillSetPolicyAction,
  reason: Schema.NullOr(Schema.String),
  updated_by: Schema.NullOr(Schema.String),
  updated_at: Schema.NullOr(Schema.String),
});
export type WorkspaceSkillSetPolicy = typeof WorkspaceSkillSetPolicy.Type;

export const WorkspaceMemberRole = Schema.Literals(["viewer", "member", "admin", "owner"]);
export type WorkspaceMemberRole = typeof WorkspaceMemberRole.Type;

export const WorkspaceSkillSetPoliciesResponse = Schema.Struct({
  current_role: WorkspaceMemberRole,
  policies: Schema.mutable(Schema.Array(WorkspaceSkillSetPolicy)),
});
export type WorkspaceSkillSetPoliciesResponse = typeof WorkspaceSkillSetPoliciesResponse.Type;

export const WorkspaceMember = Schema.Struct({
  user_id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatar_url: Schema.NullOr(Schema.String),
  role: WorkspaceMemberRole,
  accepted_at: Schema.NullOr(Schema.String),
  joined_at: Schema.String,
});
export type WorkspaceMember = typeof WorkspaceMember.Type;

export const WorkspaceMembersResponse = Schema.Struct({
  current_user_id: Schema.String,
  current_role: WorkspaceMemberRole,
  members: Schema.mutable(Schema.Array(WorkspaceMember)),
  invitations: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        email: Schema.String,
        role: WorkspaceMemberRole,
        invited_by: Schema.String,
        invited_at: Schema.String,
      }),
    ),
  ),
});
export type WorkspaceMembersResponse = typeof WorkspaceMembersResponse.Type;

const UsageStatus = Schema.Literals(["recent", "stale", "none"]);
export const WorkspaceTeamOverview = Schema.Struct({
  current_user_id: Schema.String,
  current_role: WorkspaceMemberRole,
  reporting: Schema.Struct({
    privacy: Schema.Literal("metadata_only"),
    raw_sessions_uploaded: Schema.Literal(false),
  }),
  members: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        user_id: Schema.String,
        email: Schema.String,
        name: Schema.NullOr(Schema.String),
        role: WorkspaceMemberRole,
        devices: Schema.mutable(
          Schema.Array(
            Schema.Struct({
              device_id: Schema.String,
              name: Schema.String,
              platform: Schema.String,
              last_seen_at: Schema.String,
              installed_skills: Schema.Finite,
            }),
          ),
        ),
      }),
    ),
  ),
  skills: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        identity: Schema.String,
        installed_by_user_ids: Schema.mutable(Schema.Array(Schema.String)),
        installations: Schema.mutable(
          Schema.Array(
            Schema.Struct({
              user_id: Schema.String,
              device_id: Schema.String,
              device_name: Schema.String,
              revision_hash: Schema.String,
              scope: Schema.String,
              connections: Schema.mutable(Schema.Array(Schema.String)),
              update_status: Schema.Literals(["current", "available", "unknown"]),
              usage_status: UsageStatus,
            }),
          ),
        ),
        usage_status: UsageStatus,
        update_available_count: Schema.Finite,
        recommendation: Schema.Literals(["update", "review_usage", "healthy"]),
      }),
    ),
  ),
});
export type WorkspaceTeamOverview = typeof WorkspaceTeamOverview.Type;
