import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveInitialDashboardPath } from "./initial-path";

describe("desktop initial path", () => {
  test.each([
    '{"preferences":[]}',
    '{"preferences":null}',
    '{"preferences":"completed"}',
    "null",
    "[invalid",
  ])("invalid preference markers do not skip onboarding: %s", (contents) => {
    const configDir = mkdtempSync(join(tmpdir(), "selftune-desktop-path-"));
    try {
      writeFileSync(join(configDir, "config.json"), contents);
      expect(resolveInitialDashboardPath({ configDir })).toBe("/settings");
      writeFileSync(join(configDir, "onboarding.json"), '{"completed":true}');
      expect(resolveInitialDashboardPath({ configDir })).toBe("/");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("opens onboarding until config contains preferences", () => {
    const configDir = mkdtempSync(join(tmpdir(), "selftune-desktop-path-"));
    try {
      expect(resolveInitialDashboardPath({ configDir })).toBe("/settings");
      writeFileSync(join(configDir, "config.json"), '{"preferences":{"features":{}}}\n');
      expect(resolveInitialDashboardPath({ configDir })).toBe("/");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("honors legacy completed onboarding.json before migration runs", () => {
    const configDir = mkdtempSync(join(tmpdir(), "selftune-desktop-path-"));
    try {
      writeFileSync(join(configDir, "onboarding.json"), '{"version":1,"completed":true}\n');
      expect(resolveInitialDashboardPath({ configDir })).toBe("/");
      writeFileSync(join(configDir, "onboarding.json"), '{"version":1,"completed":false}\n');
      expect(resolveInitialDashboardPath({ configDir })).toBe("/settings");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("preserves explicit screenshot and test routes", () => {
    expect(resolveInitialDashboardPath({ testPath: "/settings" })).toBe("/settings");
  });
});
