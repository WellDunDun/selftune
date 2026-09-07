import { createRoute, type AnyRootRoute, type AnyRoute } from "@tanstack/react-router";

import {
  APP_CORE_RECIPIENT_ROUTE_MANIFEST,
  resolveAppCoreRouteManifest,
  type AppCoreRouteComposition,
} from "./manifest";
import type { AppCoreRecipientRouteId, AppCoreRouteId } from "./shell";

export type AppCoreTanStackRouteKey = `${AppCoreRouteId}Route`;
export type AppCoreRecipientTanStackRouteKey = `${AppCoreRecipientRouteId}Route`;

function routeKey(id: AppCoreRouteId): AppCoreTanStackRouteKey {
  return `${id}Route`;
}

function tanStackRecipientPath(path: string): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, parameter: string) => `$${parameter}`);
}

/** Canonical non-shell recipient routes; hosts opt in explicitly. */
export function createAppCoreRecipientRoutes<TRootRoute extends AnyRootRoute>(
  rootRoute: TRootRoute,
) {
  const entries = APP_CORE_RECIPIENT_ROUTE_MANIFEST.map(
    (route) =>
      [
        `${route.id}Route`,
        createRoute({
          getParentRoute: () => rootRoute,
          path: tanStackRecipientPath(route.path),
          component: route.Component,
        }),
      ] as const,
  );
  return entries.reduce<
    Partial<Record<AppCoreRecipientTanStackRouteKey, (typeof entries)[number][1]>>
  >((routes, [key, route]) => {
    routes[key] = route;
    return routes;
  }, {});
}

/**
 * Creates the shared route children beneath a host-owned TanStack root route.
 *
 * The host owns authentication, organization context, error boundaries, and the
 * final route tree. Shared-route divergence remains visible in `exclude` and
 * `replace` rather than being implemented by copied route files.
 */
export function createAppCoreRoutes<TRootRoute extends AnyRootRoute>(
  rootRoute: TRootRoute,
  composition: AppCoreRouteComposition = {},
) {
  const entries = resolveAppCoreRouteManifest(composition).map(
    (route) =>
      [
        routeKey(route.id),
        createRoute({
          getParentRoute: () => rootRoute,
          path: route.path,
          component: route.Component,
        }),
      ] as const,
  );
  return entries.reduce<Partial<Record<AppCoreTanStackRouteKey, (typeof entries)[number][1]>>>(
    (routes, [key, route]) => {
      routes[key] = route;
      return routes;
    },
    {},
  );
}

/**
 * Appends host-owned routes without widening either route collection to AnyRoute[].
 * Duplicate keys are rejected so a host must use `replace` for shared-route overrides.
 */
export function appendAppHostRoutes<
  TCoreRoutes extends Record<string, AnyRoute>,
  THostRoutes extends Record<string, AnyRoute>,
>(coreRoutes: TCoreRoutes, hostRoutes: THostRoutes) {
  for (const key of Object.keys(hostRoutes)) {
    if (Object.hasOwn(coreRoutes, key)) {
      throw new Error(
        `Host route key "${key}" conflicts with app-core. Use the explicit replace option instead.`,
      );
    }
  }

  return { ...coreRoutes, ...hostRoutes };
}
