import { APP_CORE_ROUTE_MANIFEST, APP_CORE_ROUTES } from "@selftune/app-core/manifest";
import {
  APP_CORE_SHELL_NAVIGATION,
  APP_CORE_ROUTE_REGISTRY,
  isAppCoreRouteActive,
  matchAppCoreShellRoute,
  type AppCoreRouteId,
} from "@selftune/app-core/shell";

/**
 * The shared product routes mounted by the Local and Desktop hosts.
 *
 * React Router remains the host router for now. Keeping the complete manifest
 * entries here makes both the path and screen implementation canonical without
 * coupling this composition root to app-core's TanStack Router helper.
 */
export const LOCAL_APP_CORE_ROUTES = APP_CORE_ROUTES;

export const LOCAL_APP_CORE_ROUTE_MANIFEST = APP_CORE_ROUTE_MANIFEST;

export const LOCAL_APP_CORE_NAVIGATION = APP_CORE_SHELL_NAVIGATION;

export const LOCAL_APP_CORE_ROUTE_REGISTRY = APP_CORE_ROUTE_REGISTRY;

const LOCAL_HOST_PRIMARY_ROUTE_IDS = new Set(["analytics", "settings"]);

interface LocalPrimaryRouteMetadata {
  readonly id: string;
  readonly path: string;
  readonly label: string;
  readonly tooltip: string;
}

/**
 * App-core owns the inclusion, order, paths, and copy for shared navigation.
 * Dashboard-core contributes host-specific presentation/access fields and the
 * Desktop-only routes that follow the shared entries.
 */
export function composeLocalPrimaryRoutes<TRoute extends LocalPrimaryRouteMetadata>(
  routes: readonly TRoute[],
): TRoute[] {
  const sharedRoutes = LOCAL_APP_CORE_NAVIGATION.flatMap((navigation) => {
    const hostRoute = routes.find(({ id }) => id === navigation.id);
    return hostRoute
      ? [
          {
            ...hostRoute,
            path: navigation.path,
            label: navigation.label,
            tooltip: navigation.tooltip,
          },
        ]
      : [];
  });
  const hostRoutes = routes.filter(({ id }) => LOCAL_HOST_PRIMARY_ROUTE_IDS.has(id));
  return [...sharedRoutes, ...hostRoutes];
}

export function getLocalAppCoreNavigation(routeId: string) {
  return LOCAL_APP_CORE_NAVIGATION.find(({ id }) => id === routeId) ?? null;
}

export function isLocalAppCoreRouteActive(pathname: string, routeId: AppCoreRouteId): boolean {
  return isAppCoreRouteActive(pathname, routeId);
}

export const matchLocalAppCoreShellRoute = matchAppCoreShellRoute;
