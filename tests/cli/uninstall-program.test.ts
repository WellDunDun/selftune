import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DaemonFailure } from "@selftune/local/daemon";
import { ServiceFailure } from "@selftune/local/service";
import { CredentialStore, CredentialStoreFailure } from "@selftune/runtime/credential-store";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { UninstallDependencies } from "../../apps/cli/src/commands/uninstall/dependencies";
import { UninstallCleanupFailure } from "../../apps/cli/src/commands/uninstall/errors";
import { makeUninstallDependenciesLive } from "../../apps/cli/src/commands/uninstall/live-dependencies";
import { planUninstall } from "../../apps/cli/src/commands/uninstall/planning";
import { runUninstallProgram } from "../../apps/cli/src/commands/uninstall/program";

describe("uninstall planning", () => {
  test("preserves the cleanup order and represents optional work as explicit skips", () => {
    expect(planUninstall({ dryRun: true, keepLogs: true, npmUninstall: false }).steps).toEqual([
      { id: "service", disposition: "run" },
      { id: "credential", disposition: "run" },
      { id: "schedule", disposition: "run" },
      { id: "hooks", disposition: "run" },
      { id: "agents", disposition: "run" },
      { id: "logs", disposition: "skip" },
      { id: "config", disposition: "run" },
      { id: "markers", disposition: "run" },
      { id: "npm", disposition: "skip" },
    ]);
  });
});

test("the program depends on the neutral contract rather than live platform adapters", () => {
  const source = readFileSync(
    new URL("../../apps/cli/src/commands/uninstall/program.ts", import.meta.url),
    "utf8",
  );

  expect(source).toContain('from "./dependencies.js"');
  expect(source).not.toContain("live-dependencies");
});

test("the compatibility facade does not widen its public type exports", () => {
  const source = readFileSync(
    new URL("../../apps/cli/src/commands/uninstall.ts", import.meta.url),
    "utf8",
  );

  expect(source).toContain("RuntimeServiceRemovalDependencies, UninstallOptions");
  expect(source).not.toMatch(/export type \{[^}]*UninstallResult/);
});

