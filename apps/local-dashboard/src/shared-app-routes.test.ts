import { describe, expect, it } from "vitest";

import { APP_CORE_ROUTE_MANIFEST, APP_CORE_ROUTES } from "@selftune/app-core/manifest";
import { APP_CORE_ROUTE_REGISTRY, APP_CORE_SHELL_NAVIGATION } from "@selftune/app-core/shell";

import {
  composeLocalPrimaryRoutes,
  getLocalAppCoreNavigation,
  isLocalAppCoreRouteActive,
  LOCAL_APP_CORE_NAVIGATION,
  LOCAL_APP_CORE_ROUTE_MANIFEST,
  LOCAL_APP_CORE_ROUTE_REGISTRY,
  LOCAL_APP_CORE_ROUTES,
  matchLocalAppCoreShellRoute,
} from "./shared-app-routes";

describe("Local app-core composition", () => {
  it("mounts every canonical app-core route and screen entry without copying them", () => {
    expect(LOCAL_APP_CORE_ROUTES).toBe(APP_CORE_ROUTES);
    expect(LOCAL_APP_CORE_ROUTE_MANIFEST).toBe(APP_CORE_ROUTE_MANIFEST);
    expect(Object.values(LOCAL_APP_CORE_ROUTES)).toEqual(APP_CORE_ROUTE_MANIFEST);
  });

  it("consumes canonical shared navigation, path matching, and headers", () => {
    expect(LOCAL_APP_CORE_NAVIGATION).toBe(APP_CORE_SHELL_NAVIGATION);
    expect(LOCAL_APP_CORE_ROUTE_REGISTRY).toBe(APP_CORE_ROUTE_REGISTRY);
    for (const entry of APP_CORE_SHELL_NAVIGATION) {
      expect(getLocalAppCoreNavigation(entry.id)).toBe(entry);
      expect(isLocalAppCoreRouteActive(`${entry.path}/detail`, entry.id)).toBe(true);
      expect(matchLocalAppCoreShellRoute(entry.path)?.header.title).toBeTruthy();
    }
  });

  it("lets app-core own shared primary-route inclusion and order", () => {
    const routes = composeLocalPrimaryRoutes([
      { id: "settings", path: "/old-settings", label: "Settings", tooltip: "Settings" },
      { id: "projects", path: "/old-projects", label: "Old projects", tooltip: "Old" },
      { id: "plugins", path: "/plugins", label: "Plugins", tooltip: "Plugins" },
      { id: "skills", path: "/old-skills", label: "Old skills", tooltip: "Old" },
      { id: "collaboration", path: "/old-team", label: "Old team", tooltip: "Old" },
      { id: "registry", path: "/registry", label: "Registry", tooltip: "Registry" },
      { id: "analytics", path: "/insights", label: "Analytics", tooltip: "Analytics" },
    ]);

    const expected: string[] = APP_CORE_SHELL_NAVIGATION.map(({ id }) => id);
    expected.splice(expected.indexOf("projects") + 1, 0, "plugins");
    expect(routes.map(({ id }) => id)).toEqual([...expected, "settings", "analytics"]);
    for (const navigation of APP_CORE_SHELL_NAVIGATION) {
      expect(routes.find(({ id }) => id === navigation.id)).toMatchObject(navigation);
    }
  });
});
