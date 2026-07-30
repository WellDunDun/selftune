export type DashboardDecisionStatus =
  | "pending"
  | "approved"
  | "declined"
  | "stale"
  | "expired"
  | "failed";

export interface DashboardDecisionAuditModel {
  event: "prepared" | Exclude<DashboardDecisionStatus, "pending">;
  at: string;
  reason: string | null;
}

interface DashboardDecisionBaseModel {
  id: string;
  status: DashboardDecisionStatus;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  failure: { code: string; message: string } | null;
  audit: DashboardDecisionAuditModel[];
  hasRecoveryReceipt: boolean;
}

export interface DashboardSourceMergeDecisionModel extends DashboardDecisionBaseModel {
  kind: "source_merge";
  skillName: string;
  source: string;
  connection: string;
  model: string | null;
  installedHash: string;
  latestHash: string;
  targets: Array<{ path: string; conflicts: string[]; summary: string; mergedDiff: string }>;
}

export interface DashboardRemovalDecisionModel extends DashboardDecisionBaseModel {
  kind: "skill_removal";
  skillName: string;
  locations: Array<{
    connection: string | null;
    originalPackagePath: string;
    originalSkillPath: string;
    archiveDestination: string;
    packageVersionHash: string | null;
    quarantineId: string;
    recovery: string;
  }>;
}

export interface DashboardSkillSetConflictDecisionModel extends DashboardDecisionBaseModel {
  kind: "skill_set_conflict";
  skillSetId: string;
  projectRoot: string;
  creates: number;
  unchanged: number;
  conflicts: number;
  impacts: Array<{
    connection: string;
    skillName: string;
    targetPath: string;
    replacementSourcePath: string;
    currentFingerprint: string | null;
    replacementFingerprint: string;
    backupPath: string;
    rollback: string;
  }>;
  recoveryStatus: "applied" | "rolled_back" | null;
}

export interface DashboardSkillConsolidationDecisionModel extends DashboardDecisionBaseModel {
  kind: "skill_consolidation";
  skillName: string;
  canonicalContentHash: string;
  canonicalPackagePath: string;
  targets: Array<{
    action: "replace_with_link" | "archive_copy";
    connection: string | null;
    projectRoot: string | null;
    originalPackagePath: string;
    originalContentHash: string;
    archiveDestination: string;
  }>;
  recoveryStatus: "applied" | "rolled_back" | null;
}

export type DashboardDecisionModel =
  | DashboardSourceMergeDecisionModel
  | DashboardRemovalDecisionModel
  | DashboardSkillConsolidationDecisionModel
  | DashboardSkillSetConflictDecisionModel;
