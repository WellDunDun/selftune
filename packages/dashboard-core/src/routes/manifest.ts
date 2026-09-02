import type { LucideIcon } from "lucide-react";
import {
  BarChart3Icon,
  BlocksIcon,
  BrainCircuitIcon,
  FolderKanbanIcon,
  GitPullRequestIcon,
  HeartPulseIcon,
  HelpCircleIcon,
  LayoutDashboardIcon,
  PackageIcon,
  RadioTowerIcon,
  SettingsIcon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react";

import {
  canDiscoverFeature,
  canUseFeature,
  type Capabilities,
  type DashboardDiscoverableFeatureKey,
  type DashboardFeatureKey,
  type DashboardHostKind,
} from "../host/capabilities";
import type { DashboardRouteAccess } from "./types";

export type DashboardRouteId =
  | "overview"
  | "skills"
  | "projects"
  | "plugins"
  | "collaboration"
  | "observed"
  | "improve"
  | "analytics"
  | "status"
  | "registry"
  | "signals"
  | "proposals"
  | "unmatched"
  | "settings";

export type DashboardRouteMatchMode = "exact" | "prefix";

export interface DashboardPathMatcher {
  mode: DashboardRouteMatchMode;
  value: string;
}

export interface DashboardHostRouteConfig {
  path: string;
  title?: string;
  badge?: string;
  backHref?: string | null;
  backLabel?: string | null;
  activePatterns?: DashboardPathMatcher[];
  detailPrefixes?: string[];
  detailBadge?: string;
  detailBackHref?: string | null;
  detailBackLabel?: string | null;
}

export interface DashboardRouteManifestEntry {
  id: DashboardRouteId;
  label: string;
  tooltip: string;
  icon: LucideIcon;
  feature?: DashboardFeatureKey;
  discoverableFeature?: DashboardDiscoverableFeatureKey;
  lockedTitle?: string;
  lockedBody?: string;
  lockedHighlights?: readonly string[];
  lockedPrimaryCtaLabel?: string;
  lockedPrimaryCtaHref?: string;
  lockedSecondaryCtaLabel?: string;
  lockedSecondaryCtaHref?: string;
  hosts: Partial<Record<DashboardHostKind, DashboardHostRouteConfig>>;
}

export interface ResolvedDashboardRoute {
  id: DashboardRouteId;
  label: string;
  tooltip: string;
  icon: LucideIcon;
  host: DashboardHostKind;
  path: string;
  title: string;
  badge: string;
  backHref: string | null;
  backLabel: string | null;
  activePatterns: DashboardPathMatcher[];
  detailPrefixes: string[];
  detailBadge: string;
  detailBackHref: string | null;
  detailBackLabel: string | null;
  access: DashboardRouteAccess;
  lockedTitle?: string;
  lockedBody?: string;
  lockedHighlights?: readonly string[];
  lockedPrimaryCtaLabel?: string;
  lockedPrimaryCtaHref?: string;
  lockedSecondaryCtaLabel?: string;
  lockedSecondaryCtaHref?: string;
}

export interface MatchedDashboardRoute extends ResolvedDashboardRoute {
  matchKind: "route" | "detail";
}

function matchesPattern(pathname: string, pattern: DashboardPathMatcher): boolean {
  if (pattern.mode === "exact") {
    return pathname === pattern.value;
  }

  return pathname.startsWith(pattern.value);
}

function getManifestRouteAccess(
  route: DashboardRouteManifestEntry,
  capabilities: Capabilities,
): DashboardRouteAccess {
  if (!route.feature) {
    return "enabled";
  }

  if (canUseFeature(capabilities, route.feature)) {
    return "enabled";
  }

  if (route.discoverableFeature && canDiscoverFeature(capabilities, route.discoverableFeature)) {
    return "locked";
  }

  return "hidden";
}

export const DASHBOARD_ROUTE_MANIFEST: readonly DashboardRouteManifestEntry[] = [
  {
    id: "overview",
    label: "Overview",
    tooltip: "Dashboard overview",
    icon: LayoutDashboardIcon,
    hosts: {
      cloud: {
        path: "/",
        title: "Dashboard",
        badge: "Overview",
        activePatterns: [{ mode: "exact", value: "/" }],
      },
      local: {
        path: "/",
        title: "Dashboard",
        badge: "Overview",
        activePatterns: [{ mode: "exact", value: "/" }],
      },
    },
  },
  {
    id: "skills",
    label: "Skills",
    tooltip: "Cloud library",
    icon: BrainCircuitIcon,
    hosts: {
      cloud: {
        path: "/skills",
        title: "Cloud Library",
        badge: "Cloud",
        backHref: "/",
        backLabel: "Dashboard",
        activePatterns: [
          { mode: "exact", value: "/skills" },
          { mode: "prefix", value: "/skills/cloud/" },
        ],
        detailPrefixes: ["/skills/cloud/"],
        detailBadge: "Cloud Detail",
        detailBackHref: "/skills",
        detailBackLabel: "Cloud Library",
      },
      local: {
        path: "/skills",
        title: "Library",
        badge: "Library",
        backHref: "/",
        backLabel: "Dashboard",
        activePatterns: [
          { mode: "exact", value: "/skills" },
          { mode: "prefix", value: "/skills/" },
        ],
        detailPrefixes: ["/skills/"],
        detailBadge: "Skill Report",
        detailBackHref: "/skills",
        detailBackLabel: "Library",
      },
    },
  },
  {
    id: "projects",
    label: "Skill Sets",
    tooltip: "Reusable Skill Sets",
    icon: FolderKanbanIcon,
    hosts: {
      cloud: {
        path: "/projects",
        title: "Skill Sets",
        badge: "Skill Sets",
        backHref: "/skills",
        backLabel: "Library",
        activePatterns: [{ mode: "prefix", value: "/projects" }],
      },
      local: {
        path: "/projects",
        title: "Skill Sets",
        badge: "Skill Sets",
        backHref: "/skills",
        backLabel: "Library",
        activePatterns: [{ mode: "prefix", value: "/projects" }],
      },
      selfhost: {
        path: "/projects",
        title: "Skill Sets",
        badge: "Skill Sets",
        backHref: "/skills",
        backLabel: "Library",
        activePatterns: [{ mode: "prefix", value: "/projects" }],
      },
    },
  },
  {
    id: "plugins",
    label: "Plugins",
    tooltip: "Manage plugins installed in Claude and Codex",
    icon: BlocksIcon,
    hosts: {
      local: {
        path: "/plugins",
        title: "Plugins",
        badge: "This Mac",
        backHref: "/skills",
        backLabel: "Library",
        activePatterns: [{ mode: "exact", value: "/plugins" }],
      },
      selfhost: {
        path: "/plugins",
        title: "Plugins",
        badge: "Server",
        backHref: "/skills",
        backLabel: "Library",
        activePatterns: [{ mode: "exact", value: "/plugins" }],
      },
    },
  },
  {
    id: "collaboration",
    label: "Team",
    tooltip: "Review team skill changes and rollouts",
    icon: UsersIcon,
    hosts: {
      cloud: {
        path: "/collaboration",
        title: "Team collaboration",
        badge: "Team",
        backHref: "/",
        backLabel: "Dashboard",
        activePatterns: [{ mode: "prefix", value: "/collaboration" }],
      },
      local: {
        path: "/collaboration",
        title: "Team collaboration",
        badge: "Team",
        backHref: "/skills",
        backLabel: "Library",
        activePatterns: [{ mode: "prefix", value: "/collaboration" }],
      },
      selfhost: {
        path: "/collaboration",
        title: "Team collaboration",
        badge: "Team",
        backHref: "/skills",
        backLabel: "Library",
        activePatterns: [{ mode: "prefix", value: "/collaboration" }],
      },
    },
  },
  {
    id: "observed",
    label: "Observed",
    tooltip: "Observed telemetry skills",
    icon: RadioTowerIcon,
    hosts: {
      cloud: {
        path: "/observed",
        title: "Observed Skills",
        badge: "Telemetry",
        backHref: "/",
        backLabel: "Dashboard",
        activePatterns: [{ mode: "exact", value: "/observed" }],
      },
      local: {
        path: "/skills",
        title: "Skills",
        badge: "Library",
        backHref: "/",
        backLabel: "Dashboard",
        activePatterns: [
          { mode: "exact", value: "/skills" },
          { mode: "prefix", value: "/skills/" },
        ],
        detailPrefixes: ["/skills/"],
        detailBadge: "Skill Report",
        detailBackHref: "/skills",
        detailBackLabel: "Skills",
      },
    },
  },
  {
    id: "analytics",
    label: "Analytics",
    tooltip: "Performance analytics",
    icon: BarChart3Icon,
    feature: "analytics",
    hosts: {
      local: {
        path: "/insights",
        title: "Insights",
        badge: "Evidence",
        backHref: "/skills",
        backLabel: "Library",
        activePatterns: [{ mode: "exact", value: "/insights" }],
      },
    },
  },
  {
    id: "registry",
    label: "Registry",
    tooltip: "Cloud skill registry",
    icon: PackageIcon,
    feature: "registry",
    discoverableFeature: "registry",
    lockedTitle: "Cloud Registry lives in selftune Cloud",
    lockedBody:
      "Publish versioned skills, watch installations across projects, and roll back bad versions from a single cloud workspace.",
    lockedHighlights: [
      "Version timeline with rollback controls",
      "Installation map across your team",
      "Managed publish flow for Pro and Team creators",
    ],
    lockedPrimaryCtaLabel: "Read registry docs",
    lockedPrimaryCtaHref: "https://docs.selftune.dev/cloud/registry",
    lockedSecondaryCtaLabel: "View cloud plans",
    lockedSecondaryCtaHref: "https://selftune.dev/pricing",
    hosts: {
      local: {
        path: "/registry",
        title: "Registry",
        badge: "Locked",
        backHref: "/",
        backLabel: "Dashboard",
        activePatterns: [{ mode: "exact", value: "/registry" }],
      },
    },
  },
  {
    id: "signals",
    label: "Signals",
    tooltip: "Contributor signals",
    icon: UsersIcon,
    feature: "signals",
    discoverableFeature: "signals",
    lockedTitle: "Contributor signals run through selftune Cloud",
    lockedBody:
      "See anonymized contributor signals, compare bundle submissions, and turn real-world usage into proposals without leaving the shared dashboard.",
    lockedHighlights: [
      "Cross-skill contributor signal overview",
      "Bundle submission trends and cohorts",
      "Proposal generation from contributor evidence",
    ],
    lockedPrimaryCtaLabel: "View cloud plans",
    lockedPrimaryCtaHref: "https://selftune.dev/pricing",
    lockedSecondaryCtaLabel: "Read signals docs",
    lockedSecondaryCtaHref: "https://docs.selftune.dev/cloud/signals",
    hosts: {
      cloud: {
        path: "/signals",
        title: "Signals",
        badge: "Signals",
        backHref: "/",
        backLabel: "Dashboard",
        activePatterns: [{ mode: "exact", value: "/signals" }],
      },
      local: {
        path: "/signals",
        title: "Signals",
        badge: "Locked",
        backHref: "/",
        backLabel: "Dashboard",
        activePatterns: [{ mode: "exact", value: "/signals" }],
      },
    },
  },
  {
    id: "improve",
    label: "Improve",
    tooltip: "Cloud improvement runs",
    icon: SparklesIcon,
    hosts: {},
  },
  {
    id: "proposals",
    label: "Proposals",
    tooltip: "Evolution proposals",
    icon: GitPullRequestIcon,
    feature: "proposals",
    discoverableFeature: "proposals",
    lockedTitle: "Proposal review is unlocked in Cloud",
    lockedBody:
      "Keep a shared review queue for contributor-driven improvements, approve the right changes, and coordinate deployment across your team.",
    lockedHighlights: [
      "Shared approval and rejection queue",
      "Proposal detail with rationale and evidence",
      "Tighter loop from contributor signals to deployment",
    ],
    lockedPrimaryCtaLabel: "Upgrade for review workflows",
    lockedPrimaryCtaHref: "https://selftune.dev/pricing",
    lockedSecondaryCtaLabel: "See dashboard docs",
    lockedSecondaryCtaHref: "https://docs.selftune.dev/cloud/dashboard",
    hosts: {
      local: {
        path: "/proposals",
        title: "Proposals",
        badge: "Locked",
        backHref: "/",
        backLabel: "Dashboard",
        activePatterns: [{ mode: "exact", value: "/proposals" }],
      },
    },
  },
  {
    id: "unmatched",
    label: "Unmatched",
    tooltip: "Unmatched queries",
    icon: HelpCircleIcon,
    hosts: {},
  },
  {
    id: "settings",
    label: "Settings",
    tooltip: "Harnesses and automation",
    icon: SettingsIcon,
    hosts: {
      cloud: {
        path: "/settings",
        title: "Settings",
        badge: "Workspace",
        backHref: "/",
        backLabel: "Dashboard",
        activePatterns: [{ mode: "exact", value: "/settings" }],
      },
      local: {
        path: "/settings",
        title: "Settings",
        badge: "Local",
        backHref: "/",
        backLabel: "Dashboard",
        activePatterns: [{ mode: "exact", value: "/settings" }],
      },
    },
  },
  {
    id: "status",
    label: "System Status",
    tooltip: "System health diagnostics",
    icon: HeartPulseIcon,
    feature: "runtimeStatus",
    hosts: {
      local: {
        path: "/status",
        title: "System Status",
        badge: "Diagnostics",
        backHref: "/",
        backLabel: "Dashboard",
        activePatterns: [{ mode: "exact", value: "/status" }],
      },
    },
  },
] as const;

export function resolveDashboardRoutes(
  host: DashboardHostKind,
  capabilities: Capabilities,
): ResolvedDashboardRoute[] {
  return DASHBOARD_ROUTE_MANIFEST.flatMap((route) => {
    const hostConfig = route.hosts[host];
    if (!hostConfig) {
      return [];
    }

    const access = getManifestRouteAccess(route, capabilities);
    if (access === "hidden") {
      return [];
    }

    return [
      {
        id: route.id,
        label: route.label,
        tooltip: route.tooltip,
        icon: route.icon,
        host,
        path: hostConfig.path,
        title: hostConfig.title ?? route.label,
        badge: hostConfig.badge ?? route.label,
        backHref: hostConfig.backHref ?? null,
        backLabel: hostConfig.backLabel ?? null,
        activePatterns: hostConfig.activePatterns ?? [{ mode: "exact", value: hostConfig.path }],
        detailPrefixes: hostConfig.detailPrefixes ?? [],
        detailBadge: hostConfig.detailBadge ?? hostConfig.badge ?? route.label,
        detailBackHref: hostConfig.detailBackHref ?? hostConfig.backHref ?? null,
        detailBackLabel: hostConfig.detailBackLabel ?? hostConfig.backLabel ?? null,
        access,
        lockedTitle: route.lockedTitle,
        lockedBody: route.lockedBody,
        lockedHighlights: route.lockedHighlights,
        lockedPrimaryCtaLabel: route.lockedPrimaryCtaLabel,
        lockedPrimaryCtaHref: route.lockedPrimaryCtaHref,
        lockedSecondaryCtaLabel: route.lockedSecondaryCtaLabel,
        lockedSecondaryCtaHref: route.lockedSecondaryCtaHref,
      },
    ];
  });
}

export function isDashboardRouteActive(pathname: string, route: ResolvedDashboardRoute): boolean {
  return Boolean(matchDashboardRoute(pathname, [route]));
}

export function matchDashboardRoute(
  pathname: string,
  routes: readonly ResolvedDashboardRoute[],
): MatchedDashboardRoute | null {
  for (const route of routes) {
    if (route.detailPrefixes.some((prefix) => pathname.startsWith(prefix))) {
      return {
        ...route,
        matchKind: "detail",
        badge: route.detailBadge,
        backHref: route.detailBackHref,
        backLabel: route.detailBackLabel,
      };
    }

    if (route.activePatterns.some((pattern) => matchesPattern(pathname, pattern))) {
      return {
        ...route,
        matchKind: "route",
      };
    }
  }

  return null;
}
