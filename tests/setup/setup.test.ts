import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createDefaultCliSetupCapabilities,
  type ScheduleManager,
  type SetupCapabilities,
} from "../../packages/orchestration/src/setup/capabilities.js";
import { convergeSetup } from "../../packages/orchestration/src/setup/converge.js";
import {
  inspectSetupState,
  type SetupEnvironment,
} from "../../packages/orchestration/src/setup/inspect.js";
import { defaultSetupPlan } from "../../packages/orchestration/src/setup/plan.js";
import { migrateLegacyOnboardingPreferences } from "../../packages/orchestration/src/setup/preferences.js";
import { buildInstallPlan, selectInstallFormat } from "../../packages/runtime/scheduling.js";
import type { SyncResult } from "../../packages/source-management/src/sync.js";
import type { SelftuneConfig } from "../../packages/runtime/types.js";

let temporaryDirectory: string;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "selftune-setup-"));
});

afterEach(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function syncResult(synced: number): SyncResult {
  return {
    since: null,
    dry_run: false,
    sources: {
      claude: { available: true, scanned: synced, synced, skipped: 0 },
      codex: { available: false, scanned: 0, synced: 0, skipped: 0 },
      opencode: { available: false, scanned: 0, synced: 0, skipped: 0 },
      openclaw: { available: false, scanned: 0, synced: 0, skipped: 0 },
      pi: { available: false, scanned: 0, synced: 0, skipped: 0 },
    },
    repair: {
      ran: true,
      repaired_sessions: 0,
      repaired_records: 0,
      codex_repaired_records: 0,
    },
    creator_contributions: {
      ran: true,
      eligible_skills: 0,
      built_signals: 0,
      staged_signals: 0,
    },
    timings: [],
    total_elapsed_ms: 1,
  };
}

function filesystemScheduleManager(): ScheduleManager {
  return {
    install: ({ format, homeDir }) => {
      const selected = selectInstallFormat(format, "linux");
      if (!selected.ok) throw new Error(selected.error);
      const installPlan = buildInstallPlan(selected.format, homeDir);
      for (const artifact of installPlan.artifacts) {
        mkdirSync(dirname(artifact.path), { recursive: true });
        writeFileSync(artifact.path, artifact.content, "utf8");
      }
      return {
        ok: true,
        changed: true,
        format: selected.format,
        activated: true,
        files: installPlan.artifacts.map((artifact) => artifact.path),
      };
    },
  };
}

function setupPlan() {
  return defaultSetupPlan({
    agentOverride: "claude_code",
    cliPathOverride: "/test/selftune",
    config: {
      agent_type: "claude_code",
      cli_path: "/test/selftune",
      llm_mode: "agent",
      agent_cli: "claude",
      hooks_installed: false,
      initialized_at: "2026-07-18T00:00:00.000Z",
    },
    agentFiles: true,
    hookHarnesses: ["claude_code"],
    scheduleEnabled: true,
    scheduleFormat: "systemd",
    sourceSync: true,
  });
}

describe("setup convergence", () => {
  test("migrates legacy onboarding preferences once and removes the old file", async () => {
    const configDir = join(temporaryDirectory, ".selftune");
    const configPath = join(configDir, "config.json");
    const onboardingPath = join(configDir, "onboarding.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        agent_type: "codex",
        cli_path: "/test/selftune",
        llm_mode: "agent",
        agent_cli: "codex",
        hooks_installed: false,
        initialized_at: "2026-07-18T00:00:00.000Z",
      }),
    );
    writeFileSync(
      onboardingPath,
      JSON.stringify({
        version: 1,
        completed: true,
        import_sources: { codex: true, pi: false },
        hook_harnesses: { codex: true },
        features: {
          observability: false,
          health_recommendations: true,
          autonomous_improvement: true,
        },
      }),
    );

    expect(await migrateLegacyOnboardingPreferences({ configDir, configPath })).toMatchObject({
      legacyFound: true,
      migrated: true,
    });
    const migrated = JSON.parse(readFileSync(configPath, "utf8"));
    expect(migrated.preferences.import_sources.codex).toBe(true);
    expect(migrated.preferences.import_sources.pi).toBe(false);
    expect(migrated.preferences.features.autonomous_improvement).toBe(true);
    expect(migrated.preferences).not.toHaveProperty("hook_harnesses");
    expect(existsSync(onboardingPath)).toBe(false);

    writeFileSync(
      onboardingPath,
      JSON.stringify({
        version: 1,
        import_sources: { codex: false },
        features: { autonomous_improvement: false },
      }),
    );
    expect(await migrateLegacyOnboardingPreferences({ configDir, configPath })).toMatchObject({
      legacyFound: true,
      migrated: true,
      preferences: migrated.preferences,
    });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(migrated);
    expect(existsSync(onboardingPath)).toBe(false);

    expect(await migrateLegacyOnboardingPreferences({ configDir, configPath })).toEqual({
      legacyFound: false,
      migrated: false,
    });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(migrated);
  });

  test("converge folds legacy preferences while creating config", async () => {
    const configDir = join(temporaryDirectory, ".selftune");
    const configPath = join(configDir, "config.json");
    const onboardingPath = join(configDir, "onboarding.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      onboardingPath,
      JSON.stringify({
        version: 1,
        import_sources: { claude_code: false, codex: true },
        features: {
          observability: true,
          health_recommendations: false,
          autonomous_improvement: false,
        },
      }),
    );

    const results = await convergeSetup(
      defaultSetupPlan({ agentOverride: "codex", cliPathOverride: "/test/selftune" }),
      { hooks: {} },
      { configDir, configPath, homeDir: temporaryDirectory, which: () => null },
    );

    expect(results.find((result) => result.step === "config")?.status).toBe("applied");
    expect(JSON.parse(readFileSync(configPath, "utf8")).preferences.import_sources.codex).toBe(
      true,
    );
    expect(existsSync(onboardingPath)).toBe(false);
  });

  test("inspect is read-only for a fresh environment", async () => {
    const configPath = join(temporaryDirectory, ".selftune", "config.json");

    const state = await inspectSetupState({
      agentOverride: "claude_code",
      configPath,
      homeDir: temporaryDirectory,
      platform: "linux",
      scheduleActive: () => true,
      scheduleFormat: "systemd",
      which: () => null,
    });

    expect(state.config).toBeNull();
    expect(state.agentType).toBe("claude_code");
    expect(state.harnesses.claude_code.hooksInstalled).toBe(false);
    expect(state.agentFilesInstalled).toBe(false);
    expect(state.schedule.installed).toBe(false);
  });

  test("applies fresh state and reports every step satisfied on immediate re-converge", async () => {
    const configPath = join(temporaryDirectory, ".selftune", "config.json");
    let syncCalls = 0;
    const defaults = createDefaultCliSetupCapabilities({
      homeDir: temporaryDirectory,
      sourceSync: async () => syncResult(syncCalls++ === 0 ? 1 : 0),
    });
    const capabilities: SetupCapabilities = {
      ...defaults,
      schedule: filesystemScheduleManager(),
    };
    const plan = setupPlan();
    const environment: SetupEnvironment = {
      configPath,
      homeDir: temporaryDirectory,
      platform: "linux",
      scheduleActive: () => true,
      which: () => null,
    };

    const first = await convergeSetup(plan, capabilities, environment);
    expect(first.map(({ step, status }) => ({ step, status }))).toEqual([
      { step: "config", status: "applied" },
      { step: "agent_files", status: "applied" },
      { step: "hooks:claude_code", status: "applied" },
      { step: "source_sync", status: "applied" },
      { step: "schedule", status: "applied" },
    ]);

    const state = await inspectSetupState({ ...environment, scheduleFormat: "systemd" });
    expect(state.config?.hooks_installed).toBe(true);
    expect(state.harnesses.claude_code.hooksInstalled).toBe(true);
    expect(state.agentFilesInstalled).toBe(true);
    expect(state.schedule.installed).toBe(true);

    const second = await convergeSetup(plan, capabilities, environment);
    expect(second.map(({ step, status }) => ({ step, status }))).toEqual([
      { step: "config", status: "satisfied" },
      { step: "agent_files", status: "satisfied" },
      { step: "hooks:claude_code", status: "satisfied" },
      { step: "source_sync", status: "satisfied" },
      { step: "schedule", status: "satisfied" },
    ]);
  });

  test("records a failed capability and continues later independent steps", async () => {
    const configPath = join(temporaryDirectory, ".selftune", "config.json");
    const defaults = createDefaultCliSetupCapabilities({
      homeDir: temporaryDirectory,
      sourceSync: async () => syncResult(1),
    });
    const capabilities: SetupCapabilities = {
      ...defaults,
      hooks: {
        ...defaults.hooks,
        claude_code: () => ({
          ok: false,
          changed: false,
          message: "hook installer unavailable",
        }),
      },
      schedule: filesystemScheduleManager(),
    };

    const results = await convergeSetup(setupPlan(), capabilities, {
      configPath,
      homeDir: temporaryDirectory,
      platform: "linux",
      scheduleActive: () => true,
      which: () => null,
    });

    expect(results.find((result) => result.step === "hooks:claude_code")).toEqual({
      step: "hooks:claude_code",
      status: "failed",
      message: "hook installer unavailable",
    });
    expect(results.find((result) => result.step === "source_sync")?.status).toBe("applied");
    expect(results.find((result) => result.step === "schedule")?.status).toBe("applied");
  });

  test("maps a successful no-change installer outcome to satisfied", async () => {
    const configPath = join(temporaryDirectory, ".selftune", "config.json");
    const defaults = createDefaultCliSetupCapabilities({ homeDir: temporaryDirectory });
    const capabilities: SetupCapabilities = {
      ...defaults,
      hooks: {
        ...defaults.hooks,
        cline: () => ({ ok: true, changed: false, message: "Already installed." }),
      },
    };

    const results = await convergeSetup(
      defaultSetupPlan({ hookHarnesses: ["cline"], writeConfig: false }),
      capabilities,
      {
        configPath,
        homeDir: temporaryDirectory,
        platform: "linux",
        scheduleActive: () => true,
        which: () => null,
      },
    );

    expect(results.find((result) => result.step === "hooks:cline")).toEqual({
      step: "hooks:cline",
      status: "satisfied",
      message: "Already installed.",
    });
  });

  test("force convergence explicitly ignores an invalid existing config during inspection", async () => {
    const configPath = join(temporaryDirectory, ".selftune", "config.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "{invalid", "utf8");
    const desiredConfig: SelftuneConfig = {
      agent_type: "codex",
      cli_path: "/test/selftune",
      llm_mode: "agent",
      agent_cli: "codex",
      hooks_installed: false,
      initialized_at: "2026-07-18T00:00:00.000Z",
    };

    const results = await convergeSetup(
      defaultSetupPlan({
        agentOverride: "codex",
        config: desiredConfig,
        force: true,
      }),
      createDefaultCliSetupCapabilities({ homeDir: temporaryDirectory }),
      {
        configPath,
        homeDir: temporaryDirectory,
        platform: "linux",
        scheduleActive: () => true,
        which: () => null,
      },
    );

    expect(results.find((result) => result.step === "config")?.status).toBe("applied");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(desiredConfig);
  });
});