test("the live layer keeps credential-store failure typed and injectable", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "selftune-uninstall-credential-"));
  const failure = CredentialStoreFailure.make({
    operation: "delete",
    provider: "file",
    message: "injected credential deletion failure",
  });
  writeFileSync(
    join(configDir, "remote-library.json"),
    JSON.stringify({
      version: 2,
      url: "https://library.example.com",
      credential: { provider: "file", account: "test-account" },
      preferences: {
        releasedSkills: true,
        drafts: false,
        skillSets: true,
        metadata: true,
        decisionHistory: true,
      },
    }),
  );
  const credentialLayer = Layer.succeed(CredentialStore)({
    delete: () => Effect.fail(failure),
    get: () => Effect.fail(failure),
    set: () => Effect.fail(failure),
  });
  const program = Effect.gen(function* () {
    const dependencies = yield* UninstallDependencies;
    return yield* dependencies.removeRemoteCredential(false);
  }).pipe(
    Effect.provide(makeUninstallDependenciesLive(configDir)),
    Effect.provide(credentialLayer),
  );

  try {
    await expect(Effect.runPromise(program)).rejects.toBe(failure);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

describe("uninstall program", () => {
  test("executes live capabilities in legacy order and preserves the result shape", async () => {
    const events: string[] = [];
    const record = <A>(event: string, result: A) =>
      Effect.sync(() => {
        events.push(event);
        return result;
      });
    const layer = Layer.succeed(UninstallDependencies)({
      removeRuntimeService: (dryRun) =>
        record(`service:${dryRun}`, { removed: true, details: "service" }),
      removeRemoteCredential: (dryRun) =>
        record(`credential:${dryRun}`, { removed: true, details: "credential" }),
      removeScheduling: (dryRun) =>
        record(`schedule:${dryRun}`, { removed: true, details: "schedule" }),
      removeHooks: (dryRun, settingsPath) =>
        record(`hooks:${dryRun}:${settingsPath}`, { removed: 2, details: "hooks" }),
      removeAgents: (dryRun) => record(`agents:${dryRun}`, { removed: 1, files: ["agent"] }),
      removeLogs: (dryRun) => record(`logs:${dryRun}`, { removed: 3, files: ["log"] }),
      removeConfig: (dryRun) => record(`config:${dryRun}`, { removed: true, path: "config" }),
      removeMarkers: (dryRun) => record(`markers:${dryRun}`, { removed: 4, files: ["marker"] }),
      uninstallNpm: (dryRun) => record(`npm:${dryRun}`, { uninstalled: true }),
    });

    const result = await Effect.runPromise(
      runUninstallProgram({
        dryRun: false,
        keepLogs: false,
        npmUninstall: true,
        settingsPath: "/tmp/settings.json",
      }).pipe(Effect.provide(layer)),
    );

    expect(events).toEqual([
      "service:false",
      "credential:false",
      "schedule:false",
      "hooks:false:/tmp/settings.json",
      "agents:false",
      "logs:false",
      "config:false",
      "markers:false",
      "npm:false",
    ]);
    expect(result).toEqual({
      dryRun: false,
      service: { removed: true, details: "service" },
      credential: { removed: true, details: "credential" },
      schedule: { removed: true, details: "schedule" },
      hooks: { removed: 2, details: "hooks" },
      agents: { removed: 1, files: ["agent"] },
      logs: { removed: 3, files: ["log"], skipped: false },
      config: { removed: true, path: "config" },
      markers: { removed: 4, files: ["marker"] },
      npm: { uninstalled: true, skipped: false },
    });
  });

  test("does not invoke optional capabilities when the plan skips them", async () => {
    const events: string[] = [];
    const record = <A>(event: string, result: A) =>
      Effect.sync(() => {
        events.push(event);
        return result;
      });
    const layer = Layer.succeed(UninstallDependencies)({
      removeRuntimeService: () => record("service", { removed: false, details: "service" }),
      removeRemoteCredential: () => record("credential", { removed: false, details: "credential" }),
      removeScheduling: () => record("schedule", { removed: false, details: "schedule" }),
      removeHooks: () => record("hooks", { removed: 0, details: "hooks" }),
      removeAgents: () => record("agents", { removed: 0, files: [] }),
      removeLogs: () => record("logs", { removed: 0, files: [] }),
      removeConfig: () => record("config", { removed: false, path: "config" }),
      removeMarkers: () => record("markers", { removed: 0, files: [] }),
      uninstallNpm: () => record("npm", { uninstalled: false }),
    });

    const result = await Effect.runPromise(
      runUninstallProgram({ dryRun: true, keepLogs: true, npmUninstall: false }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(events).toEqual([
      "service",
      "credential",
      "schedule",
      "hooks",
      "agents",
      "config",
      "markers",
    ]);
    expect(result.logs).toEqual({ removed: 0, skipped: true, files: [] });
    expect(result.npm).toEqual({ uninstalled: false, skipped: true });
  });

  for (const [kind, failure] of [
    ["daemon", DaemonFailure.make({ operation: "stop", message: "runtime ownership changed" })],
    ["service", ServiceFailure.make({ operation: "uninstall", message: "service proof changed" })],
  ] as const) {
    test(`${kind} failures stay typed and short-circuit every later destructive step`, async () => {
      const events: string[] = [];
      const later = <A>(name: string, value: A) =>
        Effect.sync(() => {
          events.push(name);
          return value;
        });
      const layer = Layer.succeed(UninstallDependencies)({
        removeRuntimeService: () =>
          Effect.gen(function* () {
            events.push("service");
            return yield* Effect.fail(failure);
          }),
        removeRemoteCredential: () => later("credential", { removed: true, details: "credential" }),
        removeScheduling: () => later("schedule", { removed: true, details: "schedule" }),
        removeHooks: () => later("hooks", { removed: 1, details: "hooks" }),
        removeAgents: () => later("agents", { removed: 1, files: ["agent"] }),
        removeLogs: () => later("logs", { removed: 1, files: ["log"] }),
        removeConfig: () => later("config", { removed: true, path: "config" }),
        removeMarkers: () => later("markers", { removed: 1, files: ["marker"] }),
        uninstallNpm: () => later("npm", { uninstalled: true }),
      });

      const received = await Effect.runPromise(
        runUninstallProgram({ dryRun: false, keepLogs: false, npmUninstall: true }).pipe(
          Effect.provide(layer),
          Effect.flip,
        ),
      );

      expect(received).toBe(failure);
      expect(received._tag).toBe(failure._tag);
      expect(events).toEqual(["service"]);
    });
  }

  test("credential-store failures stay typed and stop before later cleanup", async () => {
    const failure = CredentialStoreFailure.make({
      operation: "delete",
      provider: "file",
      message: "credential store is unavailable",
    });
    const events: string[] = [];
    const later = <A>(name: string, value: A) =>
      Effect.sync(() => {
        events.push(name);
        return value;
      });
    const layer = Layer.succeed(UninstallDependencies)({
      removeRuntimeService: () =>
        later("service", { removed: true, details: "service unregistered" }),
      removeRemoteCredential: () =>
        Effect.gen(function* () {
          events.push("credential");
          return yield* Effect.fail(failure);
        }),
      removeScheduling: () => later("schedule", { removed: true, details: "schedule" }),
      removeHooks: () => later("hooks", { removed: 0, details: "hooks" }),
      removeAgents: () => later("agents", { removed: 0, files: [] }),
      removeLogs: () => later("logs", { removed: 0, files: [] }),
      removeConfig: () => later("config", { removed: false, path: "config" }),
      removeMarkers: () => later("markers", { removed: 0, files: [] }),
      uninstallNpm: () => later("npm", { uninstalled: false }),
    });

    const received = await Effect.runPromise(
      runUninstallProgram({ dryRun: false, keepLogs: false, npmUninstall: true }).pipe(
        Effect.provide(layer),
        Effect.flip,
      ),
    );

    expect(received).toBe(failure);
    expect(received._tag).toBe("CredentialStoreFailure");
    expect(events).toEqual(["service", "credential"]);
  });

  for (const [failingStep, failure, expectedEvents] of [
    [
      "hooks",
      UninstallCleanupFailure.make({
        operation: "remove-hooks",
        message: "settings file became read-only",
      }),
      ["service", "credential", "schedule", "hooks"],
    ],
    [
      "agents",
      UninstallCleanupFailure.make({
        operation: "remove-agents",
        message: "agent directory became read-only",
      }),
      ["service", "credential", "schedule", "hooks", "agents"],
    ],
  ] as const) {
    test(`${failingStep} filesystem failures stay typed and stop later cleanup`, async () => {
      const events: string[] = [];
      const later = <A>(name: string, value: A) =>
        Effect.sync(() => {
          events.push(name);
          return value;
        });
      const failAt = <A>(name: string, error: UninstallCleanupFailure) =>
        Effect.gen(function* (): Effect.fn.Return<A, UninstallCleanupFailure> {
          events.push(name);
          return yield* Effect.fail(error);
        });
      const layer = Layer.succeed(UninstallDependencies)({
        removeRuntimeService: () => later("service", { removed: true, details: "service" }),
        removeRemoteCredential: () => later("credential", { removed: true, details: "credential" }),
        removeScheduling: () => later("schedule", { removed: true, details: "schedule" }),
        removeHooks: () =>
          failingStep === "hooks"
            ? failAt("hooks", failure)
            : later("hooks", { removed: 0, details: "hooks" }),
        removeAgents: () =>
          failingStep === "agents"
            ? failAt("agents", failure)
            : later("agents", { removed: 0, files: [] }),
        removeLogs: () => later("logs", { removed: 0, files: [] }),
        removeConfig: () => later("config", { removed: false, path: "config" }),
        removeMarkers: () => later("markers", { removed: 0, files: [] }),
        uninstallNpm: () => later("npm", { uninstalled: false }),
      });

      const received = await Effect.runPromise(
        runUninstallProgram({ dryRun: false, keepLogs: false, npmUninstall: true }).pipe(
          Effect.provide(layer),
          Effect.flip,
        ),
      );

      expect(received).toBe(failure);
      expect(received._tag).toBe("UninstallCleanupFailure");
      expect(events).toEqual(expectedEvents);
    });
  }
});
