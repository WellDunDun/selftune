export interface RemoteLibraryConnection {
  readonly apiKey: string;
  readonly url: string;
}

export interface RemoteLibraryShareArtifact {
  artifact_id: string;
  artifact_type:
    | "skill_revision"
    | "draft_revision"
    | "skill_set"
    | "decision_history"
    | "evidence_summary";
  object_sha256: string;
  revision: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RemoteLibraryShare {
  id: string;
  owner_org_id: string;
  source_snapshot_id: string;
  root_artifact_id: string;
  root_artifact_type: RemoteLibraryShareArtifact["artifact_type"];
  artifacts: RemoteLibraryShareArtifact[];
  owner: { org_id: string; name: string };
  recipient: { user_id: string; email: string; name: string | null };
  created_by: string;
  status: "pending" | "accepted" | "imported" | "revoked" | "expired";
  expires_at: string | null;
  accepted_at: string | null;
  imported_at: string | null;
  imported_org_id: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RemoteLibrarySharesResponse {
  inbox: RemoteLibraryShare[];
  outbox: RemoteLibraryShare[];
}

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

export interface SkillShareGrantReceipt {
  shareId: string;
  mode: "reusable_unlisted" | "private_single_claim";
  delivery: "copy_link" | "email";
  shareUrl: string | null;
  expiresAt: string;
}

export type WorkspaceSkillSetPolicyAction = "allow" | "require_approval" | "block" | "require";

export interface WorkspaceSkillSetPolicy {
  skill_set_id: string;
  skill_set_name: string;
  owner_scope: "workspace";
  action: WorkspaceSkillSetPolicyAction;
  reason: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

export interface WorkspaceSkillSetPoliciesResponse {
  current_role: WorkspaceMemberRole;
  policies: WorkspaceSkillSetPolicy[];
}

export type WorkspaceMemberRole = "viewer" | "member" | "admin" | "owner";

export interface WorkspaceMember {
  user_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  role: WorkspaceMemberRole;
  accepted_at: string | null;
  joined_at: string;
}

export interface WorkspaceMembersResponse {
  current_user_id: string;
  current_role: WorkspaceMemberRole;
  members: WorkspaceMember[];
  invitations: Array<{
    id: string;
    email: string;
    role: WorkspaceMemberRole;
    invited_by: string;
    invited_at: string;
  }>;
}

export interface WorkspaceTeamOverview {
  current_user_id: string;
  current_role: WorkspaceMemberRole;
  reporting: { privacy: "metadata_only"; raw_sessions_uploaded: false };
  members: Array<{
    user_id: string;
    email: string;
    name: string | null;
    role: WorkspaceMemberRole;
    devices: Array<{
      device_id: string;
      name: string;
      platform: string;
      last_seen_at: string;
      installed_skills: number;
    }>;
  }>;
  skills: Array<{
    identity: string;
    installed_by_user_ids: string[];
    installations: Array<{
      user_id: string;
      device_id: string;
      device_name: string;
      revision_hash: string;
      scope: string;
      connections: string[];
      update_status: "current" | "available" | "unknown";
      usage_status: "recent" | "stale" | "none";
    }>;
    usage_status: "recent" | "stale" | "none";
    update_available_count: number;
    recommendation: "update" | "review_usage" | "healthy";
  }>;
}
