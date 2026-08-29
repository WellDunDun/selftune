import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
  PluginHostInstallationModel,
  PluginHostModel,
  PluginHostStatusModel,
  PluginInventoryItemModel,
  PluginInventoryModel,
  PluginManagementActionModel,
  PluginManagementInputModel,
  PluginManagementReceiptModel,
} from "@selftune/dashboard-core/models";
import { SELFTUNE_CONFIG_DIR } from "@selftune/runtime/constants";

export interface PluginInventoryCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PluginInventoryRuntime {
  readonly which: (command: string) => string | null;
  readonly run: (command: string, args: ReadonlyArray<string>) => PluginInventoryCommandResult;
  readonly now: () => Date;
}

const defaultRuntime: PluginInventoryRuntime = {
  which: (command) => Bun.which(command),
  run: (command, args) => {
    const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  },
  now: () => new Date(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringField(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function booleanField(value: unknown, key: string, fallback: boolean): boolean {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : fallback;
}

function pluginIdentity(pluginId: string): { name: string; marketplaceName: string } {
  const separator = pluginId.lastIndexOf("@");
  if (separator <= 0 || separator === pluginId.length - 1) {
    return { name: pluginId, marketplaceName: "unknown" };
  }
  return {
    name: pluginId.slice(0, separator),
    marketplaceName: pluginId.slice(separator + 1),
  };
}

function receiptPluginIds(configRoot: string): ReadonlySet<string> {
  const receiptsRoot = resolve(configRoot, "plugin-installs");
  const pluginIds = new Set<string>();
  if (!existsSync(receiptsRoot)) return pluginIds;

  for (const entry of readdirSync(receiptsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const decoded = parseJson(readFileSync(join(receiptsRoot, entry.name), "utf8"));
    if (!isRecord(decoded) || !Array.isArray(decoded.hosts)) continue;
    for (const host of decoded.hosts) {
      const pluginId = stringField(host, "pluginId");
      if (pluginId) pluginIds.add(pluginId);
    }
  }
  return pluginIds;
}

function claudeActions(enabled: boolean, scope: string | null): PluginManagementActionModel[] {
  const actions: PluginManagementActionModel[] = ["update"];
  if (scope !== "managed") {
    actions.push(enabled ? "disable" : "enable", "remove");
  }
  return actions;
}

function claudeInstallations(
  value: unknown,
  managedPluginIds: ReadonlySet<string>,
): PluginHostInstallationModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const pluginId = stringField(entry, "id");
    if (!pluginId) return [];
    const identity = pluginIdentity(pluginId);
    const scope = stringField(entry, "scope");
    const enabled = booleanField(entry, "enabled", true);
    return [
      {
        host: "claude",
        hostLabel: "Claude",
        pluginId,
        version: stringField(entry, "version"),
        enabled,
        scope,
        sourceType: scope === "managed" ? "managed" : "marketplace",
        sourceLabel: identity.marketplaceName,
        managedBySelfTune: managedPluginIds.has(pluginId),
        availableActions: claudeActions(enabled, scope),
      },
    ];
  });
}

function codexSourceType(value: unknown): PluginHostInstallationModel["sourceType"] {
  if (!isRecord(value)) return "unknown";
  return stringField(value, "source") === "local" ? "local" : "marketplace";
}

function codexInstallations(
  value: unknown,
  managedPluginIds: ReadonlySet<string>,
): PluginHostInstallationModel[] {
  if (!isRecord(value) || !Array.isArray(value.installed)) return [];
  return value.installed.flatMap((entry) => {
    const pluginId = stringField(entry, "pluginId");
    if (!pluginId) return [];
    const identity = pluginIdentity(pluginId);
    return [
      {
        host: "codex",
        hostLabel: "Codex",
        pluginId,
        version: stringField(entry, "version"),
        enabled: booleanField(entry, "enabled", true),
        scope: null,
        sourceType: codexSourceType(isRecord(entry) ? entry.source : null),
        sourceLabel: stringField(entry, "marketplaceName") ?? identity.marketplaceName,
        managedBySelfTune: managedPluginIds.has(pluginId),
        availableActions: ["remove"],
      },
    ];
  });
}

function inspectHost(
  host: PluginHostModel,
  runtime: PluginInventoryRuntime,
  managedPluginIds: ReadonlySet<string>,
): { status: PluginHostStatusModel; installations: PluginHostInstallationModel[] } {
  const label = host === "claude" ? "Claude" : "Codex";
  const executable = runtime.which(host);
  if (!executable) {
    return {
      status: {
        host,
        label,
        status: "unavailable",
        installedCount: 0,
        message: `${label} is not installed on this machine.`,
      },
      installations: [],
    };
  }

  const result = runtime.run(executable, ["plugin", "list", "--json"]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      status: {
        host,
        label,
        status: "error",
        installedCount: 0,
        message: detail.slice(0, 500) || `${label} did not return its plugin inventory.`,
      },
      installations: [],
    };
  }

  const decoded = parseJson(result.stdout);
  if (decoded === null) {
    return {
      status: {
        host,
        label,
        status: "error",
        installedCount: 0,
        message: `${label} returned an invalid plugin inventory.`,
      },
      installations: [],
    };
  }
  const installations =
    host === "claude"
      ? claudeInstallations(decoded, managedPluginIds)
      : codexInstallations(decoded, managedPluginIds);
  return {
    status: {
      host,
      label,
      status: "available",
      installedCount: installations.length,
      message: null,
    },
    installations,
  };
}

