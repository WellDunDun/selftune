import { describe, expect, test } from "bun:test";

import { dashboardPathForRebind } from "./rebind-path";

describe("dashboardPathForRebind", () => {
  test("preserves the active route while the local origin changes", () => {
    expect(
      dashboardPathForRebind(
        "http://127.0.0.1:63001/settings?tab=automation#schedule",
        "http://127.0.0.1:63001",
      ),
    ).toBe("/settings?tab=automation#schedule");
  });

  test("falls back to the dashboard root for untrusted or missing origins", () => {
    expect(dashboardPathForRebind("https://example.com/settings", "http://127.0.0.1:63001")).toBe(
      "/",
    );
    expect(dashboardPathForRebind("data:text/html,crash", null)).toBe("/");
  });
});
