# @selftune/app-core

Canonical selftune application routes and screens shared by Desktop and Cloud. The package is a
plain-data React/TanStack layer: it imports no auth SDK, transport client, database code, or Effect.

Hosts own their root route, authentication, organization context, and runtime adapter. They compose
the shared route source and declare any divergence explicitly:

```tsx
import { AppCoreHostProvider, appendAppHostRoutes, createAppCoreRoutes } from "@selftune/app-core";
import { createRootRoute, createRoute, Outlet } from "@tanstack/react-router";

const rootRoute = createRootRoute({
  component: () => (
    <AppCoreHostProvider adapter={cloudAdapter}>
      <CloudAuthAndOrganizationShell>
        <Outlet />
      </CloudAuthAndOrganizationShell>
    </AppCoreHostProvider>
  ),
});

const sharedRoutes = createAppCoreRoutes(rootRoute, {
  exclude: [],
  replace: {},
});
const billingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/billing",
  component: BillingScreen,
});

export const routeTree = rootRoute.addChildren(appendAppHostRoutes(sharedRoutes, { billingRoute }));
```

Hosts that use a different router import the dependency-neutral shell model and screen manifest
through subpath exports. This keeps navigation labels, header titles, paths, and active matching
canonical without loading TanStack Router:

```ts
import { APP_CORE_ROUTE_MANIFEST } from "@selftune/app-core/manifest";
import { APP_CORE_SHELL_NAVIGATION } from "@selftune/app-core/shell";
```

Import `@selftune/app-core/styles.css` once from each host entrypoint to use the same visual tokens,
Tailwind source set, and Desktop-safe chrome foundation.
