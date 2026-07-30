export type PortfolioClassification =
  | "protected"
  | "unobserved"
  | "under_observed"
  | "routing_problem"
  | "active"
  | "inactive_candidate"
  | "consolidation_candidate";

export type PortfolioRecommendation =
  | "keep"
  | "measure"
  | "repair_routing"
  | "review_consolidation"
  | "review_quarantine";

export type InstalledSkillScope = "project" | "global" | "admin" | "system" | "unknown";

export interface PortfolioAuditEntry {
  skill_name: string;
  skill_path: string;
  package_path: string;
  scope: InstalledSkillScope;
  classification: PortfolioClassification;
  recommendation: PortfolioRecommendation;
  reason: string;
  evidence: {
    trusted_checks: number;
    triggered_count: number;
    miss_rate: number | null;
    last_seen_at: string | null;
    last_invoked_at: string | null;
    sessions_since_invocation: number;
    inactive_days: number;
    package_modified_at: string;
  };
}

export interface PortfolioAuditResult {
  generated_at: string;
  thresholds: {
    min_sessions: number;
    inactive_days: number;
    min_checks: number;
    routing_miss_rate: number;
  };
  session_count: number;
  installed_count: number;
  counts: Record<PortfolioClassification, number>;
  skills: PortfolioAuditEntry[];
}

export interface QuarantineRecord {
  schema_version: 1;
  quarantine_id: string;
  status: "preparing" | "quarantined" | "restoring" | "restored";
  skill_name: string;
  skill_scope: InstalledSkillScope;
  original_package_path: string;
  original_skill_path: string;
  quarantined_package_path: string;
  package_version_hash: string | null;
  quarantined_at: string;
  restored_at: string | null;
}

export interface QuarantineReceipt {
  success: true;
  status: "quarantined" | "already_quarantined" | "restored" | "already_restored";
  skill_name: string;
  quarantine_id: string;
  original_package_path: string;
  quarantined_package_path: string;
  package_version_hash: string | null;
  dry_run: boolean;
  undo_command: string | null;
}

export interface PortfolioQuarantineBatchFailure {
  skill_name: string;
  skill_path: string;
  message: string;
}

export interface PortfolioQuarantineBatchResult {
  receipts: QuarantineReceipt[];
  failures: PortfolioQuarantineBatchFailure[];
}

export interface PortfolioResponse {
  audit: PortfolioAuditResult;
  quarantined: QuarantineRecord[];
}

/** Package-owned harness identity. The composed registry is the runtime authority. */
export type HarnessId = string;
export type HarnessConnectionStatus = "connected" | "detected" | "not_detected";

export interface HarnessConnection {
  id: HarnessId;
  name: string;
  description: string;
  icon: {
    src: string;
    fit: "contain" | "cover";
    inset: "none" | "sm";
    invert_in_dark?: boolean;
  };
  documentation_url: string | null;
  source_merge: { model_override: boolean } | null;
  status: HarnessConnectionStatus;
  detected: boolean;
  connected: boolean;
  import_available: boolean;
  hooks_supported: boolean;
  hooks_installed: boolean;
  detail: string;
}

export type OnboardingFeatureId =
  | "observability"
  | "health_recommendations"
  | "autonomous_improvement";

export interface OnboardingPreferences {
  version: 1;
  completed: boolean;
  import_sources: Record<HarnessId, boolean>;
  hook_harnesses: Record<Exclude<HarnessId, "openclaw">, boolean>;
  features: Record<OnboardingFeatureId, boolean>;
}

export interface ApplyOnboardingRequest {
  import_sources: HarnessId[];
  hook_harnesses: Array<Exclude<HarnessId, "openclaw">>;
  features: Record<OnboardingFeatureId, boolean>;
}

export interface OnboardingInstallResult {
  harness_id: Exclude<HarnessId, "openclaw">;
  status: "installed" | "already_installed" | "failed";
  message: string;
}

export interface OnboardingSourceSyncResult {
  status: "processed" | "no_changes" | "failed" | "skipped";
  message: string | null;
}

export type DesktopScheduleFormat = "launchd" | "systemd" | "unsupported";
export type DesktopScheduleJobId = "selftune-sync" | "selftune-status" | "selftune-orchestrate";

export interface DesktopScheduleJob {
  id: DesktopScheduleJobId;
  label: string;
  description: string;
  command: string;
  default_schedule: string;
  schedule: string;
  enabled: boolean;
  active: boolean;
}

export interface DesktopSettingsResponse {
  harnesses: HarnessConnection[];
  onboarding: OnboardingPreferences;
  cloud_account: {
    linked: boolean;
    cloud_user_id: string | null;
    cloud_org_id: string | null;
  };
  remote_library: {
    configured: boolean;
    credential_provider:
      | "environment"
      | "file"
      | "linux-secret-service"
      | "macos-keychain"
      | "windows-credential-manager"
      | null;
    url: string | null;
    preferences: import("@selftune/control-plane").SyncPreferences;
  };
  schedule: {
    supported: boolean;
    format: DesktopScheduleFormat;
    settings_path: string;
    jobs: DesktopScheduleJob[];
  };
}

export interface StartCloudAccountLinkResponse {
  link_id: string;
  verification_url: string;
  user_code: string;
  expires_at: string;
}

export interface CompleteCloudAccountLinkRequest {
  link_id: string;
  preferences: import("@selftune/control-plane").SyncPreferences;
}

export interface CompleteCloudAccountLinkResponse {
  settings: DesktopSettingsResponse;
  first_backup:
    | { status: "completed"; uploaded: number; unchanged: number }
    | { status: "failed"; message: string };
}

export interface ApplyOnboardingResponse extends DesktopSettingsResponse {
  install_results: OnboardingInstallResult[];
  source_sync: OnboardingSourceSyncResult;
}

export interface UpdateDesktopScheduleRequest {
  jobs: Array<Pick<DesktopScheduleJob, "id" | "enabled" | "schedule">>;
}

export interface UpdateRemoteLibraryRequest {
  url: string;
  api_key?: string;
  preferences: import("@selftune/control-plane").SyncPreferences;
}

export type {
  CreateRemoteLibraryShareRequest,
  RemoteLibraryShare,
  RemoteLibraryShareArtifact,
  RemoteLibrarySharesResponse,
  WorkspaceSkillSetPoliciesResponse,
  WorkspaceSkillSetPolicy,
  WorkspaceSkillSetPolicyAction,
  WorkspaceMember,
  WorkspaceMemberRole,
  WorkspaceMembersResponse,
} from "@selftune/library/remote/types";
