import type {
  ApplyOnboardingRequest,
  ApplyOnboardingResponse,
  ApplySkillSetRequest,
  AnalyticsResponse,
  DashboardActionName,
  DashboardShellResponse,
  DoctorResult,
  LibrarySnapshot,
  SkillSourceUpdatePreview,
  SkillSourceUpdateReceipt,
  DesktopSettingsResponse,
  OrchestrateRunsResponse,
  OverviewResponse,
  PortfolioResponse,
  CreateSkillSetRequest,
  DeriveSkillSetRequest,
  ExportSkillSetRequest,
  PlanSkillSetRequest,
  QuarantineReceipt,
  RollbackSkillSetRequest,
  SkillSetManifest,
  SkillSetPlan,
  SkillSetReceipt,
  SkillSetsResponse,
  SkillReportResponse,
  UpdateDesktopScheduleRequest,
  UpdateRemoteLibraryRequest,
  CreateRemoteLibraryShareRequest,
  RemoteLibraryShare,
  RemoteLibrarySharesResponse,
  UpdateSkillSetRequest,
  InsightsResponse,
  ReviewInsightRequest,
  DraftInsightRequest,
} from "./types";

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

export async function fetchLibrary(): Promise<LibrarySnapshot> {
  const res = await fetch(`${BASE}/api/v2/library`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
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

export function restoreRemoteLibraryNow(): Promise<{ targetRoot: string; restored: number }> {
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
  const data = (await res.json()) as T & {
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

export function fetchSkillSets(): Promise<SkillSetsResponse> {
  return portfolioRequest<SkillSetsResponse>("/api/v2/skill-sets");
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

export function previewProjectSkillSet(input: PlanSkillSetRequest): Promise<SkillSetPlan> {
  return portfolioRequest<SkillSetPlan>("/api/v2/skill-sets/plan", input);
}

export function applyProjectSkillSet(input: ApplySkillSetRequest): Promise<SkillSetReceipt> {
  return portfolioRequest<SkillSetReceipt>("/api/v2/skill-sets/apply", input);
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
