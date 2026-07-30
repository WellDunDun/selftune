// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardApiError, fetchCloudBillingStatus } from "./api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dashboard API response boundary", () => {
  it("turns a plain-text missing sidecar route into an actionable typed error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await expect(fetchCloudBillingStatus()).rejects.toMatchObject({
      name: "DashboardApiError",
      code: "ROUTE_NOT_FOUND",
      message: "The Desktop service is out of date. Restart SelfTune Desktop and try again.",
      status: 404,
    } satisfies Partial<DashboardApiError>);
  });
});
