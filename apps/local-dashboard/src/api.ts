import type {
  ApplyOnboardingRequest,
  ApplyOnboardingResponse,
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
  DesktopSettingsResponse,
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
  UpdateSkillSetRequest,
  UpdateSkillClassificationRequest,
  ReviewSkillSetSuggestionRequest,
  InsightsResponse,
  ReviewInsightRequest,
  DraftInsightRequest,
  DurableDashboardDecision,
} from "./types";
import type {
  ProjectProvisionInput,
  ProjectProvisionPlanModel,
  ProjectProvisionResultModel,
} from "@selftune/dashboard-core/models";

const BASE = "";

export class DashboardApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly suggestion: string | null,
    public readonly retryable: boolean,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DashboardApiError";
  }
}

export interface CloudEvaluationSubmissionReceipt {
  readonly run_id: string;
  readonly status: string;
  readonly dispatch: "scheduled";
}

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

export async function fetchDoctor(): Promise<DoctorResult> {
  const res = await fetch(`${BASE}/api/v2/doctor`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchSettings(): Promise<DesktopSettingsResponse> {
  const res = await fetch(`${BASE}/api/v2/settings`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export function startCloudAccountLink(): Promise<StartCloudAccountLinkResponse> {
  return portfolioRequest("/api/v2/settings/cloud-account/link/start", {});
}

export function completeCloudAccountLink(
  input: CompleteCloudAccountLinkRequest,
): Promise<CompleteCloudAccountLinkResponse> {
  return portfolioRequest("/api/v2/settings/cloud-account/link/complete", input);
}

export function fetchCloudBillingStatus(): Promise<DesktopBillingStatus> {
  return portfolioRequest("/api/v2/settings/billing/status");
}

export function createCloudBillingCheckout(
  input: DesktopBillingCheckoutRequest,
): Promise<DesktopBillingSession> {
  return portfolioRequest("/api/v2/settings/billing/checkout", input);
}

export function createCloudBillingPortal(): Promise<DesktopBillingSession> {
  return portfolioRequest("/api/v2/settings/billing/portal", {});
}

export function finalizeCloudBillingCheckout(
  input: DesktopBillingCheckoutFinalizeRequest,
): Promise<DesktopBillingCheckoutFinalizeResult> {
  return portfolioRequest("/api/v2/settings/billing/checkout/finalize", {
    session_id: input.sessionId,
  });
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
  return portfolioRequest("/api/v2/library/backup", { skill_id: skillId });
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
    input.delivery === "email"
      ? {
          skill_id: input.skillId,
          mode: input.mode,
          delivery: input.delivery,
          recipient_email: input.recipientEmail,
        }
      : { skill_id: input.skillId, mode: input.mode, delivery: input.delivery },
  );
}

export function installLibrarySkill(input: {
  skillId: string;
  targetAgent: "codex" | "claude_code" | "opencode" | "openclaw" | "pi";
}): Promise<{
  skillId: string;
  targetAgent: typeof input.targetAgent;
  targetPath: string;
}> {
  return portfolioRequest("/api/v2/library/install", {
    skill_id: input.skillId,
    target_agent: input.targetAgent,
  });
}

export function previewSkillSourceUpdate(skillName: string): Promise<SkillSourceUpdatePreview> {
  return portfolioRequest<SkillSourceUpdatePreview>("/api/v2/library/source-update/preview", {
    skill_name: skillName,
  });
}

export function applySkillSourceUpdate(input: {
  skillName: string;
  strategy: "abort" | "take_upstream";
}): Promise<SkillSourceUpdateReceipt> {
  return portfolioRequest<SkillSourceUpdateReceipt>("/api/v2/library/source-update/apply", {
    skill_name: input.skillName,
    strategy: input.strategy,
  });
}

export function prepareSkillSourceMerge(input: {
  skillName: string;
  harnessId: HarnessId;
  model?: string | null;
}): Promise<SourceMergeDecision> {
  return portfolioRequest<SourceMergeDecision>("/api/v2/library/source-update/merge/prepare", {
    skill_name: input.skillName,
    harness_id: input.harnessId,
    model: input.model ?? null,
  });
}

export function applySkillSourceMerge(mergeId: string): Promise<SkillSourceUpdateReceipt> {
  return portfolioRequest<SourceMergeDecision>(
    `/api/v2/decisions/${encodeURIComponent(mergeId)}/approve`,
    {},
  ).then((decision) => {
    if (decision.status === "approved" && decision.receipt) return decision.receipt;
    throw new Error(
      decision.failure?.message ?? `The merge decision finished as ${decision.status}.`,
    );
  });
}

export async function updateScheduleSettings(
  input: UpdateDesktopScheduleRequest,
): Promise<DesktopSettingsResponse> {
  const res = await fetch(`${BASE}/api/v2/settings/schedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as DesktopSettingsResponse & {
    error?: { message?: string } | string;
  };
  if (!res.ok) {
    const message =
      typeof data.error === "string"
        ? data.error
        : (data.error?.message ?? `API error: ${res.status}`);
    throw new Error(message);
  }
  return data;
}

export async function updateRemoteLibrarySettings(
  input: UpdateRemoteLibraryRequest,
): Promise<DesktopSettingsResponse> {
  const res = await fetch(`${BASE}/api/v2/settings/remote-library`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as DesktopSettingsResponse & {
    error?: { message?: string } | string;
  };
  if (!res.ok) {
    const message =
      typeof data.error === "string"
        ? data.error
        : (data.error?.message ?? `API error: ${res.status}`);
    throw new Error(message);
  }
  return data;
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
  return portfolioRequest("/api/v2/settings/remote-library/preview", input);
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
  return portfolioRequest("/api/v2/settings/remote-library/sync", {});
}

export function exportRemoteLibraryNow(): Promise<{ outputPath: string }> {
  return portfolioRequest("/api/v2/settings/remote-library/export", {});
}

export function restoreRemoteLibraryNow(): Promise<{
  targetRoot: string;
  restored: number;
}> {
  return portfolioRequest("/api/v2/settings/remote-library/restore", {});
}

export function fetchRemoteLibraryShares(): Promise<RemoteLibrarySharesResponse> {
  return portfolioRequest("/api/v2/settings/remote-library/shares");
}

export function createPrivateRemoteLibraryShare(
  input: CreateRemoteLibraryShareRequest,
): Promise<RemoteLibraryShare> {
  return portfolioRequest("/api/v2/settings/remote-library/shares", input);
}

export function actOnPrivateRemoteLibraryShare(input: {
  shareId: string;
  action: "accept" | "import" | "revoke";
}): Promise<RemoteLibraryShare> {
  return portfolioRequest(
    `/api/v2/settings/remote-library/shares/${encodeURIComponent(input.shareId)}/${input.action}`,
    {},
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
    { action: input.action, reason: input.reason },
  );
}

export function resetWorkspaceSkillSetPolicy(input: {
  skillSetId: string;
}): Promise<{ success: true }> {
  return portfolioRequest(
    `/api/v2/settings/workspace/policies/${encodeURIComponent(input.skillSetId)}/reset`,
    {},
  );
}

export function fetchWorkspaceMembers(): Promise<WorkspaceMembersResponse> {
  return portfolioRequest("/api/v2/settings/workspace/members");
}

export function inviteWorkspaceMember(input: {
  email: string;
  role: WorkspaceMemberRole;
}): Promise<{ status: "invited" | "joined" }> {
  return portfolioRequest("/api/v2/settings/workspace/invite", input);
}

export function updateWorkspaceMemberRole(input: {
  userId: string;
  role: WorkspaceMemberRole;
}): Promise<{ success: true }> {
  return portfolioRequest(
    `/api/v2/settings/workspace/members/${encodeURIComponent(input.userId)}/role`,
    { role: input.role },
  );
}

export function removeWorkspaceMember(input: { userId: string }): Promise<{ success: true }> {
  return portfolioRequest(
    `/api/v2/settings/workspace/members/${encodeURIComponent(input.userId)}/remove`,
    {},
  );
}

export async function applyOnboarding(
  input: ApplyOnboardingRequest,
): Promise<ApplyOnboardingResponse> {
  const res = await fetch(`${BASE}/api/v2/settings/onboarding`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as ApplyOnboardingResponse & {
    error?: { message?: string } | string;
  };
  if (!res.ok) {
    const message =
      typeof data.error === "string"
        ? data.error
        : (data.error?.message ?? `API error: ${res.status}`);
    throw new Error(message);
  }
  return data;
}

async function portfolioRequest<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const responseText = await res.text();
  let data: T & {
    error?:
      | {
          code?: string;
          message?: string;
          suggestion?: string;
          retryable?: boolean;
        }
      | string;
  };
  try {
    data = JSON.parse(responseText);
  } catch {
    if (res.status === 404 && responseText.trim() === "Not Found") {
      throw new DashboardApiError(
        "ROUTE_NOT_FOUND",
        "The Desktop service is out of date. Restart SelfTune Desktop and try again.",
        "Restart SelfTune Desktop to load the updated local service.",
        false,
        res.status,
      );
    }
    throw new DashboardApiError(
      "INVALID_RESPONSE",
      res.ok
        ? "The local Desktop service returned an invalid response."
        : `API error: ${res.status} ${res.statusText}`.trim(),
      null,
      res.ok || res.status >= 500,
      res.status,
    );
  }
  if (!res.ok) {
    if (typeof data.error === "object" && data.error !== null) {
      throw new DashboardApiError(
        data.error.code ?? "API_ERROR",
        data.error.message ?? `API error: ${res.status}`,
        data.error.suggestion ?? null,
        data.error.retryable === true,
        res.status,
      );
    }
    throw new DashboardApiError(
      "API_ERROR",
      typeof data.error === "string" ? data.error : `API error: ${res.status}`,
      null,
      res.status >= 500,
      res.status,
    );
  }
  return data;
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
    input,
  );
}

export function draftInsight(
  input: DraftInsightRequest,
): Promise<{ draft: { skill_dir: string } }> {
  return portfolioRequest<{ draft: { skill_dir: string } }>("/api/v2/insights/draft", input);
}

export function evaluateInsight(input: { candidate_id: string }): Promise<{
  recommended: boolean;
  blockers: string[];
}> {
  return portfolioRequest("/api/v2/insights/evaluate", input);
}

export function releaseInsight(input: { candidate_id: string }): Promise<{
  package_path: string;
}> {
  return portfolioRequest("/api/v2/insights/release", input);
}

export function quarantinePortfolioSkill(input: {
  skillName: string;
  skillPath: string;
  confirm?: boolean;
}): Promise<QuarantineReceipt> {
  return portfolioRequest<QuarantineReceipt>("/api/v2/portfolio/quarantine", {
    skill_name: input.skillName,
    skill_path: input.skillPath,
    confirm: input.confirm ?? true,
  });
}

export function quarantinePortfolioSkills(
  inputs: readonly { skillName: string; skillPath: string }[],
): Promise<PortfolioQuarantineBatchResult> {
  return portfolioRequest<PortfolioQuarantineBatchResult>("/api/v2/portfolio/quarantine-batch", {
    skills: inputs.map((input) => ({
      skill_name: input.skillName,
      skill_path: input.skillPath,
    })),
  });
}

export function previewQuarantinePortfolioSkill(input: {
  skillName: string;
  skillPath: string;
}): Promise<QuarantineReceipt> {
  return quarantinePortfolioSkill({ ...input, confirm: false });
}

export function restorePortfolioSkill(quarantineId: string): Promise<QuarantineReceipt> {
  return portfolioRequest<QuarantineReceipt>("/api/v2/portfolio/restore", {
    quarantine_id: quarantineId,
  });
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
  return portfolioRequest("/api/v2/decisions/removals", {
    skill_name: input.skillName,
    locations: input.locations.map((location) => ({
      skill_path: location.skillPath,
      connection: location.connection,
    })),
  });
}

export function prepareSkillConsolidationDecision(input: {
  skillName: string;
  canonicalSkillPath: string;
  targetSkillPaths: string[];
}): Promise<DurableDashboardDecision> {
  return portfolioRequest("/api/v2/decisions/consolidations", {
    skill_name: input.skillName,
    canonical_skill_path: input.canonicalSkillPath,
    target_skill_paths: input.targetSkillPaths,
  });
}

export function prepareProjectConflictDecision(input: {
  skillSetId: string;
  projectRoot: string;
}): Promise<DurableDashboardDecision> {
  return portfolioRequest("/api/v2/decisions/skill-set-conflicts", {
    set_id: input.skillSetId,
    project_root: input.projectRoot,
  });
}

export function decideDurableDecision(input: {
  decisionId: string;
  action: "approve" | "decline";
}): Promise<DurableDashboardDecision> {
  return portfolioRequest(
    `/api/v2/decisions/${encodeURIComponent(input.decisionId)}/${input.action}`,
    {},
  );
}

export function rollbackDurableDecision(decisionId: string): Promise<DurableDashboardDecision> {
  return portfolioRequest(`/api/v2/decisions/${encodeURIComponent(decisionId)}/rollback`, {});
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
  return portfolioRequest<LocalTraceCandidateReview>("/api/v2/trace-candidates/prepare", {
    pattern_id,
  });
}

export interface LocalCloudEvaluationTarget {
  source_id: string;
  snapshot_id: string;
  skill_id: string;
  suite_id: string;
  suite_name: string;
  manifest_digest: string;
  lane: "outcome_task";
}

export function fetchTraceCandidateTargets(draftId: string): Promise<{
  draft_id: string;
  lifecycle: "prepared" | "submitted" | "stale";
  run_id: string | null;
  targets: LocalCloudEvaluationTarget[];
  blockers: { code: string; message: string }[];
}> {
  return portfolioRequest(`/api/v2/trace-candidates/${encodeURIComponent(draftId)}/targets`);
}

export function submitTraceCandidateTarget(
  draftId: string,
  target: Pick<
    LocalCloudEvaluationTarget,
    "source_id" | "snapshot_id" | "skill_id" | "suite_id" | "manifest_digest"
  >,
): Promise<CloudEvaluationSubmissionReceipt> {
  return portfolioRequest(`/api/v2/trace-candidates/${encodeURIComponent(draftId)}/submit`, target);
}

export function updateSkillClassification(
  input: UpdateSkillClassificationRequest,
): Promise<SkillClassificationOverrideReceipt> {
  return portfolioRequest<SkillClassificationOverrideReceipt>(
    "/api/v2/skill-intelligence/classification",
    input,
  );
}

export function reviewSkillSetSuggestion(
  input: ReviewSkillSetSuggestionRequest,
): Promise<SkillSetSuggestionReview> {
  return portfolioRequest<SkillSetSuggestionReview>(
    "/api/v2/skill-intelligence/suggestions/review",
    input,
  );
}

export function createProjectSkillSet(input: CreateSkillSetRequest): Promise<SkillSetManifest> {
  return portfolioRequest<SkillSetManifest>("/api/v2/skill-sets", input);
}

export function updateProjectSkillSet(input: UpdateSkillSetRequest): Promise<SkillSetManifest> {
  return portfolioRequest<SkillSetManifest>("/api/v2/skill-sets/update", input);
}

export function deriveProjectSkillSet(input: DeriveSkillSetRequest): Promise<SkillSetManifest> {
  return portfolioRequest<SkillSetManifest>("/api/v2/skill-sets/derive", input);
}

export function exportProjectSkillSet(
  input: ExportSkillSetRequest,
): Promise<{ output_path: string }> {
  return portfolioRequest<{ output_path: string }>("/api/v2/skill-sets/export", input);
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
  return portfolioRequest("/api/v2/skill-sets/share", {
    set_id: input.skillSetId,
    mode: input.mode,
    delivery: input.delivery,
    ...(input.recipientEmail ? { recipient_email: input.recipientEmail } : {}),
  });
}

export function previewProjectSkillSet(input: PlanSkillSetRequest): Promise<SkillSetPlan> {
  return portfolioRequest<SkillSetPlan>("/api/v2/skill-sets/plan", input);
}

export function applyProjectSkillSet(
  input: ApplySkillSetRequest,
): Promise<SkillSetRemoteApplyResult> {
  return portfolioRequest<SkillSetRemoteApplyResult>("/api/v2/skill-sets/apply", input);
}

export function previewProjectProvision(
  input: ProjectProvisionInput,
): Promise<ProjectProvisionPlanModel> {
  return portfolioRequest<ProjectProvisionPlanModel>("/api/v2/skill-sets/project-plan", {
    project_root: input.projectRoot,
    set_ids: input.skillSetIds,
    harnesses: input.harnesses,
  });
}

export function applyProjectProvision(
  input: ProjectProvisionInput,
): Promise<ProjectProvisionResultModel> {
  return portfolioRequest<{ project_root: string; receipt_count: number }>(
    "/api/v2/skill-sets/project-apply",
    {
      project_root: input.projectRoot,
      set_ids: input.skillSetIds,
      harnesses: input.harnesses,
      create_react_project: input.createReactProject,
    },
  ).then((result) => ({
    projectRoot: result.project_root,
    receiptCount: result.receipt_count,
  }));
}

export function rollbackProjectSkillSet(input: RollbackSkillSetRequest): Promise<SkillSetReceipt> {
  return portfolioRequest<SkillSetReceipt>("/api/v2/skill-sets/rollback", input);
}

export interface DashboardActionRequest {
  skill: string;
  skillPath: string;
  proposalId?: string;
  autoSynthetic?: boolean;
}

export interface DashboardActionResponse {
  success: boolean;
  output: string;
  error: string | null;
  exitCode?: number | null;
}

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
  const data = (await res.json()) as DashboardActionResponse & {
    error?: string | null;
  };
  if (!res.ok) {
    throw new Error(data.error || `API error: ${res.status} ${res.statusText}`);
  }
  return data;
}

export class NotFoundError extends Error {
  constructor(skillName: string) {
    super(`Skill "${skillName}" not found`);
    this.name = "NotFoundError";
  }
}
