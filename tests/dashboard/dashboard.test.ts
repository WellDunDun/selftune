import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DASHBOARD_CLI_PATH = join(import.meta.dir, "..", "..", "cli", "selftune", "dashboard.ts");

describe("cli/selftune/dashboard.ts", () => {
  it("module exists", () => {
    expect(existsSync(DASHBOARD_CLI_PATH)).toBe(true);
  });

  it("documents the SPA server workflow", () => {
    const src = readFileSync(DASHBOARD_CLI_PATH, "utf-8");
    expect(src).toContain("Start the local React SPA dashboard server");
    expect(src).toContain("--no-open");
    expect(src).not.toContain("buildEmbeddedHTML");
    expect(src).not.toContain("dashboard/index.html");
  });

  it("rejects the removed legacy export mode explicitly", () => {
    const src = readFileSync(DASHBOARD_CLI_PATH, "utf-8");
    expect(src).toContain("Legacy dashboard export was removed.");
  });
});
