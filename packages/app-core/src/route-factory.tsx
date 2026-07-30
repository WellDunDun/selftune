import {
  createRoute,
  type AnyRootRoute,
  type AnyRoute,
  type RouteComponent,
} from "@tanstack/react-router";

import {
  APP_CORE_RECIPIENT_ROUTE_IDS,
  APP_CORE_RECIPIENT_ROUTE_REGISTRY,
  APP_CORE_ROUTE_IDS,
  APP_CORE_ROUTE_REGISTRY,
  type AppCoreRecipientRouteId,
  type AppCoreRouteId,
} from "./shell";

export type AppCoreTanStackRouteKey = `${AppCoreRouteId}Route`;
export type AppCoreRecipientTanStackRouteKey = `${AppCoreRecipientRouteId}Route`;

export type AppCoreRouteComponents = Readonly<Record<AppCoreRouteId, RouteComponent>>;
export type AppCoreRecipientRouteComponents = Readonly<
  Record<AppCoreRecipientRouteId, RouteComponent>
>;

export interface AppCoreRouteFactoryOptions {
  readonly exclude?: readonly AppCoreRouteId[];
}

export interface AppCoreRecipientRouteFactoryOptions {
  readonly exclude?: readonly AppCoreRecipientRouteId[];
}

function routeKey(id: AppCoreRouteId): AppCoreTanStackRouteKey {
  return `${id}Route`;
}

function recipientRouteKey(id: AppCoreRecipientRouteId): AppCoreRecipientTanStackRouteKey {
  return `${id}Route`;
}

function tanStackRecipientPath(path: string): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, parameter: string) => `$${parameter}`);
}

/**
 * Creates every canonical shared route from an exhaustive host component map.
 *
 * Code-splitting hosts pass TanStack lazy route components here so importing
 * this factory never imports the eager shared screen manifest.
 */
export function createAppCoreRoutesFromComponents<TRootRoute extends AnyRootRoute>(
  rootRoute: TRootRoute,
  components: AppCoreRouteComponents,
  options: AppCoreRouteFactoryOptions = {},
) {
  const excluded = new Set(options.exclude);
  const routes: Partial<Record<AppCoreTanStackRouteKey, AnyRoute>> = {};
  for (const id of APP_CORE_ROUTE_IDS) {
    if (excluded.has(id)) continue;
    const route = APP_CORE_ROUTE_REGISTRY[id];
    routes[routeKey(id)] = createRoute({
      getParentRoute: () => rootRoute,
      path: route.path,
      component: components[id],
    });
  }
  return routes;
}

/** Creates canonical non-shell recipient routes from exhaustive host components. */
export function createAppCoreRecipientRoutesFromComponents<TRootRoute extends AnyRootRoute>(
  rootRoute: TRootRoute,
  components: AppCoreRecipientRouteComponents,
  options: AppCoreRecipientRouteFactoryOptions = {},
) {
  const excluded = new Set(options.exclude);
  const routes: Partial<Record<AppCoreRecipientTanStackRouteKey, AnyRoute>> = {};
  for (const id of APP_CORE_RECIPIENT_ROUTE_IDS) {
    if (excluded.has(id)) continue;
    const route = APP_CORE_RECIPIENT_ROUTE_REGISTRY[id];
    routes[recipientRouteKey(id)] = createRoute({
      getParentRoute: () => rootRoute,
      path: tanStackRecipientPath(route.path),
      component: components[id],
    });
  }
  return routes;
}
