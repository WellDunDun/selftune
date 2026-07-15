import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveInitialDashboardPath } from "./initial-path";

describe("desktop initial path", () => {
  test("opens onboarding until a preference file exists", () => {
    const configDir = mkdtempSync(join(tmpdir(), "selftune-desktop-path-"));
    try {
      expect(resolveInitialDashboardPath({ configDir })).toBe("/settings");
      writeFileSync(join(configDir, "onboarding.json"), '{"version":1,"completed":true}\n');
      expect(resolveInitialDashboardPath({ configDir })).toBe("/");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("preserves explicit screenshot and test routes", () => {
    expect(resolveInitialDashboardPath({ testPath: "/settings" })).toBe("/settings");
  });
});
