import type { ReactNode } from "react";
import { Outlet } from "@tanstack/react-router";

import { DashboardHostProvider, type DashboardHostAdapter } from "@selftune/dashboard-core/host";

export interface AppCoreHostProviderProps {
  adapter: DashboardHostAdapter;
  children: ReactNode;
}

/** Supplies the host adapter consumed by every shared app screen. */
export function AppCoreHostProvider({ adapter, children }: AppCoreHostProviderProps) {
  return <DashboardHostProvider adapter={adapter}>{children}</DashboardHostProvider>;
}

/** Convenience root content for hosts that do not need another wrapper around the outlet. */
export function AppCoreHostOutlet({ adapter }: { adapter: DashboardHostAdapter }) {
  return (
    <AppCoreHostProvider adapter={adapter}>
      <Outlet />
    </AppCoreHostProvider>
  );
}
