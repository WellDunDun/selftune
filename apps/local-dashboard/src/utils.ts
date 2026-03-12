import type { SkillHealthStatus } from "./types";

export function deriveStatus(passRate: number, checks: number, regression: boolean): SkillHealthStatus {
  if (checks < 5) return "UNGRADED";
  if (regression) return "CRITICAL";
  if (passRate >= 0.8) return "HEALTHY";
  if (passRate >= 0.5) return "WARNING";
  return "CRITICAL";
}

export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "--";
  return `${Math.round(rate * 100)}%`;
}

export function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
