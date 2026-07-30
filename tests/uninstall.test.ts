import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

import type { ServiceBackend } from "@selftune/local/service";
import { removeHooksFromSettings, removeRuntimeService } from "../apps/cli/src/commands/uninstall";

let temporaryDirectory: string | undefined;

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

function serviceBackend(automated: boolean, events: string[]): ServiceBackend {
  const platform = automated ? "darwin" : "unsupported";
  return {
    automated,
    platform,
    install: () => Effect.succeed(undefined),
    restart: () => Effect.succeed(undefined),
    start: () => Effect.succeed(undefined),
    status: () =>
      Effect.succeed({
        detail: [],
        pid: null,
        platform,
        registered: automated,
        running: false,
      }),
    stop: () => Effect.succeed(undefined),
    uninstall: () =>
      Effect.sync(() => {
        events.push("service-unregistered");
      }),
  };
}

describe("uninstall runtime shutdown", () => {
  test("stops a standalone manifest-owned runtime without an OS service", async () => {
    const events: string[] = [];
    const result = await Effect.runPromise(
      removeRuntimeService(false, {
        backend: serviceBackend(false, events),
        configDir: "/tmp/selftune-standalone-test",
        stopRuntime: () =>
          Effect.sync(() => {
            events.push("runtime-exited");
            return true;
          }),
      }),
    );

    expect(events).toEqual(["runtime-exited"]);
    expect(result.removed).toBe(true);
    expect(result.details).toContain("Stopped the manifest-owned local runtime");
  });

  test("routes automated service removal through guarded orchestration", async () => {
    const events: string[] = [];
    let receivedConfigDir: string | undefined;
    const result = await Effect.runPromise(
      removeRuntimeService(false, {
        backend: serviceBackend(true, events),
        configDir: "/tmp/selftune-supervised-test",
        runServiceUninstall: (descriptor) =>
          Effect.sync(() => {
            receivedConfigDir = descriptor.configDir;
            events.push("service-command-uninstall");
          }),
        stopRuntime: () =>
          Effect.sync(() => {
            events.push("runtime-exited");
            return true;
          }),
      }),
    );

    expect(receivedConfigDir).toBe("/tmp/selftune-supervised-test");
    expect(events).toEqual(["service-command-uninstall"]);
    expect(events).not.toContain("service-unregistered");
    expect(result.removed).toBe(true);
    expect(result.details).toContain("Unregistered the darwin service");
  });

  test("reports automated service removal without mutating during dry run", async () => {
    const events: string[] = [];
    const result = await Effect.runPromise(
      removeRuntimeService(true, {
        backend: serviceBackend(true, events),
        configDir: "/tmp/selftune-dry-run-test",
        runServiceUninstall: () =>
          Effect.sync(() => {
            events.push("service-command-uninstall");
          }),
        stopRuntime: () =>
          Effect.sync(() => {
            events.push("runtime-exited");
            return true;
          }),
      }),
    );

    expect(events).toEqual([]);
    expect(result.removed).toBe(false);
    expect(result.details).toContain("Would unregister the darwin service");
  });
});

describe("uninstall hook cleanup", () => {
  test("removes compiled and legacy SelfTune hooks while preserving user hooks", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "selftune-uninstall-"));
    const settingsPath = join(temporaryDirectory, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [{ command: "'/Applications/SelfTune.app/runtime/selftune' hook prompt-log" }],
            },
            { command: "bun /repo/cli/selftune/hooks/auto-activate.ts" },
            { command: "user-owned-hook --keep" },
          ],
        },
      }),
    );

    const result = removeHooksFromSettings(false, settingsPath);

    expect(result.removed).toBe(2);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      hooks: { UserPromptSubmit: [{ command: "user-owned-hook --keep" }] },
    });
  });
});
