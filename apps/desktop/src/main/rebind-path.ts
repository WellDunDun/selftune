import { isInternalDashboardUrl } from "./url-security";

export function dashboardPathForRebind(currentUrl: string, currentBaseUrl: string | null): string {
  if (!currentBaseUrl || !isInternalDashboardUrl(currentUrl, currentBaseUrl)) return "/";
  const url = new URL(currentUrl);
  return `${url.pathname}${url.search}${url.hash}`;
}
