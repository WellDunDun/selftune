import { decodeResponse, portfolioRequest, responseError, schemaRequest } from "./dashboard-http";
export { DashboardApiError } from "./dashboard-http";
import { Schema } from "effect";
import { HealthResponse } from "@selftune/runtime/dashboard-contract/health";
import {
  ApplyOnboardingResponse,
  DesktopSettingsResponse,
} from "@selftune/runtime/dashboard-contract/local-management";
import type {
  ApplyOnboardingRequest,
  CompleteCloudAccountLinkRequest,
  CompleteCloudAccountLinkResponse,
  ApplySkillSetRequest,
  AnalyticsResponse,
  DashboardActionName,
  DashboardShellResponse,
  DoctorResult,
  HarnessId,
  LibrarySnapshot,
  SkillSourceUpdatePreview,
  SkillSourceUpdateReceipt,
  SourceMergeDecision,
  StartCloudAccountLinkResponse,
  DesktopBillingCheckoutFinalizeRequest,
  DesktopBillingCheckoutFinalizeResult,
  DesktopBillingCheckoutRequest,
  DesktopBillingSession,
  DesktopBillingStatus,
  OrchestrateRunsResponse,
  OverviewResponse,
  PortfolioResponse,
  CreateSkillSetRequest,
  DeriveSkillSetRequest,
  ExportSkillSetRequest,
  PlanSkillSetRequest,
  PortfolioQuarantineBatchResult,
  QuarantineReceipt,
  RollbackSkillSetRequest,
  SkillSetManifest,
  SkillSetPlan,
  SkillSetReceipt,
  SkillSetRemoteApplyResult,
  SkillIntelligenceReport,
  SkillClassificationOverrideReceipt,
  SkillSetSuggestionReview,
  SkillSetsResponse,
  SkillReportResponse,
  UpdateDesktopScheduleRequest,
  UpdateRemoteLibraryRequest,
  CreateRemoteLibraryShareRequest,
  RemoteLibraryShare,
  RemoteLibrarySharesResponse,
  WorkspaceSkillSetPoliciesResponse,
  WorkspaceSkillSetPolicy,
  WorkspaceSkillSetPolicyAction,
  WorkspaceMemberRole,
  WorkspaceMembersResponse,
  WorkspaceTeamOverview,
  UpdateSkillSetRequest,
  UpdateSkillClassificationRequest,
  ReviewSkillSetSuggestionRequest,
  InsightsResponse,
  ReviewInsightRequest,
  DraftInsightRequest,
  DurableDashboardDecision,
} from "./types";
import type {
  LibraryArchiveInput,
  PluginInventoryModel,
  PluginManagementInputModel,
  PluginManagementReceiptModel,
  ProjectProvisionInput,
  ProjectProvisionPlanModel,
  ProjectProvisionResultModel,
  ProjectSkillSetPluginInstallInput,
  ProjectSkillSetPluginInstallPreviewModel,
  ProjectSkillSetPluginInstallReceiptModel,
} from "@selftune/dashboard-core/models";
import type { SkillSetPackManagementList, SkillSetPackPreview } from "@selftune/control-plane";

const BASE = "";

