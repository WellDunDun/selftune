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
  it("redirects config, log, claude, and openclaw paths via subprocess", async () => {
    // We run a small inline script that imports constants and prints them.
    // This ensures the env vars are set BEFORE the module evaluates.
    const script = `
      const c = await import("./cli/selftune/constants.js");
      console.log(JSON.stringify({
        configDir: c.SELFTUNE_CONFIG_DIR,
        logDir: c.LOG_DIR,
        telemetryLog: c.TELEMETRY_LOG,
        configPath: c.SELFTUNE_CONFIG_PATH,
        claudeSettingsPath: c.CLAUDE_SETTINGS_PATH,
        claudeProjectsDir: c.CLAUDE_CODE_PROJECTS_DIR,
        claudeMarker: c.CLAUDE_CODE_MARKER,
        codexMarker: c.CODEX_INGEST_MARKER,
        opencodeMarker: c.OPENCODE_INGEST_MARKER,
        openclawAgentsDir: c.OPENCLAW_AGENTS_DIR,
      }));
    `;

    const cleanEnv = { ...process.env };
    delete cleanEnv.SELFTUNE_CONFIG_DIR;
    delete cleanEnv.SELFTUNE_LOG_DIR;
    cleanEnv.SELFTUNE_HOME = store.root;

    const result = Bun.spawnSync(["bun", "-e", script], {
      env: cleanEnv,
      cwd: process.cwd(),
    });

    if (result.exitCode !== 0) {
      throw new Error(`Subprocess failed: ${result.stderr.toString()}`);
    }

    const stdout = result.stdout.toString().trim();
    expect(stdout.length).toBeGreaterThan(0);

    const paths = JSON.parse(stdout);
    expect(paths.configDir).toBe(`${store.root}/.selftune`);
    expect(paths.logDir).toBe(`${store.root}/.claude`);
    expect(paths.telemetryLog).toContain(`${store.root}/.claude/`);
    expect(paths.configPath).toContain(`${store.root}/.selftune/`);
    expect(paths.claudeSettingsPath).toBe(`${store.root}/.claude/settings.json`);
    expect(paths.claudeProjectsDir).toBe(`${store.root}/.claude/projects`);
    expect(paths.claudeMarker).toBe(`${store.root}/.claude/claude_code_ingested_sessions.json`);
    expect(paths.codexMarker).toBe(`${store.root}/.claude/codex_ingested_rollouts.json`);
    expect(paths.opencodeMarker).toBe(`${store.root}/.claude/opencode_ingested_sessions.json`);
    expect(paths.openclawAgentsDir).toBe(`${store.root}/.openclaw/agents`);
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

    if (result.exitCode !== 0) {
      throw new Error(`Subprocess failed: ${result.stderr.toString()}`);
    }

    const paths = JSON.parse(result.stdout.toString().trim());
    expect(paths.configDir).toBe(customConfig);
    expect(paths.logDir).toBe(customLog);
  });
});
