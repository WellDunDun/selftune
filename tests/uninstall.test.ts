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
  test("removes only SelfTune commands inside mixed hook groups and retains other settings", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "selftune-uninstall-mixed-"));
    const settingsPath = join(temporaryDirectory, "settings.json");
    const userHook = { type: "command", command: "user-owned-hook --keep", timeout: 30 };
    const promptHook = { type: "prompt", prompt: "Check the result" };
    const settings = {
      permissions: { allow: ["Read"] },
      theme: "dark",
      custom: { enabled: true },
      hooks: {
        Stop: [
          {
            matcher: "*",
            timeout: 60,
            hooks: [
              { type: "command", command: "selftune hook session-stop" },
              userHook,
              promptHook,
            ],
          },
        ],
        UserPromptSubmit: [
          { command: "selftune hook prompt-log", matcher: "*", hooks: [userHook] },
        ],
        Notification: [],
      },
    };
    const bytes = JSON.stringify(settings);
    writeFileSync(settingsPath, bytes);
    expect(removeHooksFromSettings(true, settingsPath).removed).toBe(2);
    expect(readFileSync(settingsPath, "utf8")).toBe(bytes);
    expect(removeHooksFromSettings(false, settingsPath).removed).toBe(2);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      ...settings,
      hooks: {
        Stop: [{ matcher: "*", timeout: 60, hooks: [userHook, promptHook] }],
        UserPromptSubmit: [{ matcher: "*", hooks: [userHook] }],
        Notification: [],
      },
    });
    const cleaned = readFileSync(settingsPath, "utf8");
    expect(removeHooksFromSettings(false, settingsPath).removed).toBe(0);
    expect(readFileSync(settingsPath, "utf8")).toBe(cleaned);
  });

  test.each([
    "{",
    "null",
    "[]",
    '{"hooks":false}',
    '{"hooks":{"Stop":{}}}',
    '{"hooks":{"Stop":[{"command":42}]}}',
  ])("preserves malformed settings without attempting hook removal: %s", (bytes) => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "selftune-uninstall-invalid-"));
    const settingsPath = join(temporaryDirectory, "settings.json");
    writeFileSync(settingsPath, bytes);
    expect(removeHooksFromSettings(false, settingsPath)).toEqual({
      removed: 0,
      details: "Failed to parse settings.json",
    });
    expect(readFileSync(settingsPath, "utf8")).toBe(bytes);
  });

  test("removes an empty SelfTune-only hooks section without dropping other preferences", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "selftune-uninstall-own-"));
    const settingsPath = join(temporaryDirectory, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: "dark",
        hooks: { Stop: [{ hooks: [{ command: "selftune hook session-stop" }] }] },
      }),
    );
    expect(removeHooksFromSettings(false, settingsPath).removed).toBe(1);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ theme: "dark" });
  });
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
