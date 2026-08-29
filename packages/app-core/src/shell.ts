export type AppCoreRouteMatchMode = "exact" | "prefix";

export interface AppCoreShellRouteDefinition {
  readonly id: string;
  readonly path: `/${string}`;
  readonly navigation: {
    readonly label: string;
    readonly tooltip: string;
  };
  readonly header: {
    readonly title: string;
  };
  readonly match: {
    readonly mode: AppCoreRouteMatchMode;
  };
}

/**
 * Canonical path and shell metadata for every cross-host product route.
 *
 * This module deliberately has no React or router dependency. Desktop, Cloud,
 * and future hosts can consume it through `@selftune/app-core/shell` without
 * adopting another host's routing framework.
 */
export const APP_CORE_ROUTE_REGISTRY = {
  skills: {
    id: "skills",
    path: "/skills",
    navigation: {
      label: "Skills",
      tooltip: "Browse skills",
    },
    header: {
      title: "Skills",
    },
    match: {
      mode: "prefix",
    },
  },
  projects: {
    id: "projects",
    path: "/projects",
    navigation: {
      label: "Skill Sets",
      tooltip: "Reusable Skill Sets",
    },
    header: {
      title: "Skill Sets",
    },
    match: {
      mode: "prefix",
    },
  },
  collaboration: {
    id: "collaboration",
    path: "/collaboration",
    navigation: {
      label: "Team",
      tooltip: "Manage workspace members and sharing",
    },
    header: {
      title: "Workspace team",
    },
    match: {
      mode: "prefix",
    },
  },
} as const satisfies Record<string, AppCoreShellRouteDefinition>;

export const APP_CORE_RECIPIENT_ROUTE_REGISTRY = {
  publicRecipientShare: {
    id: "publicRecipientShare",
    path: "/share/:claimToken",
    visibility: "public",
  },
  claimedRecipientShare: {
    id: "claimedRecipientShare",
    path: "/inbox/shares/:invitationId",
    visibility: "authenticated",
  },
} as const;

export type AppCoreRecipientRouteId = keyof typeof APP_CORE_RECIPIENT_ROUTE_REGISTRY;

export type AppCoreRouteId = keyof typeof APP_CORE_ROUTE_REGISTRY;

export interface AppCoreNavigationEntry {
  readonly id: AppCoreRouteId;
  readonly path: `/${string}`;
  readonly label: string;
  readonly tooltip: string;
}

export const APP_CORE_ROUTE_IDS = [
  "skills",
  "projects",
  "collaboration",
] as const satisfies readonly AppCoreRouteId[];

export const APP_CORE_SHELL_NAVIGATION: readonly AppCoreNavigationEntry[] = APP_CORE_ROUTE_IDS.map(
  (id) => {
    const route = APP_CORE_ROUTE_REGISTRY[id];
    return {
      id,
      path: route.path,
      label: route.navigation.label,
      tooltip: route.navigation.tooltip,
    };
  },
);

function matchesShellRoute(pathname: string, route: AppCoreShellRouteDefinition): boolean {
  return route.match.mode === "exact"
    ? pathname === route.path
    : pathname === route.path || pathname.startsWith(`${route.path}/`);
}

export function isAppCoreRouteActive(pathname: string, routeId: AppCoreRouteId): boolean {
  return matchesShellRoute(pathname, APP_CORE_ROUTE_REGISTRY[routeId]);
}

export function matchAppCoreShellRoute(pathname: string) {
  return (
    APP_CORE_ROUTE_IDS.map((id) => APP_CORE_ROUTE_REGISTRY[id]).find((route) =>
      matchesShellRoute(pathname, route),
    ) ?? null
  );
}
