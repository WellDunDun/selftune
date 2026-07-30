import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { DashboardHostAdapter } from "./adapter";
import type { Capabilities, DashboardFeatureKey } from "./capabilities";
import { capabilitiesFromAdapter, canUseFeature, featureAccessFromAdapter } from "./capabilities";

export interface DashboardHostContextValue {
  adapter: DashboardHostAdapter;
  capabilities: Capabilities;
}

const DashboardHostContext = createContext<DashboardHostContextValue | null>(null);

interface DashboardHostProviderProps {
  adapter: DashboardHostAdapter;
  children: ReactNode;
}

export function DashboardHostProvider({ adapter, children }: DashboardHostProviderProps) {
  const value = useMemo(
    () => ({
      adapter,
      capabilities: capabilitiesFromAdapter(adapter),
    }),
    [adapter],
  );

  return <DashboardHostContext.Provider value={value}>{children}</DashboardHostContext.Provider>;
}

export function useDashboardHost(): DashboardHostContextValue {
  const context = useContext(DashboardHostContext);
  if (!context) {
    throw new Error("useDashboardHost must be used within a DashboardHostProvider");
  }
  return context;
}

export function useOptionalDashboardHost(): DashboardHostContextValue | null {
  return useContext(DashboardHostContext);
}

export function useDashboardHostAdapter(): DashboardHostAdapter {
  return useDashboardHost().adapter;
}

export function useOptionalDashboardHostAdapter(): DashboardHostAdapter | null {
  return useOptionalDashboardHost()?.adapter ?? null;
}

export function useCapabilities(): Capabilities {
  return useDashboardHost().capabilities;
}

export function useFeatureEnabled(feature: DashboardFeatureKey): boolean {
  return canUseFeature(useCapabilities(), feature);
}

export function useFeatureAccess(feature: DashboardFeatureKey) {
  return featureAccessFromAdapter(useDashboardHostAdapter(), feature);
}
