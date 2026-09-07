import { Schema } from "effect";
import { SyncPreferences } from "@selftune/control-plane";

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

export const QuarantineRecord = Schema.Struct({
  schema_version: Schema.Literal(1),
  quarantine_id: Schema.String,
  status: Schema.Literals(["preparing", "quarantined", "restoring", "restored"]),
  skill_name: Schema.String,
  skill_scope: Schema.Literals(["project", "global", "admin", "system", "unknown"]),
  original_package_path: Schema.String,
  original_skill_path: Schema.String,
  quarantined_package_path: Schema.String,
  package_version_hash: Schema.NullOr(Schema.String),
  quarantined_at: Schema.String,
  restored_at: Schema.NullOr(Schema.String),
});
export type QuarantineRecord = typeof QuarantineRecord.Type;

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

export const HarnessConnection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  icon: Schema.Struct({
    src: Schema.String,
    fit: Schema.Literals(["contain", "cover"]),
    inset: Schema.Literals(["none", "sm"]),
    invert_in_dark: Schema.optionalKey(Schema.Boolean),
  }),
  documentation_url: Schema.NullOr(Schema.String),
  source_merge: Schema.NullOr(Schema.Struct({ model_override: Schema.Boolean })),
  status: Schema.Literals(["connected", "detected", "not_detected"]),
  detected: Schema.Boolean,
  connected: Schema.Boolean,
  import_available: Schema.Boolean,
  hooks_supported: Schema.Boolean,
  hooks_installed: Schema.Boolean,
  detail: Schema.String,
});
export type HarnessConnection = typeof HarnessConnection.Type;

export type OnboardingFeatureId =
  | "observability"
  | "health_recommendations"
  | "autonomous_improvement";

export const OnboardingPreferences = Schema.Struct({
  version: Schema.Literal(1),
  completed: Schema.mutableKey(Schema.Boolean),
  import_sources: Schema.Record(Schema.String, Schema.mutableKey(Schema.Boolean)),
  hook_harnesses: Schema.Record(Schema.String, Schema.mutableKey(Schema.Boolean)),
  features: Schema.Struct({
    observability: Schema.mutableKey(Schema.Boolean),
    health_recommendations: Schema.mutableKey(Schema.Boolean),
    autonomous_improvement: Schema.mutableKey(Schema.Boolean),
  }),
});
export type OnboardingPreferences = typeof OnboardingPreferences.Type;

export interface ApplyOnboardingRequest {
  import_sources: HarnessId[];
  hook_harnesses: Array<Exclude<HarnessId, "openclaw">>;
  features: Record<OnboardingFeatureId, boolean>;
}

export const OnboardingInstallResult = Schema.Struct({
  harness_id: Schema.String,
  status: Schema.Literals(["installed", "already_installed", "failed"]),
  message: Schema.String,
});
export type OnboardingInstallResult = typeof OnboardingInstallResult.Type;

export const OnboardingSourceSyncResult = Schema.Struct({
  status: Schema.Literals(["processed", "no_changes", "failed", "skipped"]),
  message: Schema.NullOr(Schema.String),
});
export type OnboardingSourceSyncResult = typeof OnboardingSourceSyncResult.Type;

export type DesktopScheduleFormat = "launchd" | "systemd" | "unsupported";
export type DesktopScheduleJobId = "selftune-sync" | "selftune-status" | "selftune-orchestrate";

export const DesktopScheduleJob = Schema.Struct({
  id: Schema.Literals(["selftune-sync", "selftune-status", "selftune-orchestrate"]),
  label: Schema.String,
  description: Schema.String,
  command: Schema.String,
  default_schedule: Schema.String,
  schedule: Schema.String,
  enabled: Schema.Boolean,
  active: Schema.Boolean,
});
export type DesktopScheduleJob = typeof DesktopScheduleJob.Type;

export const DesktopSettingsResponse = Schema.Struct({
  harnesses: Schema.mutable(Schema.Array(HarnessConnection)),
  agent_skill: Schema.Struct({
    installed: Schema.Boolean,
    locations: Schema.mutable(Schema.Array(Schema.String)),
    install_command: Schema.String,
  }),
  onboarding: OnboardingPreferences,
  cloud_account: Schema.Struct({
    linked: Schema.Boolean,
    cloud_user_id: Schema.NullOr(Schema.String),
    cloud_org_id: Schema.NullOr(Schema.String),
  }),
  remote_library: Schema.Struct({
    configured: Schema.Boolean,
    credential_provider: Schema.NullOr(
      Schema.Literals([
        "environment",
        "file",
        "linux-secret-service",
        "macos-keychain",
        "windows-credential-manager",
      ]),
    ),
    url: Schema.NullOr(Schema.String),
    preferences: SyncPreferences,
  }),
  schedule: Schema.Struct({
    supported: Schema.Boolean,
    format: Schema.Literals(["launchd", "systemd", "unsupported"]),
    settings_path: Schema.String,
    jobs: Schema.mutable(Schema.Array(DesktopScheduleJob)),
  }),
});
export type DesktopSettingsResponse = typeof DesktopSettingsResponse.Type;

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

export const ApplyOnboardingResponse = Schema.Struct({
  ...DesktopSettingsResponse.fields,
  install_results: Schema.mutable(Schema.Array(OnboardingInstallResult)),
  source_sync: OnboardingSourceSyncResult,
});
export type ApplyOnboardingResponse = typeof ApplyOnboardingResponse.Type;

export const UpdateDesktopScheduleRequest = Schema.Struct({
  jobs: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        id: DesktopScheduleJob.fields.id,
        enabled: Schema.Boolean,
        schedule: Schema.String,
      }),
    ),
  ),
});
export type UpdateDesktopScheduleRequest = typeof UpdateDesktopScheduleRequest.Type;

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
  WorkspaceTeamOverview,
} from "@selftune/library/remote/types";
