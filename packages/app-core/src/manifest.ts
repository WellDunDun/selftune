import type { ReactNode } from "react";

import { ProjectsScreen } from "@selftune/dashboard-core/screens/projects";
import { SkillsLibraryScreen } from "@selftune/dashboard-core/screens/skills";
import { RecipientShareScreen } from "@selftune/dashboard-core/screens/recipient-shares";
import { TeamCollaborationScreen } from "@selftune/dashboard-core/screens/team-collaboration";

import {
  APP_CORE_RECIPIENT_ROUTE_REGISTRY,
  APP_CORE_ROUTE_IDS,
  APP_CORE_ROUTE_REGISTRY,
  type AppCoreRecipientRouteId,
  type AppCoreRouteId,
} from "./shell";

export type AppCoreScreenComponent = () => ReactNode;

export interface AppCoreRouteManifestEntry {
  readonly id: AppCoreRouteId;
  readonly path: `/${string}`;
  readonly label: string;
  readonly tooltip: string;
  readonly headerTitle: string;
  readonly Component: AppCoreScreenComponent;
}

export interface AppCoreRecipientRouteManifestEntry {
  readonly id: AppCoreRecipientRouteId;
  readonly path: string;
  readonly visibility: "public" | "authenticated";
  readonly Component: AppCoreScreenComponent;
}

export const APP_CORE_RECIPIENT_ROUTE_MANIFEST: readonly AppCoreRecipientRouteManifestEntry[] = [
  {
    ...APP_CORE_RECIPIENT_ROUTE_REGISTRY.publicRecipientShare,
    Component: RecipientShareScreen,
  },
  {
    ...APP_CORE_RECIPIENT_ROUTE_REGISTRY.claimedRecipientShare,
    Component: RecipientShareScreen,
  },
];

/**
 * The canonical application route/screen source.
 *
 * A route belongs here only after its screen is host-neutral and reads data through
 * DashboardHostModules. Host composition roots may explicitly exclude or replace an
 * entry, but must not copy its screen.
 */
const APP_CORE_SCREENS = {
  skills: SkillsLibraryScreen,
  projects: ProjectsScreen,
  collaboration: TeamCollaborationScreen,
} as const satisfies Record<AppCoreRouteId, AppCoreScreenComponent>;

/**
 * Route entries are joined from one metadata registry and one exhaustive screen
 * map. Adding a shared route therefore cannot leave shell or router metadata
 * behind unnoticed.
 */
export const APP_CORE_ROUTE_MANIFEST: readonly AppCoreRouteManifestEntry[] = APP_CORE_ROUTE_IDS.map(
  (id) => {
    const route = APP_CORE_ROUTE_REGISTRY[id];
    return {
      id,
      path: route.path,
      label: route.navigation.label,
      tooltip: route.navigation.tooltip,
      headerTitle: route.header.title,
      Component: APP_CORE_SCREENS[id],
    };
  },
);

function routeManifestEntry(id: AppCoreRouteId): AppCoreRouteManifestEntry {
  const entry = APP_CORE_ROUTE_MANIFEST.find((route) => route.id === id);
  if (!entry) throw new Error(`Shared route manifest is missing ${id}.`);
  return entry;
}

export const APP_CORE_ROUTES = {
  skills: routeManifestEntry("skills"),
  projects: routeManifestEntry("projects"),
  collaboration: routeManifestEntry("collaboration"),
} satisfies Readonly<Record<AppCoreRouteId, AppCoreRouteManifestEntry>>;

export type AppCoreRouteReplacements = Partial<Record<AppCoreRouteId, AppCoreScreenComponent>>;

export interface AppCoreRouteComposition {
  /** Shared routes that this host intentionally does not mount. */
  readonly exclude?: readonly AppCoreRouteId[];
  /** Host-specific screens that intentionally replace a shared route. */
  readonly replace?: AppCoreRouteReplacements;
}

export function resolveAppCoreRouteManifest(
  composition: AppCoreRouteComposition = {},
): readonly AppCoreRouteManifestEntry[] {
  const excluded = new Set(composition.exclude);

  return APP_CORE_ROUTE_MANIFEST.filter(({ id }) => !excluded.has(id)).map((route) => ({
    ...route,
    Component: composition.replace?.[route.id] ?? route.Component,
  }));
}
