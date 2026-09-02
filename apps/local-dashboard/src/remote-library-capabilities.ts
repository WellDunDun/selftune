import type { DashboardShareCapabilities } from "@selftune/dashboard-core/host";

import { syncDestinationFromUrl } from "./lib/sync-destination";

export const MANAGED_CLOUD_SHARE_CAPABILITIES = {
  linkModes: ["private_single_claim"],
  deliveries: ["copy_link"],
} as const satisfies DashboardShareCapabilities;

export const SELF_HOSTED_SHARE_CAPABILITIES = {
  linkModes: ["reusable_unlisted", "private_single_claim"],
  deliveries: ["copy_link", "email"],
} as const satisfies DashboardShareCapabilities;

export function remoteLibraryDestination(
  configured: boolean,
  url: string | null | undefined,
): "unconfigured" | "managed_cloud" | "self_hosted" {
  if (!configured) {
    return "unconfigured";
  }
  return syncDestinationFromUrl(url ?? "") === "cloud" ? "managed_cloud" : "self_hosted";
}
