export type TeamRolloutPolicyModel = "manual" | "notify" | "automatic";
export type TeamContributionStatusModel =
  | "pending"
  | "rejected"
  | "adopted"
  | "stale"
  | "rolled_back";

export interface TeamContributionFileModel {
  path: string;
  hash: string;
  size: number;
}

export interface TeamContributionChangeModel {
  path: string;
  kind: "added" | "modified" | "removed";
  baseHash: string | null;
  candidateHash: string | null;
}

export interface TeamContributionEfficacyEvidenceModel {
  summary: string;
  evaluatedCases: number;
  passedCases: number;
  regressionCount: number;
}

export interface TeamRevisionContributionModel {
  id: string;
  entryId: string;
  entryName: string;
  baseVersionId: string;
  baseVersion: string;
  candidateVersion: string;
  candidateContentHash: string;
  files: TeamContributionFileModel[];
  changes: TeamContributionChangeModel[];
  efficacyEvidence?: TeamContributionEfficacyEvidenceModel | null;
  summary: string;
  submittedBy: string;
  submittedByName: string;
  status: TeamContributionStatusModel;
  reviewedBy: string | null;
  adoptedVersionId: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface TeamManagedInstallationModel {
  id: string;
  entryId: string;
  entryName: string;
  deviceId: string;
  installedVersion: string;
  installedContentHash: string | null;
  latestVersion: string;
  latestContentHash: string;
  rolloutPolicy: TeamRolloutPolicyModel;
  updateStatus: "current" | "update_available" | "updated" | "conflict" | "failed" | "rolled_back";
  lastSyncedAt: string;
  lastConflictAt: string | null;
  lastReceiptId: string | null;
}

export interface TeamRegistryEntryModel {
  id: string;
  name: string;
  rolloutPolicy: TeamRolloutPolicyModel;
  currentVersion: string | null;
  pendingContributions: number;
  installations: number;
  conflicts: number;
}

export interface TeamCollaborationSnapshotModel {
  entries: TeamRegistryEntryModel[];
  contributions: TeamRevisionContributionModel[];
  installations: TeamManagedInstallationModel[];
}
