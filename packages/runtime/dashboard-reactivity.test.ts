import { describe, expect, it } from "bun:test";

import { DashboardResource } from "./dashboard-reactivity.js";

describe("DashboardResource", () => {
  it("uses host-independent product and data vocabulary", () => {
    for (const resource of Object.values(DashboardResource)) {
      expect(resource).not.toMatch(/local|cloud|selfhost|desktop/i);
    }
  });
});
