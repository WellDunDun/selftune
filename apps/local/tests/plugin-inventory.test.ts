import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverPluginInventory,
  managePluginInstallation,
  type PluginInventoryRuntime,
} from "../src/plugin-inventory.js";

function fixtureRuntime(calls: string[]): PluginInventoryRuntime {
  let claudeEnabled = true;
  let codexInstalled = true;
  return {
    which: (command) => `/tools/${command}`,
    now: () => new Date("2026-08-11T09:30:00.000Z"),
    run: (command, args) => {
      const invocation = [command, ...args].join(" ");
      calls.push(invocation);
      if (args.join(" ") === "plugin list --json") {
        if (command.endsWith("claude")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                id: "paper-desktop@paper",
                version: "0.1.0",
                scope: "user",
                enabled: claudeEnabled,
              },
              {
                id: "research@selftune-123",
                version: "0.0.0-selftune.abc",
                scope: "user",
                enabled: true,
              },
            ]),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: codexInstalled
              ? [
                  {
                    pluginId: "paper-desktop@paper",
                    marketplaceName: "paper",
                    version: "0.2.0",
                    enabled: true,
                    source: { source: "local" },
                  },
                ]
              : [],
          }),
          stderr: "",
        };
      }
      if (args[1] === "disable") claudeEnabled = false;
      if (args[1] === "remove") codexInstalled = false;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
  };
}

describe("plugin inventory", () => {
  test("malformed host envelopes report an error instead of a successful empty inventory", () => {
    const runtime: PluginInventoryRuntime = {
      which: (command) => `/tools/${command}`,
      now: () => new Date("2026-09-06T00:00:00Z"),
      run: (command) => ({
        exitCode: 0,
        stderr: "",
        stdout: command.endsWith("claude") ? "{}" : "[]",
      }),
    };
    const inventory = discoverPluginInventory({}, runtime);
    expect(inventory.hosts.map((host) => host.status)).toEqual(["error", "error"]);
    expect(inventory.totalPlugins).toBe(0);
    expect(() =>
      managePluginInstallation(
        { host: "claude", pluginId: "missing", action: "remove" },
        {},
        runtime,
      ),
    ).toThrow("not installed");
  });

  test("keeps valid plugins and receipt ownership beside malformed records", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-plugin-boundary-"));
    try {
      mkdirSync(join(root, "plugin-installs"));
      writeFileSync(
        join(root, "plugin-installs", "receipt.json"),
        JSON.stringify({ hosts: [null, 42, { pluginId: {} }, { pluginId: "review@team" }] }),
      );
      const runtime: PluginInventoryRuntime = {
        which: (command) => `/tools/${command}`,
        now: () => new Date("2026-09-06T00:00:00Z"),
        run: (command) => ({
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(
            command.endsWith("claude")
              ? [
                  null,
                  { id: 42 },
                  { id: "review@team", scope: "managed", enabled: false, version: {} },
                ]
              : {
                  installed: [
                    null,
                    { pluginId: [] },
                    { pluginId: "review@team", version: "1", source: { source: "local" } },
                  ],
                },
          ),
        }),
      };
      const inventory = discoverPluginInventory({ configRoot: root }, runtime);
      expect(inventory.hosts.map((host) => host.installedCount)).toEqual([1, 1]);
      expect(inventory.managedPlugins).toBe(1);
      expect(inventory.plugins[0]?.installations).toMatchObject([
        {
          host: "claude",
          scope: "managed",
          enabled: false,
          version: null,
          availableActions: ["update"],
        },
        { host: "codex", sourceType: "local", version: "1", availableActions: ["remove"] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("groups the same plugin across hosts and marks receipt-owned installs", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-plugin-inventory-"));
    const calls: string[] = [];
    try {
      mkdirSync(join(root, "plugin-installs"), { recursive: true });
      writeFileSync(
        join(root, "plugin-installs", "research.json"),
        JSON.stringify({ hosts: [{ pluginId: "research@selftune-123" }] }),
      );
      const inventory = discoverPluginInventory({ configRoot: root }, fixtureRuntime(calls));
      expect(inventory.totalPlugins).toBe(2);
      expect(inventory.managedPlugins).toBe(1);
      expect(inventory.hosts.map((host) => host.installedCount)).toEqual([2, 1]);
      expect(
        inventory.plugins.find((plugin) => plugin.pluginId === "paper-desktop@paper"),
      ).toMatchObject({
        versionDrift: true,
        installations: [{ host: "claude" }, { host: "codex" }],
      });
      expect(
        inventory.plugins.find((plugin) => plugin.pluginId === "research@selftune-123"),
      ).toMatchObject({ managedBySelfTune: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses host-supported actions and preserves Claude plugin data on removal", () => {
    const calls: string[] = [];
    const runtime = fixtureRuntime(calls);
    const disabled = managePluginInstallation(
      { host: "claude", pluginId: "paper-desktop@paper", action: "disable" },
      {},
      runtime,
    );
    expect(disabled.inventory.plugins[0]?.installations[0]?.enabled).toBe(false);
    managePluginInstallation(
      { host: "claude", pluginId: "paper-desktop@paper", action: "remove" },
      {},
      runtime,
    );
    managePluginInstallation(
      { host: "codex", pluginId: "paper-desktop@paper", action: "remove" },
      {},
      runtime,
    );
    expect(calls).toContain("/tools/claude plugin disable paper-desktop@paper --scope user");
    expect(calls).toContain(
      "/tools/claude plugin uninstall paper-desktop@paper --keep-data --scope user",
    );
    expect(calls).toContain("/tools/codex plugin remove paper-desktop@paper --json");
  });

  test("reports unavailable hosts without failing the whole inventory", () => {
    const runtime: PluginInventoryRuntime = {
      which: () => null,
      now: () => new Date("2026-08-11T09:30:00.000Z"),
      run: () => ({ exitCode: 1, stdout: "", stderr: "not available" }),
    };
    const inventory = discoverPluginInventory({}, runtime);
    expect(inventory.plugins).toEqual([]);
    expect(inventory.hosts.map((host) => host.status)).toEqual(["unavailable", "unavailable"]);
  });
});
