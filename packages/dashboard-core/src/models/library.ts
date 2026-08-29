export type LibraryLifecycle = "active" | "library" | "draft" | "archived";
export type LibraryUpdateStatus = "available" | "current" | "unknown" | "untracked";

export interface LibraryCategoryOptionModel {
  id: string;
  label: string;
}

export interface LibraryCategoryModel extends LibraryCategoryOptionModel {
  inferredId: string;
  source: "inferred" | "human";
  confidence: number;
  reason: string;
  overrideReason?: string | null;
  matchedTerms: string[];
}

export interface LibraryPrimaryActionModel {
  label: string;
  href: string;
  kind: "review" | "fix" | "setup" | "run" | "open";
}

export interface LibrarySourceModel {
  kind: "github" | "upload" | "draft" | "local" | "other";
  label: string;
  href?: string | null;
  path?: string | null;
}

export interface LibraryConnectionIconModel {
  src: string;
  fit: "contain" | "cover";
  inset: "none" | "sm";
  invert_in_dark?: boolean;
}

export interface LibraryLocationModel {
  id: string;
  groupId?: string | null;
  rootPath?: string | null;
  label: string;
  path: string;
  sourceKind?: string | null;
  linkedPath?: string | null;
  connection?: string | null;
  connectionIcon?: LibraryConnectionIconModel | null;
  lastUsedAt?: string | null;
  modifiedAt?: string | null;
  removable: boolean;
}

export interface LibraryArchiveRecommendationModel {
  classification: string;
  reason: string;
  skillPath: string;
  packagePath: string;
}

export interface LibraryConsolidationRecommendationModel {
  installedCount: number;
  projectCount: number;
  duplicateCount: number;
  divergentCount: number;
  reason: string;
  canonical: {
    contentHash: string;
    packagePath: string;
    confidence: "source_current" | "review_required";
  };
  targets: Array<{
    packagePath: string;
    contentHash: string;
    action: "replace_with_link" | "archive_copy";
    projectRoot?: string | null;
    connection?: string | null;
  }>;
}

export interface LibraryStatusBadgeModel {
  label: string;
  tone: "healthy" | "warning" | "critical" | "pending" | "neutral";
}

export interface LibraryTriggerTrendPointModel {
  date: string;
  count: number;
}

export interface LibrarySkillModel {
  id: string;
  name: string;
  lifecycle: LibraryLifecycle;
  category?: LibraryCategoryModel | null;
  status: string;
  updateStatus: LibraryUpdateStatus;
  sources: LibrarySourceModel[];
  locations: LibraryLocationModel[];
  revisionHashes: string[];
  modifiedAt?: string | null;
  lastUsedAt?: string | null;
  triggerTrend?: LibraryTriggerTrendPointModel[];
  lifetimeTriggerCount?: number | null;
  detailHref?: string | null;
  restoreId?: string | null;
  archiveRecommendation?: LibraryArchiveRecommendationModel | null;
  consolidationRecommendation?: LibraryConsolidationRecommendationModel | null;
  statusBadge?: LibraryStatusBadgeModel | null;
  primaryAction?: LibraryPrimaryActionModel | null;
}

export interface LibraryInventorySummaryModel {
  ready: number;
  snapshots: number;
  pendingActions: number;
}

export interface LibraryInventoryNoteModel {
  title: string;
  description: string;
  link?: { label: string; href: string } | null;
}

export interface LibraryInventoryModel {
  skills: LibrarySkillModel[];
  categoryOptions: LibraryCategoryOptionModel[];
  summary?: LibraryInventorySummaryModel | null;
  note?: LibraryInventoryNoteModel | null;
}

export interface LibraryCategoryUpdateInput {
  skillId: string;
  skillName: string;
  categoryId: string | null;
  inferredCategoryId: string;
}

export interface LibraryDiffModel {
  title: string;
  description?: string | null;
  diff: string;
}

export interface LibrarySourceUpdateModel {
  status: "available" | "current";
  installedVersion?: string | null;
  latestVersion?: string | null;
  conflicts: number;
  locations: Array<{
    path: string;
    canonicalTarget: string;
    localState: string;
    reason: string;
  }>;
  diffs: LibraryDiffModel[];
}

export interface LibraryUpdateReceiptModel {
  installedVersion: string;
  receiptId: string;
}

export interface LibrarySkillBackupReceiptModel {
  uploaded: number;
  unchanged: number;
  snapshotId: string;
}

export type LibraryShareMode = "reusable_unlisted" | "private_single_claim";

export type LibraryShareInput =
  | {
      skillId: string;
      mode: LibraryShareMode;
      delivery: "copy_link";
    }
  | {
      skillId: string;
      mode: "private_single_claim";
      delivery: "email";
      recipientEmail: string;
    };

export interface LibraryShareReceiptModel {
  shareId: string;
  mode: LibraryShareMode;
  delivery: "copy_link" | "email";
  shareUrl?: string | null;
  expiresAt: string;
}

export interface LibraryLicenseDraftTerms {
  copyrightHolder: string;
  licensedOrganization: string;
  year: number;
}

export interface LibraryLicenseDraftPreviewModel {
  previewId: string;
  skillPath: string;
  licenseExpression: string;
  files: ReadonlyArray<{ path: "SKILL.md" | "LICENSE"; patch: string }>;
}

export type LibraryInstallAgent = "codex" | "claude_code" | "opencode" | "openclaw" | "pi";

export interface LibrarySkillInstallReceiptModel {
  skillId: string;
  targetAgent: LibraryInstallAgent;
  targetPath: string;
}

export interface LibraryMergeModel {
  mergeId: string;
  summary: string;
  diffs: LibraryDiffModel[];
}

export interface LibraryMergeConnectionModel {
  id: string;
  label: string;
  supportsModelOverride: boolean;
  icon?: LibraryConnectionIconModel | null;
}

export interface LibraryArchiveInput {
  skillName: string;
  skillPath: string;
}

export interface LibraryArchiveBatchResult {
  succeeded: number;
  failed: number;
}

export interface LibraryPrepareMergeInput {
  skillId: string;
  connectionId: string;
  model?: string | null;
}
