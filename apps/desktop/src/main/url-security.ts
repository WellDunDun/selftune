export function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === "https:";
  } catch {
    return false;
  }
}

export type DashboardNavigationTrust = "blocked" | "internal" | "test-data";

export function classifyDashboardNavigation(
  rawUrl: string,
  baseUrl: string,
  allowedTestDataUrl?: string,
): DashboardNavigationTrust {
  if (isInternalDashboardUrl(rawUrl, baseUrl)) return "internal";
  if (!allowedTestDataUrl) return "blocked";
  try {
    const candidate = new URL(rawUrl);
    const allowed = new URL(allowedTestDataUrl);
    return candidate.protocol === "data:" && candidate.href === allowed.href
      ? "test-data"
      : "blocked";
  } catch {
    return "blocked";
  }
}

export function isInternalDashboardUrl(rawUrl: string, baseUrl: string): boolean {
  try {
    const candidate = new URL(rawUrl);
    const base = new URL(baseUrl);
    return (
      !candidate.username &&
      !candidate.password &&
      candidate.origin === base.origin &&
      candidate.protocol === "http:"
    );
  } catch {
    return false;
  }
}
