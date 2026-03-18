/**
 * Tests that SELFTUNE_HOME redirects all derived paths correctly.
 *
 * Because constants.ts evaluates at import time, we must spawn a
 * subprocess with the env vars set rather than mutating process.env
 * after import.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createIsolatedStore, type IsolatedStore } from "../helpers/isolated-store.js";

let store: IsolatedStore;

beforeAll(() => {
  store = createIsolatedStore();
});

afterAll(() => {
  store.cleanup();
});

describe("SELFTUNE_HOME environment override", () => {
  it("redirects SELFTUNE_CONFIG_DIR and LOG_DIR via subprocess", async () => {
    // We run a small inline script that imports constants and prints them.
    // This ensures the env vars are set BEFORE the module evaluates.
    const script = `
      const c = await import("./cli/selftune/constants.js");
      console.log(JSON.stringify({
        configDir: c.SELFTUNE_CONFIG_DIR,
        logDir: c.LOG_DIR,
        telemetryLog: c.TELEMETRY_LOG,
        configPath: c.SELFTUNE_CONFIG_PATH,
      }));
    `;

    const result = Bun.spawnSync(["bun", "-e", script], {
      env: {
        ...process.env,
        SELFTUNE_HOME: store.root,
        // Clear specific overrides so SELFTUNE_HOME takes effect
        SELFTUNE_CONFIG_DIR: undefined,
        SELFTUNE_LOG_DIR: undefined,
      },
      cwd: process.cwd(),
    });

    const stdout = result.stdout.toString().trim();
    expect(stdout.length).toBeGreaterThan(0);

    const paths = JSON.parse(stdout);
    expect(paths.configDir).toBe(`${store.root}/.selftune`);
    expect(paths.logDir).toBe(`${store.root}/.claude`);
    expect(paths.telemetryLog).toContain(`${store.root}/.claude/`);
    expect(paths.configPath).toContain(`${store.root}/.selftune/`);
  });

  it("specific overrides take precedence over SELFTUNE_HOME", async () => {
    const script = `
      const c = await import("./cli/selftune/constants.js");
      console.log(JSON.stringify({
        configDir: c.SELFTUNE_CONFIG_DIR,
        logDir: c.LOG_DIR,
      }));
    `;

    const customConfig = `${store.root}/custom-config`;
    const customLog = `${store.root}/custom-log`;

    const result = Bun.spawnSync(["bun", "-e", script], {
      env: {
        ...process.env,
        SELFTUNE_HOME: "/should/be/ignored",
        SELFTUNE_CONFIG_DIR: customConfig,
        SELFTUNE_LOG_DIR: customLog,
      },
      cwd: process.cwd(),
    });

    const paths = JSON.parse(result.stdout.toString().trim());
    expect(paths.configDir).toBe(customConfig);
    expect(paths.logDir).toBe(customLog);
  });
});
