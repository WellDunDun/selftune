import type { AnyRootRoute, AnyRoute } from "@tanstack/react-router";

import {
  APP_CORE_RECIPIENT_ROUTE_COMPONENTS,
  APP_CORE_ROUTE_COMPONENTS,
  type AppCoreRecipientRouteComposition,
  type AppCoreRouteComposition,
} from "./manifest";
import {
  createAppCoreRecipientRoutesFromComponents,
  createAppCoreRoutesFromComponents,
} from "./route-factory";

/** Canonical non-shell recipient routes; hosts opt in explicitly. */
export function createAppCoreRecipientRoutes<TRootRoute extends AnyRootRoute>(
  rootRoute: TRootRoute,
  composition: AppCoreRecipientRouteComposition = {},
) {
  return createAppCoreRecipientRoutesFromComponents(rootRoute, {
    ...APP_CORE_RECIPIENT_ROUTE_COMPONENTS,
    ...composition.replace,
  });
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
  return createAppCoreRoutesFromComponents(
    rootRoute,
    {
      ...APP_CORE_ROUTE_COMPONENTS,
      ...composition.replace,
    },
    { exclude: composition.exclude },
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
