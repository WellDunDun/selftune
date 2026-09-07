import { describe, expect, it } from "vitest";

import type { Capabilities } from "../host/capabilities";
import { resolveDashboardRoutes } from "./manifest";

const LOCAL_CAPABILITIES: Capabilities = {
  host: "local",
  plan: "oss",
  features: {
    analytics: true,
    registry: false,
    signals: false,
    proposals: false,
    billing: false,
    teamAdmin: false,
    runtimeStatus: true,
  },
  discoverable: {
    registry: true,
    signals: true,
    proposals: true,
    billing: false,
  },
};

const CLOUD_CAPABILITIES: Capabilities = {
  host: "cloud",
  plan: "team",
  features: {
    analytics: true,
    registry: true,
    signals: true,
    proposals: true,
    billing: true,
    teamAdmin: false,
    runtimeStatus: false,
  },
  discoverable: {
    registry: true,
    signals: true,
    proposals: true,
    billing: true,
  },
};

describe("resolveDashboardRoutes", () => {
  it("keeps signals, proposals, and registry as locked host-only cloud modules in local", () => {
    const routes = resolveDashboardRoutes("local", LOCAL_CAPABILITIES);
    const byId = new Map(routes.map((route) => [route.id, route]));

    expect(byId.get("signals")?.access).toBe("locked");
    expect(byId.get("proposals")?.access).toBe("locked");
    expect(byId.get("registry")?.access).toBe("locked");
    expect(byId.get("status")?.access).toBe("enabled");
    expect(byId.has("unmatched")).toBe(false);
    expect(byId.get("settings")?.access).toBe("enabled");
    expect(byId.get("projects")?.path).toBe("/projects");
    expect(byId.get("projects")?.label).toBe("Skill Sets");
    expect(byId.get("projects")?.title).toBe("Skill Sets");
    expect(byId.get("collaboration")?.path).toBe("/collaboration");
    expect(byId.get("collaboration")?.access).toBe("enabled");
    expect(byId.get("analytics")?.path).toBe("/insights");
  });

  it("does not project retired cloud product routes into the managed Cloud host", () => {
    const routes = resolveDashboardRoutes("cloud", CLOUD_CAPABILITIES);
    const byId = new Map(routes.map((route) => [route.id, route]));

    expect(byId.get("signals")?.access).toBe("enabled");
    expect(byId.get("collaboration")?.path).toBe("/collaboration");
    expect(byId.get("collaboration")?.access).toBe("enabled");
    expect(byId.get("settings")?.access).toBe("enabled");
    expect(byId.has("status")).toBe(false);
    expect(
      (["registry", "improve", "proposals", "unmatched", "analytics"] as const).filter((id) =>
        byId.has(id),
      ),
    ).toEqual([]);
  });
});
