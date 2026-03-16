import type { SkillHealthStatus } from "../types";

export function deriveStatus(passRate: number, checks: number): SkillHealthStatus {
  if (checks < 5) return "UNGRADED";
  if (passRate >= 0.8) return "HEALTHY";
  if (passRate >= 0.5) return "WARNING";
  return "CRITICAL";
}

export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "--";
  return `${Math.round(rate * 100)}%`;
}

export function sortByPassRateAndChecks<T extends { passRate: number | null; checks: number }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const aRate = a.passRate ?? 1;
    const bRate = b.passRate ?? 1;
    if (aRate !== bRate) return aRate - bRate;
    return b.checks - a.checks;
  });
}

export function timeAgo(timestamp: string): string {
  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts)) return "--";
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
