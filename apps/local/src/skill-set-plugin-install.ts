import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { projectSkillSetPlugin, type SkillSetServiceOptions } from "@selftune/library";
import { SELFTUNE_CONFIG_DIR } from "@selftune/runtime/constants";
import { CLIError } from "@selftune/runtime/utils/cli-error";

export type NativePluginHost = "claude" | "codex";

export interface NativePluginHostPreview {
  readonly host: NativePluginHost;
  readonly label: string;
  readonly available: boolean;
  readonly installedVersion: string | null;
  readonly status: "unavailable" | "ready" | "already_current" | "update_available";
  readonly activation: string;
}

export interface SkillSetPluginInstallPreview {
  readonly setId: string;
  readonly setName: string;
  readonly revisionHash: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly marketplaceName: string;
  readonly skillNames: ReadonlyArray<string>;
  readonly hosts: ReadonlyArray<NativePluginHostPreview>;
}

export interface SkillSetPluginInstallReceipt {
  readonly setId: string;
  readonly setName: string;
  readonly revisionHash: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly marketplaceName: string;
  readonly installedAt: string;
  readonly hosts: ReadonlyArray<{
    readonly host: NativePluginHost;
    readonly pluginId: string;
    readonly result: "installed" | "updated" | "already_current";
    readonly activation: string;
  }>;
}

export interface PluginInstallCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PluginInstallRuntime {
  readonly which: (command: string) => string | null;
  readonly run: (command: string, args: ReadonlyArray<string>) => PluginInstallCommandResult;
  readonly now: () => Date;
}

