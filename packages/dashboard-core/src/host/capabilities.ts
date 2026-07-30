export const FEATURE_KEYS = [
  "analytics",
  "registry",
  "signals",
  "proposals",
  "billing",
  "teamAdmin",
  "runtimeStatus",
] as const;

export const DISCOVERABLE_FEATURE_KEYS = ["registry", "signals", "proposals", "billing"] as const;

export type DashboardHostKind = "local" | "cloud" | "selfhost";
export type DashboardPlan = "oss" | "pro" | "team";
export type DashboardFeatureKey = (typeof FEATURE_KEYS)[number];
export type DashboardDiscoverableFeatureKey = (typeof DISCOVERABLE_FEATURE_KEYS)[number];

export type DashboardFeatureContribution =
  | { readonly access: "available" }
  | { readonly access: "upgrade"; readonly href: string };

export type DashboardFeatureAccess =
  | DashboardFeatureContribution
  | { readonly access: "unavailable"; readonly reason: string };

export type DashboardFeatureContributions = Partial<
  Record<DashboardFeatureKey, DashboardFeatureContribution>
>;

export type DashboardFeatureFlags = Record<DashboardFeatureKey, boolean>;
export type DashboardDiscoverableFlags = Record<DashboardDiscoverableFeatureKey, boolean>;

export interface Capabilities {
  host: DashboardHostKind;
  plan: DashboardPlan;
  features: DashboardFeatureFlags;
  discoverable: DashboardDiscoverableFlags;
}

interface CapabilityContributor {
  readonly host: DashboardHostKind;
  readonly plan: DashboardPlan;
  readonly features: DashboardFeatureContributions;
}

export function featureAccessFromAdapter(
  adapter: CapabilityContributor,
  feature: DashboardFeatureKey,
): DashboardFeatureAccess {
  return (
    adapter.features[feature] ?? {
      access: "unavailable",
      reason: "This server does not provide this capability.",
    }
  );
}

export function capabilitiesFromAdapter(adapter: CapabilityContributor): Capabilities {
  return {
    host: adapter.host,
    plan: adapter.plan,
    features: {
      analytics: adapter.features.analytics?.access === "available",
      registry: adapter.features.registry?.access === "available",
      signals: adapter.features.signals?.access === "available",
      proposals: adapter.features.proposals?.access === "available",
      billing: adapter.features.billing?.access === "available",
      teamAdmin: adapter.features.teamAdmin?.access === "available",
      runtimeStatus: adapter.features.runtimeStatus?.access === "available",
    },
    discoverable: {
      registry: adapter.features.registry !== undefined,
      signals: adapter.features.signals !== undefined,
      proposals: adapter.features.proposals !== undefined,
      billing: adapter.features.billing !== undefined,
    },
  };
}

export function canUseFeature(capabilities: Capabilities, feature: DashboardFeatureKey): boolean {
  return capabilities.features[feature];
}

export function canDiscoverFeature(
  capabilities: Capabilities,
  feature: DashboardDiscoverableFeatureKey,
): boolean {
  return capabilities.discoverable[feature] || capabilities.features[feature];
}

export function withCapabilityOverrides(
  base: Capabilities,
  overrides: Partial<Capabilities>,
): Capabilities {
  return {
    host: overrides.host ?? base.host,
    plan: overrides.plan ?? base.plan,
    features: {
      ...base.features,
      ...overrides.features,
    },
    discoverable: {
      ...base.discoverable,
      ...overrides.discoverable,
    },
  };
}