export async function fetchOverview(): Promise<OverviewResponse> {
  const res = await fetch(`${BASE}/api/v2/overview`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchDashboardShell(): Promise<DashboardShellResponse> {
  const res = await fetch(`${BASE}/api/v2/shell`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchSkillReport(skillName: string): Promise<SkillReportResponse> {
  const res = await fetch(`${BASE}/api/v2/skills/${encodeURIComponent(skillName)}`);
  if (!res.ok) {
    if (res.status === 404) throw new NotFoundError(skillName);
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchOrchestrateRuns(limit = 20): Promise<OrchestrateRunsResponse> {
  const res = await fetch(`${BASE}/api/v2/orchestrate-runs?limit=${limit}`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchAnalytics(): Promise<AnalyticsResponse> {
  const res = await fetch(`${BASE}/api/v2/analytics`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export function fetchRuntimeHealth(): Promise<HealthResponse> {
  return schemaRequest("/api/health", HealthResponse);
}

export async function fetchDoctor(): Promise<DoctorResult> {
  const res = await fetch(`${BASE}/api/v2/doctor`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export function fetchSettings(): Promise<DesktopSettingsResponse> {
  return schemaRequest("/api/v2/settings", DesktopSettingsResponse);
}

export async function fetchPlugins(): Promise<PluginInventoryModel> {
  const res = await fetch(`${BASE}/api/v2/plugins`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export function managePlugin(
  input: PluginManagementInputModel,
): Promise<PluginManagementReceiptModel> {
  return portfolioRequest(
    "/api/v2/plugins/manage",
    JSON.stringify({
      host: input.host,
      plugin_id: input.pluginId,
      action: input.action,
    }),
  );
}

export function startCloudAccountLink(): Promise<StartCloudAccountLinkResponse> {
  return portfolioRequest("/api/v2/settings/cloud-account/link/start", JSON.stringify({}));
}

export function completeCloudAccountLink(
  input: CompleteCloudAccountLinkRequest,
): Promise<CompleteCloudAccountLinkResponse> {
  return portfolioRequest("/api/v2/settings/cloud-account/link/complete", JSON.stringify(input));
}

export function fetchCloudBillingStatus(): Promise<DesktopBillingStatus> {
  return portfolioRequest("/api/v2/settings/billing/status");
}

export function createCloudBillingCheckout(
  input: DesktopBillingCheckoutRequest,
): Promise<DesktopBillingSession> {
  return portfolioRequest("/api/v2/settings/billing/checkout", JSON.stringify(input));
}

export function createCloudBillingPortal(): Promise<DesktopBillingSession> {
  return portfolioRequest("/api/v2/settings/billing/portal", JSON.stringify({}));
}

export function finalizeCloudBillingCheckout(
  input: DesktopBillingCheckoutFinalizeRequest,
): Promise<DesktopBillingCheckoutFinalizeResult> {
  return portfolioRequest(
    "/api/v2/settings/billing/checkout/finalize",
    JSON.stringify({
      session_id: input.sessionId,
    }),
  );
}

export async function fetchLibrary(): Promise<LibrarySnapshot> {
  const res = await fetch(`${BASE}/api/v2/library`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export function backupLibrarySkill(skillId: string): Promise<{
  uploaded: number;
  unchanged: number;
  snapshot: { snapshotId: string };
}> {
  return portfolioRequest("/api/v2/library/backup", JSON.stringify({ skill_id: skillId }));
}

export function shareLibrarySkill(
  input:
    | {
        skillId: string;
        mode: "reusable_unlisted" | "private_single_claim";
        delivery: "copy_link";
      }
    | {
        skillId: string;
        mode: "private_single_claim";
        delivery: "email";
        recipientEmail: string;
      },
): Promise<{
  shareId: string;
  mode: "reusable_unlisted" | "private_single_claim";
  delivery: "copy_link" | "email";
  shareUrl: string | null;
  expiresAt: string;
}> {
  return portfolioRequest(
    "/api/v2/library/share",
    JSON.stringify(
      input.delivery === "email"
        ? {
            skill_id: input.skillId,
            mode: input.mode,
            delivery: input.delivery,
            recipient_email: input.recipientEmail,
          }
        : { skill_id: input.skillId, mode: input.mode, delivery: input.delivery },
    ),
  );
}

export interface LicenseDraftTermsInput {
  copyrightHolder: string;
  licensedOrganization: string;
  year: number;
}

export interface LicenseDraftPreviewResponse {
  previewId: string;
  skillPath: string;
  licenseExpression: string;
  files: Array<{ path: "SKILL.md" | "LICENSE"; patch: string }>;
}

function licenseDraftRequest(
  path: "/api/v2/library/license/preview" | "/api/v2/library/license/apply",
  input: {
    skillId: string;
    skillSetId?: string;
    terms: LicenseDraftTermsInput;
    previewId?: string;
  },
): Promise<LicenseDraftPreviewResponse> {
  return portfolioRequest(
    path,
    JSON.stringify({
      skill_id: input.skillId,
      set_id: input.skillSetId || undefined,
      preview_id: input.previewId || undefined,
      terms: {
        copyright_holder: input.terms.copyrightHolder,
        licensed_organization: input.terms.licensedOrganization,
        year: input.terms.year,
      },
    }),
  );
}

export function previewLibrarySkillLicense(input: {
  skillId: string;
  skillSetId?: string;
  terms: LicenseDraftTermsInput;
}): Promise<LicenseDraftPreviewResponse> {
  return licenseDraftRequest("/api/v2/library/license/preview", input);
}

export function applyLibrarySkillLicense(input: {
  skillId: string;
  skillSetId?: string;
  previewId: string;
  terms: LicenseDraftTermsInput;
}): Promise<LicenseDraftPreviewResponse> {
  return licenseDraftRequest("/api/v2/library/license/apply", input);
}

export function installLibrarySkill(input: {
  skillId: string;
  targetAgent: "codex" | "claude_code" | "opencode" | "openclaw" | "pi";
}): Promise<{
  skillId: string;
  targetAgent: typeof input.targetAgent;
  targetPath: string;
}> {
  return portfolioRequest(
    "/api/v2/library/install",
    JSON.stringify({
      skill_id: input.skillId,
      target_agent: input.targetAgent,
    }),
  );
}

export function previewSkillSourceUpdate(skillName: string): Promise<SkillSourceUpdatePreview> {
  return portfolioRequest<SkillSourceUpdatePreview>(
    "/api/v2/library/source-update/preview",
    JSON.stringify({
      skill_name: skillName,
    }),
  );
}

export function applySkillSourceUpdate(input: {
  skillName: string;
  strategy: "abort" | "take_upstream";
}): Promise<SkillSourceUpdateReceipt> {
  return portfolioRequest<SkillSourceUpdateReceipt>(
    "/api/v2/library/source-update/apply",
    JSON.stringify({
      skill_name: input.skillName,
      strategy: input.strategy,
    }),
  );
}

export function prepareSkillSourceMerge(input: {
  skillName: string;
  harnessId: HarnessId;
  model?: string | null;
}): Promise<SourceMergeDecision> {
  return portfolioRequest<SourceMergeDecision>(
    "/api/v2/library/source-update/merge/prepare",
    JSON.stringify({
      skill_name: input.skillName,
      harness_id: input.harnessId,
      model: input.model ?? null,
    }),
  );
}

export function applySkillSourceMerge(mergeId: string): Promise<SkillSourceUpdateReceipt> {
  return portfolioRequest<SourceMergeDecision>(
    `/api/v2/decisions/${encodeURIComponent(mergeId)}/approve`,
    JSON.stringify({}),
  ).then((decision) => {
    if (decision.status === "approved" && decision.receipt) return decision.receipt;
    throw new Error(
      decision.failure?.message ?? `The merge decision finished as ${decision.status}.`,
    );
  });
}

export function updateScheduleSettings(
  input: UpdateDesktopScheduleRequest,
): Promise<DesktopSettingsResponse> {
  return schemaRequest("/api/v2/settings/schedule", DesktopSettingsResponse, JSON.stringify(input));
}

export function updateRemoteLibrarySettings(
  input: UpdateRemoteLibraryRequest,
): Promise<DesktopSettingsResponse> {
  return schemaRequest(
    "/api/v2/settings/remote-library",
    DesktopSettingsResponse,
    JSON.stringify(input),
  );
}

export function previewRemoteLibrary(input: {
  preferences: UpdateRemoteLibraryRequest["preferences"];
}): Promise<{
  artifacts: Array<{
    artifactId: string;
    artifactType: string;
    objectHash: string;
    bytes: number;
    preview: unknown;
  }>;
  totalBytes: number;
}> {
  return portfolioRequest("/api/v2/settings/remote-library/preview", JSON.stringify(input));
}

export interface RemoteLibraryStatus {
  url: string;
  head: {
    snapshotId: string;
    createdAt: string;
    artifacts: Array<{
      artifactId: string;
      artifactType: string;
      objectHash: string;
      revisionHash: string | null;
      updatedAt: string;
    }>;
  } | null;
  diagnostics: {
    objectCount: number;
    snapshotCount: number;
    totalBytes: number;
    missingObjects: string[];
    orphanedObjects: string[];
  };
}

export function fetchRemoteLibraryStatus(): Promise<RemoteLibraryStatus> {
  return portfolioRequest("/api/v2/settings/remote-library/status");
}

export function syncRemoteLibraryNow(): Promise<{
  snapshot: { snapshotId: string; artifacts: unknown[] };
  uploaded: number;
  unchanged: number;
}> {
  return portfolioRequest("/api/v2/settings/remote-library/sync", JSON.stringify({}));
}

export function exportRemoteLibraryNow(): Promise<{ outputPath: string }> {
  return portfolioRequest("/api/v2/settings/remote-library/export", JSON.stringify({}));
}

export function restoreRemoteLibraryNow(): Promise<{
  targetRoot: string;
  restored: number;
}> {
  return portfolioRequest("/api/v2/settings/remote-library/restore", JSON.stringify({}));
}

export function fetchRemoteLibraryShares(): Promise<RemoteLibrarySharesResponse> {
  return portfolioRequest("/api/v2/settings/remote-library/shares");
}

export function createPrivateRemoteLibraryShare(
  input: CreateRemoteLibraryShareRequest,
): Promise<RemoteLibraryShare> {
  return portfolioRequest("/api/v2/settings/remote-library/shares", JSON.stringify(input));
}

export function actOnPrivateRemoteLibraryShare(input: {
  shareId: string;
  action: "accept" | "import" | "revoke";
}): Promise<RemoteLibraryShare> {
  return portfolioRequest(
    `/api/v2/settings/remote-library/shares/${encodeURIComponent(input.shareId)}/${input.action}`,
    JSON.stringify({}),
  );
}

export function fetchWorkspaceSkillSetPolicies(): Promise<WorkspaceSkillSetPoliciesResponse> {
  return portfolioRequest("/api/v2/settings/workspace/policies");
}

export function updateWorkspaceSkillSetPolicy(input: {
  skillSetId: string;
  action: WorkspaceSkillSetPolicyAction;
  reason?: string | null;
}): Promise<WorkspaceSkillSetPolicy> {
  return portfolioRequest(
    `/api/v2/settings/workspace/policies/${encodeURIComponent(input.skillSetId)}`,
    JSON.stringify({ action: input.action, reason: input.reason }),
  );
}

export function resetWorkspaceSkillSetPolicy(input: {
  skillSetId: string;
}): Promise<{ success: true }> {
  return portfolioRequest(
    `/api/v2/settings/workspace/policies/${encodeURIComponent(input.skillSetId)}/reset`,
    JSON.stringify({}),
  );
}

export function fetchWorkspaceMembers(): Promise<WorkspaceMembersResponse> {
  return portfolioRequest("/api/v2/settings/workspace/members");
}

export function fetchWorkspaceTeamOverview(): Promise<WorkspaceTeamOverview> {
  return portfolioRequest("/api/v2/team");
}

export function inviteWorkspaceMember(input: {
  email: string;
  role: WorkspaceMemberRole;
}): Promise<{ status: "invited" | "joined" }> {
  return portfolioRequest("/api/v2/settings/workspace/invite", JSON.stringify(input));
}

export function updateWorkspaceMemberRole(input: {
  userId: string;
  role: WorkspaceMemberRole;
}): Promise<{ success: true }> {
  return portfolioRequest(
    `/api/v2/settings/workspace/members/${encodeURIComponent(input.userId)}/role`,
    JSON.stringify({ role: input.role }),
  );
}

export function removeWorkspaceMember(input: { userId: string }): Promise<{ success: true }> {
  return portfolioRequest(
    `/api/v2/settings/workspace/members/${encodeURIComponent(input.userId)}/remove`,
    JSON.stringify({}),
  );
}

export function applyOnboarding(input: ApplyOnboardingRequest): Promise<ApplyOnboardingResponse> {
  return schemaRequest(
    "/api/v2/settings/onboarding",
    ApplyOnboardingResponse,
    JSON.stringify(input),
  );
}

export function fetchPortfolio(): Promise<PortfolioResponse> {
  return portfolioRequest<PortfolioResponse>("/api/v2/portfolio");
}

export function fetchInsights(): Promise<InsightsResponse> {
  return portfolioRequest<InsightsResponse>("/api/v2/insights");
}

export function reviewInsight(input: ReviewInsightRequest) {
  return portfolioRequest<InsightsResponse["snapshot"]["candidates"][number]>(
    "/api/v2/insights/review",
    JSON.stringify(input),
  );
}

export function draftInsight(
  input: DraftInsightRequest,
): Promise<{ draft: { skill_dir: string } }> {
  return portfolioRequest<{ draft: { skill_dir: string } }>(
    "/api/v2/insights/draft",
    JSON.stringify(input),
  );
}

export function evaluateInsight(input: { candidate_id: string }): Promise<{
  recommended: boolean;
  blockers: string[];
}> {
  return portfolioRequest("/api/v2/insights/evaluate", JSON.stringify(input));
}

export function releaseInsight(input: { candidate_id: string }): Promise<{
  package_path: string;
}> {
  return portfolioRequest("/api/v2/insights/release", JSON.stringify(input));
}

export function quarantinePortfolioSkill(input: {
  skillName: string;
  skillPath: string;
  confirm?: boolean;
}): Promise<QuarantineReceipt> {
  return portfolioRequest<QuarantineReceipt>(
    "/api/v2/portfolio/quarantine",
    JSON.stringify({
      skill_name: input.skillName,
      skill_path: input.skillPath,
      confirm: input.confirm ?? true,
    }),
  );
}

export function quarantinePortfolioSkills(
  inputs: readonly (LibraryArchiveInput & { keepSearchable?: boolean })[],
): Promise<PortfolioQuarantineBatchResult> {
  return portfolioRequest<PortfolioQuarantineBatchResult>(
    "/api/v2/portfolio/quarantine-batch",
    JSON.stringify({
      skills: inputs.map((input) => ({
        skill_name: input.skillName,
        skill_path: input.skillPath,
        keep_searchable: input.keepSearchable,
        expected_content_hash: input.expectedContentHash,
      })),
    }),
  );
}

export function previewQuarantinePortfolioSkill(input: {
  skillName: string;
  skillPath: string;
}): Promise<QuarantineReceipt> {
  return quarantinePortfolioSkill({ ...input, confirm: false });
}

export function restorePortfolioSkill(quarantineId: string): Promise<QuarantineReceipt> {
  return portfolioRequest<QuarantineReceipt>(
    "/api/v2/portfolio/restore",
    JSON.stringify({
      quarantine_id: quarantineId,
    }),
  );
}

export function fetchDurableDecisions(): Promise<{
  decisions: DurableDashboardDecision[];
}> {
  return portfolioRequest("/api/v2/decisions");
}

export function prepareSkillRemovalDecision(input: {
  skillName: string;
  locations: Array<{ skillPath: string; connection: string | null }>;
}): Promise<DurableDashboardDecision> {
  return portfolioRequest(
    "/api/v2/decisions/removals",
    JSON.stringify({
      skill_name: input.skillName,
      locations: input.locations.map((location) => ({
        skill_path: location.skillPath,
        connection: location.connection,
      })),
    }),
  );
}

export function prepareSkillConsolidationDecision(input: {
  skillName: string;
  canonicalSkillPath: string;
  targetSkillPaths: string[];
}): Promise<DurableDashboardDecision> {
  return portfolioRequest(
    "/api/v2/decisions/consolidations",
    JSON.stringify({
      skill_name: input.skillName,
      canonical_skill_path: input.canonicalSkillPath,
      target_skill_paths: input.targetSkillPaths,
    }),
  );
}

export function prepareProjectConflictDecision(input: {
  skillSetId: string;
  projectRoot: string;
}): Promise<DurableDashboardDecision> {
  return portfolioRequest(
    "/api/v2/decisions/skill-set-conflicts",
    JSON.stringify({
      set_id: input.skillSetId,
      project_root: input.projectRoot,
    }),
  );
}

export function decideDurableDecision(input: {
  decisionId: string;
  action: "approve" | "decline";
}): Promise<DurableDashboardDecision> {
  return portfolioRequest(
    `/api/v2/decisions/${encodeURIComponent(input.decisionId)}/${input.action}`,
    JSON.stringify({}),
  );
}

export function rollbackDurableDecision(decisionId: string): Promise<DurableDashboardDecision> {
  return portfolioRequest(
    `/api/v2/decisions/${encodeURIComponent(decisionId)}/rollback`,
    JSON.stringify({}),
  );
}

export function fetchSkillSets(): Promise<SkillSetsResponse> {
  return portfolioRequest<SkillSetsResponse>("/api/v2/skill-sets");
}

export function fetchSkillIntelligence(): Promise<SkillIntelligenceReport> {
  return portfolioRequest<SkillIntelligenceReport>("/api/v2/skill-intelligence");
}

export interface LocalTraceCandidateReview {
  draft_id: string | null;
  pattern_id: string;
  cohort_fingerprint: string | null;
  target_revision: string | null;
  readiness: "review_ready" | "not_ready";
  failure_reason: string | null;
  evidence: { cohort_entries: number; resolved_entries: number };
  candidate: {
    body: string;
    rationale: string;
    diff: { changed_lines: number; target_section: string };
    uncertainty: string[];
  } | null;
}
export function prepareTraceCandidate(pattern_id: string): Promise<LocalTraceCandidateReview> {
  return portfolioRequest<LocalTraceCandidateReview>(
    "/api/v2/trace-candidates/prepare",
    JSON.stringify({
      pattern_id,
    }),
  );
}

export function updateSkillClassification(
  input: UpdateSkillClassificationRequest,
): Promise<SkillClassificationOverrideReceipt> {
  return portfolioRequest<SkillClassificationOverrideReceipt>(
    "/api/v2/skill-intelligence/classification",
    JSON.stringify(input),
  );
}

export function reviewSkillSetSuggestion(
  input: ReviewSkillSetSuggestionRequest,
): Promise<SkillSetSuggestionReview> {
  return portfolioRequest<SkillSetSuggestionReview>(
    "/api/v2/skill-intelligence/suggestions/review",
    JSON.stringify(input),
  );
}

export function createProjectSkillSet(input: CreateSkillSetRequest): Promise<SkillSetManifest> {
  return portfolioRequest<SkillSetManifest>("/api/v2/skill-sets", JSON.stringify(input));
}

export function updateProjectSkillSet(input: UpdateSkillSetRequest): Promise<SkillSetManifest> {
  return portfolioRequest<SkillSetManifest>("/api/v2/skill-sets/update", JSON.stringify(input));
}

export async function deleteProjectSkillSet(setId: string): Promise<void> {
  const response = await fetch(`${BASE}/api/v2/skill-sets/${encodeURIComponent(setId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `API error: ${response.status} ${response.statusText}`);
  }
}

export function deriveProjectSkillSet(input: DeriveSkillSetRequest): Promise<SkillSetManifest> {
  return portfolioRequest<SkillSetManifest>("/api/v2/skill-sets/derive", JSON.stringify(input));
}

export function exportProjectSkillSet(
  input: ExportSkillSetRequest,
): Promise<{ output_path: string }> {
  return portfolioRequest<{ output_path: string }>(
    "/api/v2/skill-sets/export",
    JSON.stringify(input),
  );
}

export type LocalPluginExportTarget = "claude" | "openai" | "agent-plugins-v1" | "dual" | "all";

export function exportProjectSkillSetPlugin(input: {
  set_id: string;
  target: LocalPluginExportTarget;
}): Promise<{ filename: string; content_base64: string }> {
  return portfolioRequest("/api/v2/skill-sets/plugin-export", JSON.stringify(input));
}

export function previewProjectSkillSetPluginInstall(
  skillSetId: string,
): Promise<ProjectSkillSetPluginInstallPreviewModel> {
  return portfolioRequest(
    "/api/v2/skill-sets/plugin-install/preview",
    JSON.stringify({
      set_id: skillSetId,
    }),
  );
}

export function installProjectSkillSetPlugin(
  input: ProjectSkillSetPluginInstallInput,
): Promise<ProjectSkillSetPluginInstallReceiptModel> {
  return portfolioRequest(
    "/api/v2/skill-sets/plugin-install",
    JSON.stringify({
      set_id: input.skillSetId,
      expected_revision_hash: input.expectedRevisionHash,
      hosts: input.hosts,
    }),
  );
}

export function previewProjectSkillSetPack(packUrl: string): Promise<{
  packUrl: string;
  preview: SkillSetPackPreview;
}> {
  return portfolioRequest(
    "/api/v2/skill-sets/packs/preview",
    JSON.stringify({ pack_url: packUrl }),
  );
}

export function importProjectSkillSetPack(input: {
  packUrl: string;
  expectedObjectSha256: string;
}): Promise<{
  manifest: SkillSetManifest;
  sourceRevisionSha256: string;
  objectSha256: string;
}> {
  return portfolioRequest(
    "/api/v2/skill-sets/packs/import",
    JSON.stringify({
      pack_url: input.packUrl,
      expected_object_sha256: input.expectedObjectSha256,
    }),
  );
}

export function fetchProjectSkillSetPacks(): Promise<SkillSetPackManagementList> {
  return portfolioRequest("/api/v2/skill-sets/packs");
}

export async function revokeProjectSkillSetPack(packId: string): Promise<void> {
  const response = await fetch(`${BASE}/api/v2/skill-sets/packs/${encodeURIComponent(packId)}`, {
    method: "DELETE",
  });
  if (response.ok) return;
  throw responseError(response, await response.text());
}

export function shareProjectSkillSet(input: {
  skillSetId: string;
  mode: "reusable_unlisted" | "private_single_claim";
  delivery: "copy_link" | "email";
  recipientEmail?: string;
}): Promise<{
  shareId: string;
  mode: "reusable_unlisted" | "private_single_claim";
  delivery: "copy_link" | "email";
  shareUrl: string | null;
  expiresAt: string;
}> {
  return portfolioRequest(
    "/api/v2/skill-sets/share",
    JSON.stringify({
      set_id: input.skillSetId,
      mode: input.mode,
      delivery: input.delivery,
      recipient_email: input.recipientEmail || undefined,
    }),
  );
}

export function previewProjectSkillSet(input: PlanSkillSetRequest): Promise<SkillSetPlan> {
  return portfolioRequest<SkillSetPlan>("/api/v2/skill-sets/plan", JSON.stringify(input));
}

export function applyProjectSkillSet(
  input: ApplySkillSetRequest,
): Promise<SkillSetRemoteApplyResult> {
  return portfolioRequest<SkillSetRemoteApplyResult>(
    "/api/v2/skill-sets/apply",
    JSON.stringify(input),
  );
}

export function previewProjectProvision(
  input: ProjectProvisionInput,
): Promise<ProjectProvisionPlanModel> {
  return portfolioRequest<ProjectProvisionPlanModel>(
    "/api/v2/skill-sets/project-plan",
    JSON.stringify({
      project_root: input.projectRoot,
      set_ids: input.skillSetIds,
      harnesses: input.harnesses,
    }),
  );
}

export function applyProjectProvision(
  input: ProjectProvisionInput,
): Promise<ProjectProvisionResultModel> {
  return portfolioRequest<{ project_root: string; receipt_count: number }>(
    "/api/v2/skill-sets/project-apply",
    JSON.stringify({
      project_root: input.projectRoot,
      set_ids: input.skillSetIds,
      harnesses: input.harnesses,
      create_react_project: input.createReactProject,
    }),
  ).then((result) => ({
    projectRoot: result.project_root,
    receiptCount: result.receipt_count,
  }));
}

export function rollbackProjectSkillSet(input: RollbackSkillSetRequest): Promise<SkillSetReceipt> {
  return portfolioRequest<SkillSetReceipt>("/api/v2/skill-sets/rollback", JSON.stringify(input));
}

export interface DashboardActionRequest {
  skill: string;
  skillPath: string;
  proposalId?: string;
  autoSynthetic?: boolean;
}

export const DashboardActionResponse = Schema.Struct({
  success: Schema.Boolean,
  output: Schema.String,
  error: Schema.NullOr(Schema.String),
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export type DashboardActionResponse = typeof DashboardActionResponse.Type;

export async function runDashboardAction(
  action: DashboardActionName,
  payload: DashboardActionRequest,
): Promise<DashboardActionResponse> {
  const res = await fetch(`${BASE}/api/actions/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const responseText = await res.text();
  if (!res.ok) throw responseError(res, responseText);
  return decodeResponse(res, responseText, DashboardActionResponse);
}

export class NotFoundError extends Error {
  constructor(skillName: string) {
    super(`Skill "${skillName}" not found`);
    this.name = "NotFoundError";
  }
}
