import { createContext, useContext, useMemo, type ReactNode } from "react";

import {
  type DashboardOverviewModule,
  type DashboardPluginsModule,
  type DashboardRecipientSharesModule,
  type DashboardSkillSetsModule,
  type DashboardSkillsModule,
  type DashboardTeamCollaborationModule,
} from "./adapter";
import type { Capabilities, DashboardFeatureKey } from "./capabilities";
import { capabilitiesFromModule, canUseFeature, featureAccessFromModule } from "./capabilities";
import type { DashboardChromeModule, DashboardHostModules } from "./modules";

export interface DashboardHostContextValue {
  modules: DashboardHostModules;
  capabilities: Capabilities;
}

const DashboardHostContext = createContext<DashboardHostContextValue | null>(null);

interface DashboardHostProviderProps {
  modules: DashboardHostModules;
  children: ReactNode;
}

export function DashboardHostProvider({ modules, children }: DashboardHostProviderProps) {
  const value = useMemo(
    () => ({
      modules,
      capabilities: capabilitiesFromModule(modules.capability),
    }),
    [modules],
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

export function useSkillSetsModule(): DashboardSkillSetsModule {
  return useDashboardHost().modules.skillSets;
}

export function useSkillsModule(): DashboardSkillsModule {
  return useDashboardHost().modules.skills;
}

export function usePluginsModule(): DashboardPluginsModule {
  return useDashboardHost().modules.plugins;
}

export function useRecipientSharesModule(): DashboardRecipientSharesModule {
  return useDashboardHost().modules.recipientShares;
}

export function useTeamCollaborationModule(): DashboardTeamCollaborationModule {
  return useDashboardHost().modules.teamCollaboration;
}

export function useOptionalOverviewModule(): DashboardOverviewModule | null {
  return useOptionalDashboardHost()?.modules.overview ?? null;
}

export function useOptionalChromeModule(): DashboardChromeModule | null {
  return useOptionalDashboardHost()?.modules.chrome ?? null;
}

export function useCapabilities(): Capabilities {
  return useDashboardHost().capabilities;
}

export function useFeatureEnabled(feature: DashboardFeatureKey): boolean {
  return canUseFeature(useCapabilities(), feature);
}

export function useFeatureAccess(feature: DashboardFeatureKey) {
  return featureAccessFromModule(useDashboardHost().modules.capability, feature);
}
