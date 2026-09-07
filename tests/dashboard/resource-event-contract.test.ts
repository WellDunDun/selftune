import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import {
  DashboardUpdateEvent,
  dashboardUpdateResources,
  dashboardUpdateResourcesFromJson,
  databaseLiveResources,
  isDashboardResource,
} from "../../packages/runtime/dashboard-reactivity.js";

describe("dashboard resource event compatibility", () => {
  test("preserves recognized resources beside retired or malformed names", () => {
    const payload = { resources: ["overview", "retired", 42, null, "insights-queue"] };
    expect(dashboardUpdateResources(payload)).toEqual(["overview", "insights-queue"]);
    expect(dashboardUpdateResourcesFromJson(JSON.stringify(payload))).toEqual([
      "overview",
      "insights-queue",
    ]);
    expect(isDashboardResource("overview")).toBe(true);
    expect(isDashboardResource("retired")).toBe(false);
  });

  test.each([
    { label: "null", payload: null },
    { label: "missing resources", payload: {} },
    { label: "empty resources", payload: { resources: [] } },
    { label: "unknown resources", payload: { resources: ["retired"] } },
    { label: "non-array resources", payload: { resources: "overview" } },
  ])("retains broad invalidation for $label", ({ payload }) => {
    expect(dashboardUpdateResources(payload)).toEqual([...databaseLiveResources]);
    expect(dashboardUpdateResourcesFromJson(JSON.stringify(payload))).toEqual([
      ...databaseLiveResources,
    ]);
  });

  test("falls back for invalid JSON and validates emitted event contracts", () => {
    expect(dashboardUpdateResourcesFromJson("{")).toEqual([...databaseLiveResources]);
    expect(dashboardUpdateResourcesFromJson(42)).toEqual([...databaseLiveResources]);
    const decode = Schema.decodeUnknownSync(DashboardUpdateEvent);
    expect(decode({ type: "update", ts: 1, resources: ["overview"] })).toEqual({
      type: "update",
      ts: 1,
      resources: ["overview"],
    });
    expect(() => decode({ type: "update", ts: "now", resources: ["overview"] })).toThrow();
    expect(() => decode({ type: "update", ts: 1, resources: ["retired"] })).toThrow();
  });
});
