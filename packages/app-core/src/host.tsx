import type { ReactNode } from "react";
import { Outlet } from "@tanstack/react-router";

import { DashboardHostProvider, type DashboardHostModules } from "@selftune/dashboard-core/host";

export interface AppCoreHostProviderProps {
  modules: DashboardHostModules;
  children: ReactNode;
}

/** Supplies the journey modules consumed by every shared app screen. */
export function AppCoreHostProvider({ modules, children }: AppCoreHostProviderProps) {
  return <DashboardHostProvider modules={modules}>{children}</DashboardHostProvider>;
}

/** Convenience root content for hosts that do not need another wrapper around the outlet. */
export function AppCoreHostOutlet({ modules }: { modules: DashboardHostModules }) {
  return (
    <AppCoreHostProvider modules={modules}>
      <Outlet />
    </AppCoreHostProvider>
  );
}