const defaultRuntime: PluginInstallRuntime = {
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringField(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function marketplaceEntries(host: NativePluginHost, value: unknown): ReadonlyArray<unknown> {
  if (host === "claude") return Array.isArray(value) ? value : [];
  return isRecord(value) && Array.isArray(value.marketplaces) ? value.marketplaces : [];
}

function installedEntries(host: NativePluginHost, value: unknown): ReadonlyArray<unknown> {
  if (host === "claude") return Array.isArray(value) ? value : [];
  return isRecord(value) && Array.isArray(value.installed) ? value.installed : [];
}

function hostLabel(host: NativePluginHost): string {
  return host === "claude" ? "Claude" : "Codex";
}

function hostActivation(host: NativePluginHost): string {
  return host === "claude"
    ? "Run /reload-plugins or start a new Claude session."
    : "Start a new Codex session.";
}

function pluginVersion(revisionHash: string): string {
  return `0.0.0-selftune.${revisionHash.slice(0, 12)}`;
}

function marketplaceName(setId: string): string {
  const identity = createHash("sha256").update(setId).digest("hex").slice(0, 12);
  return `selftune-${identity}`;
}

function commandOutput(result: PluginInstallCommandResult): string {
  const output = result.stderr.trim() || result.stdout.trim();
  return output.slice(0, 2_000);
}

function runJson(
  runtime: PluginInstallRuntime,
  command: string,
  args: ReadonlyArray<string>,
): unknown {
  const result = runtime.run(command, args);
  return result.exitCode === 0 ? parseJson(result.stdout) : null;
}

function hostState(
  runtime: PluginInstallRuntime,
  host: NativePluginHost,
  pluginId: string,
  desiredVersion: string,
): NativePluginHostPreview {
  const executable = runtime.which(host === "claude" ? "claude" : "codex");
  const activation = hostActivation(host);
  if (!executable) {
    return {
      host,
      label: hostLabel(host),
      available: false,
      installedVersion: null,
      status: "unavailable",
      activation,
    };
  }
  const entries = installedEntries(
    host,
    runJson(runtime, executable, ["plugin", "list", "--json"]),
  );
  const installed = entries.find((entry) => {
    const id = stringField(entry, host === "claude" ? "id" : "pluginId");
    return id === pluginId;
  });
  const installedVersion = stringField(installed, "version");
  return {
    host,
    label: hostLabel(host),
    available: true,
    installedVersion,
    status:
      installedVersion === desiredVersion
        ? "already_current"
        : installedVersion
          ? "update_available"
          : "ready",
    activation,
  };
}

function projection(
  setId: string,
  options: SkillSetServiceOptions,
): ReturnType<typeof projectSkillSetPlugin> {
  return projectSkillSetPlugin(setId, "all", options);
}

export function previewSkillSetPluginInstall(
  setId: string,
  options: SkillSetServiceOptions = {},
  runtime: PluginInstallRuntime = defaultRuntime,
): SkillSetPluginInstallPreview {
  const projected = projection(setId, options);
  const version = pluginVersion(projected.revisionHash);
  const market = marketplaceName(projected.setId);
  const pluginId = `${projected.pluginName}@${market}`;
  return {
    setId: projected.setId,
    setName: projected.setName,
    revisionHash: projected.revisionHash,
    pluginName: projected.pluginName,
    pluginVersion: version,
    marketplaceName: market,
    skillNames: projected.skillNames,
    hosts: [
      hostState(runtime, "claude", pluginId, version),
      hostState(runtime, "codex", pluginId, version),
    ],
  };
}

function safeOutputPath(root: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new CLIError(`Plugin contains an unsafe path: ${relativePath}`, "GUARD_BLOCKED");
  }
  const output = resolve(root, normalized);
  if (!output.startsWith(`${resolve(root)}${sep}`)) {
    throw new CLIError(`Plugin path escapes its marketplace: ${relativePath}`, "GUARD_BLOCKED");
  }
  return output;
}

function versionedManifest(path: string, bytes: Uint8Array, version: string): Uint8Array {
  if (path !== ".claude-plugin/plugin.json" && path !== ".codex-plugin/plugin.json") return bytes;
  const decoded = parseJson(new TextDecoder().decode(bytes));
  if (!isRecord(decoded)) {
    throw new CLIError(`Plugin manifest is invalid: ${path}`, "GUARD_BLOCKED");
  }
  return new TextEncoder().encode(`${JSON.stringify({ ...decoded, version }, null, 2)}\n`);
}

function materializeMarketplace(input: {
  readonly configRoot: string;
  readonly marketplaceName: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly description: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: Uint8Array }>;
}): string {
  const parent = resolve(input.configRoot, "plugin-marketplaces");
  const root = resolve(parent, input.marketplaceName);
  const staging = resolve(parent, `.install-${input.marketplaceName}-${randomUUID()}`);
  const backup = resolve(parent, `.previous-${input.marketplaceName}-${randomUUID()}`);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const pluginRoot = join(staging, "plugins", input.pluginName);
    for (const file of input.files) {
      const output = safeOutputPath(pluginRoot, file.path);
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      writeFileSync(output, versionedManifest(file.path, file.content, input.pluginVersion), {
        mode: 0o600,
      });
    }
    const catalogPath = join(staging, ".claude-plugin", "marketplace.json");
    mkdirSync(dirname(catalogPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      catalogPath,
      `${JSON.stringify(
        {
          name: input.marketplaceName,
          version: "1.0.0",
          description: "Locally installed SelfTune Skill Sets",
          owner: { name: "SelfTune" },
          plugins: [
            {
              name: input.pluginName,
              version: input.pluginVersion,
              description: input.description,
              source: `./plugins/${input.pluginName}`,
            },
          ],
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (existsSync(root)) renameSync(root, backup);
    try {
      renameSync(staging, root);
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    } catch (cause) {
      if (existsSync(backup) && !existsSync(root)) renameSync(backup, root);
      throw cause;
    }
    return root;
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

function configuredMarketplaceRoot(
  runtime: PluginInstallRuntime,
  executable: string,
  host: NativePluginHost,
  name: string,
): string | null {
  const value = runJson(runtime, executable, ["plugin", "marketplace", "list", "--json"]);
  const entry = marketplaceEntries(host, value).find(
    (candidate) => stringField(candidate, "name") === name,
  );
  if (!entry) return null;
  return stringField(entry, host === "claude" ? "path" : "root");
}

function runRequired(
  runtime: PluginInstallRuntime,
  command: string,
  args: ReadonlyArray<string>,
  action: string,
): void {
  const result = runtime.run(command, args);
  if (result.exitCode !== 0) {
    throw new CLIError(
      `${action} failed${commandOutput(result) ? `: ${commandOutput(result)}` : "."}`,
      "OPERATION_FAILED",
      "Open the host's plugin manager, resolve the reported issue, and retry from SelfTune.",
    );
  }
}

function installIntoHost(input: {
  readonly runtime: PluginInstallRuntime;
  readonly host: NativePluginHost;
  readonly marketplaceRoot: string;
  readonly marketplaceName: string;
  readonly pluginName: string;
  readonly preview: NativePluginHostPreview;
}): SkillSetPluginInstallReceipt["hosts"][number] {
  const executable = input.runtime.which(input.host === "claude" ? "claude" : "codex");
  if (!executable) {
    throw new CLIError(
      `${hostLabel(input.host)} is not installed on this machine.`,
      "FILE_NOT_FOUND",
    );
  }
  const pluginId = `${input.pluginName}@${input.marketplaceName}`;
  const configuredRoot = configuredMarketplaceRoot(
    input.runtime,
    executable,
    input.host,
    input.marketplaceName,
  );
  if (configuredRoot && resolve(configuredRoot) !== resolve(input.marketplaceRoot)) {
    throw new CLIError(
      `${hostLabel(input.host)} already has a different marketplace named ${input.marketplaceName}.`,
      "GUARD_BLOCKED",
      "Remove the conflicting marketplace in the host plugin manager, then retry.",
    );
  }
  if (!configuredRoot) {
    const args = ["plugin", "marketplace", "add", input.marketplaceRoot];
    if (input.host === "codex") args.push("--json");
    runRequired(
      input.runtime,
      executable,
      args,
      `Registering SelfTune with ${hostLabel(input.host)}`,
    );
  }
  if (input.preview.status === "already_current") {
    return {
      host: input.host,
      pluginId,
      result: "already_current",
      activation: hostActivation(input.host),
    };
  }
  if (input.host === "claude") {
    runRequired(
      input.runtime,
      executable,
      input.preview.installedVersion
        ? ["plugin", "update", pluginId, "--scope", "user"]
        : ["plugin", "install", pluginId, "--scope", "user"],
      `${input.preview.installedVersion ? "Updating" : "Installing"} ${input.pluginName} in Claude`,
    );
  } else {
    if (input.preview.installedVersion) {
      runRequired(
        input.runtime,
        executable,
        ["plugin", "remove", pluginId, "--json"],
        `Preparing the ${input.pluginName} update in Codex`,
      );
    }
    runRequired(
      input.runtime,
      executable,
      ["plugin", "add", pluginId, "--json"],
      `${input.preview.installedVersion ? "Updating" : "Installing"} ${input.pluginName} in Codex`,
    );
  }
  return {
    host: input.host,
    pluginId,
    result: input.preview.installedVersion ? "updated" : "installed",
    activation: hostActivation(input.host),
  };
}

export function installSkillSetPlugin(
  input: {
    readonly setId: string;
    readonly expectedRevisionHash: string;
    readonly hosts: ReadonlyArray<NativePluginHost>;
  },
  options: SkillSetServiceOptions = {},
  runtime: PluginInstallRuntime = defaultRuntime,
): SkillSetPluginInstallReceipt {
  const hosts = [...new Set(input.hosts)];
  if (hosts.length === 0) throw new CLIError("Choose at least one plugin host.", "INVALID_FLAG");
  const preview = previewSkillSetPluginInstall(input.setId, options, runtime);
  if (preview.revisionHash !== input.expectedRevisionHash) {
    throw new CLIError(
      "The Skill Set changed after the install review.",
      "GUARD_BLOCKED",
      "Review the current revision and confirm the plugin installation again.",
    );
  }
  for (const host of hosts) {
    const state = preview.hosts.find((candidate) => candidate.host === host);
    if (!state?.available) {
      throw new CLIError(`${hostLabel(host)} is not installed on this machine.`, "FILE_NOT_FOUND");
    }
  }
  const projected = projection(input.setId, options);
  const configRoot = resolve(options.configRoot ?? SELFTUNE_CONFIG_DIR);
  const marketRoot = materializeMarketplace({
    configRoot,
    marketplaceName: preview.marketplaceName,
    pluginName: preview.pluginName,
    pluginVersion: preview.pluginVersion,
    description: `SelfTune Skill Set: ${preview.setName}`,
    files: projected.files,
  });
  const installedHosts = hosts.map((host) => {
    const hostPreview = preview.hosts.find((candidate) => candidate.host === host);
    if (!hostPreview) {
      throw new CLIError(`Unsupported plugin host: ${host}`, "INVALID_FLAG");
    }
    return installIntoHost({
      runtime,
      host,
      marketplaceRoot: marketRoot,
      marketplaceName: preview.marketplaceName,
      pluginName: preview.pluginName,
      preview: hostPreview,
    });
  });
  const receipt: SkillSetPluginInstallReceipt = {
    setId: preview.setId,
    setName: preview.setName,
    revisionHash: preview.revisionHash,
    pluginName: preview.pluginName,
    pluginVersion: preview.pluginVersion,
    marketplaceName: preview.marketplaceName,
    installedAt: runtime.now().toISOString(),
    hosts: installedHosts,
  };
  const receiptPath = resolve(configRoot, "plugin-installs", `${preview.marketplaceName}.json`);
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return receipt;
}
