import type { ServerRuntimeProfile } from "@selftune/dashboard-core/host";

export function localDashboardHost(runtime: ServerRuntimeProfile): "local" | "selfhost" {
  if (runtime.host === "cloud") {
    throw new TypeError("The Local dashboard bundle cannot boot a Cloud host.");
  }
  return runtime.host;
}
