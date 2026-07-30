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
      mode: "reusable_unlisted";
      delivery: "copy_link";
    }
  | {
      skillSetId: string;
      mode: "reusable_unlisted";
      delivery: "copy_link";
    };

export interface SkillShareGrantReceipt {
  shareId: string;
  mode: "reusable_unlisted";
  delivery: "copy_link";
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