function groupedPlugins(
  installations: ReadonlyArray<PluginHostInstallationModel>,
): PluginInventoryItemModel[] {
  const groups = new Map<string, PluginHostInstallationModel[]>();
  for (const installation of installations) {
    const current = groups.get(installation.pluginId) ?? [];
    current.push(installation);
    groups.set(installation.pluginId, current);
  }
  return [...groups.entries()]
    .map(([pluginId, hostInstallations]) => {
      const identity = pluginIdentity(pluginId);
      const versions = new Set(
        hostInstallations.flatMap((installation) =>
          installation.version ? [installation.version] : [],
        ),
      );
      return {
        pluginId,
        name: identity.name,
        marketplaceName: identity.marketplaceName,
        installations: hostInstallations.sort((left, right) => left.host.localeCompare(right.host)),
        managedBySelfTune: hostInstallations.some((installation) => installation.managedBySelfTune),
        versionDrift: versions.size > 1,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function discoverPluginInventory(
  options: { readonly configRoot?: string } = {},
  runtime: PluginInventoryRuntime = defaultRuntime,
): PluginInventoryModel {
  const managedPluginIds = receiptPluginIds(options.configRoot ?? SELFTUNE_CONFIG_DIR);
  const claude = inspectHost("claude", runtime, managedPluginIds);
  const codex = inspectHost("codex", runtime, managedPluginIds);
  const plugins = groupedPlugins([...claude.installations, ...codex.installations]);
  return {
    hosts: [claude.status, codex.status],
    plugins,
    totalPlugins: plugins.length,
    managedPlugins: plugins.filter((plugin) => plugin.managedBySelfTune).length,
    refreshedAt: runtime.now().toISOString(),
  };
}

function supportedScope(scope: string | null): scope is "user" | "project" | "local" | "managed" {
  return scope === "user" || scope === "project" || scope === "local" || scope === "managed";
}

function managementCommand(
  installation: PluginHostInstallationModel,
  action: PluginManagementActionModel,
): ReadonlyArray<string> {
  if (installation.host === "codex") {
    return ["plugin", "remove", installation.pluginId, "--json"];
  }

  const scope = supportedScope(installation.scope) ? ["--scope", installation.scope] : [];
  if (action === "remove") {
    return ["plugin", "uninstall", installation.pluginId, "--keep-data", ...scope];
  }
  return ["plugin", action, installation.pluginId, ...scope];
}

export function managePluginInstallation(
  input: PluginManagementInputModel,
  options: { readonly configRoot?: string } = {},
  runtime: PluginInventoryRuntime = defaultRuntime,
): PluginManagementReceiptModel {
  const inventory = discoverPluginInventory(options, runtime);
  const installation = inventory.plugins
    .find((plugin) => plugin.pluginId === input.pluginId)
    ?.installations.find((candidate) => candidate.host === input.host);
  if (!installation) {
    throw new Error(`${input.pluginId} is not installed in ${input.host}.`);
  }
  if (!installation.availableActions.includes(input.action)) {
    throw new Error(`${input.action} is not supported for ${input.pluginId} in ${input.host}.`);
  }
  const executable = runtime.which(input.host);
  if (!executable) throw new Error(`${input.host} is not installed on this machine.`);
  const result = runtime.run(executable, managementCommand(installation, input.action));
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(detail.slice(0, 1_000) || `${input.action} failed for ${input.pluginId}.`);
  }
  return {
    ...input,
    completedAt: runtime.now().toISOString(),
    inventory: discoverPluginInventory(options, runtime),
  };
}
