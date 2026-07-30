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

const SELF_HOST_CAPABILITIES: Capabilities = {
  ...LOCAL_CAPABILITIES,
  host: "selfhost",
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
    expect(byId.get("analytics")?.path).toBe("/insights");
  });

  it("keeps status local-only and enables the cloud coordination modules in cloud", () => {
    const routes = resolveDashboardRoutes("cloud", CLOUD_CAPABILITIES);
    const byId = new Map(routes.map((route) => [route.id, route]));

    expect(byId.get("signals")?.access).toBe("enabled");
    expect(byId.get("proposals")?.access).toBe("enabled");
    expect(byId.get("registry")?.access).toBe("enabled");
    expect(byId.get("unmatched")?.access).toBe("enabled");
    expect(byId.get("settings")?.access).toBe("enabled");
    expect(byId.has("status")).toBe(false);
  });

  it("exposes the Remote Library and Skill Sets to Self-host navigation and search", () => {
    const routes = resolveDashboardRoutes("selfhost", SELF_HOST_CAPABILITIES);
    const byId = new Map(routes.map((route) => [route.id, route]));

    expect(routes.map((route) => route.id)).toEqual(["skills", "projects"]);
    expect(byId.get("skills")).toMatchObject({
      access: "enabled",
      path: "/skills",
      label: "Skills",
      title: "Remote Library",
    });
    expect(byId.get("projects")).toMatchObject({
      access: "enabled",
      path: "/projects",
      label: "Skill Sets",
      title: "Skill Sets",
    });
  });
});
