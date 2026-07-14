import type {
  AnalyticsResponse,
  DashboardActionName,
  DoctorResult,
  OrchestrateRunsResponse,
  OverviewResponse,
  PortfolioResponse,
  QuarantineReceipt,
  SkillReportResponse,
} from "./types";

const BASE = "";

export async function fetchOverview(): Promise<OverviewResponse> {
  const res = await fetch(`${BASE}/api/v2/overview`);
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

async function portfolioRequest<T>(path: string, body?: Record<string, unknown>): Promise<T> {
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

export function quarantinePortfolioSkill(input: {
  skillName: string;
  skillPath: string;
}): Promise<QuarantineReceipt> {
  return portfolioRequest<QuarantineReceipt>("/api/v2/portfolio/quarantine", {
    skill_name: input.skillName,
    skill_path: input.skillPath,
    confirm: true,
  });
}

export function restorePortfolioSkill(quarantineId: string): Promise<QuarantineReceipt> {
  return portfolioRequest<QuarantineReceipt>("/api/v2/portfolio/restore", {
    quarantine_id: quarantineId,
  });
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
  const data = (await res.json()) as DashboardActionResponse & { error?: string | null };
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
