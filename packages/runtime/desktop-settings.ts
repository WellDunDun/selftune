import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "./constants.js";
import type {
  DesktopScheduleFormat,
  DesktopScheduleJob,
  DesktopScheduleJobId,
  DesktopSettingsResponse,
  HarnessConnection,
  HarnessConnectionStatus,
  UpdateDesktopScheduleRequest,
  UpdateRemoteLibraryRequest,
} from "./dashboard-contract.js";
import {
  buildLaunchdDefinition,
  buildSystemdDefinition,
  resolveSelftuneBin,
  SCHEDULE_ENTRIES,
  type ScheduleEntry,
} from "./scheduling.js";
import { loadOnboardingPreferences } from "./onboarding-preferences.js";
import { remoteLibrarySettings, updateRemoteLibraryConfig } from "./remote-library-config.js";
import { missingClaudeCodeHookKeys } from "./utils/hooks.js";

const SETTINGS_VERSION = 1;
const SETTINGS_FILENAME = "desktop-settings.json";
const PI_HOOK_NAMES = ["tool_call", "tool_result", "message", "session_shutdown"] as const;

const JOB_LABELS: Record<DesktopScheduleJobId, string> = {
  "selftune-sync": "Sync telemetry",
  "selftune-status": "Daily health report",
  "selftune-orchestrate": "Improve skills",
};

interface StoredDesktopSettings {
  version: 1;
  jobs: Record<DesktopScheduleJobId, { enabled: boolean; schedule: string }>;
}

export interface SettingsEnvironment {
  homeDir?: string;
  configDir?: string;
  platform?: NodeJS.Platform;
  binPath?: string;
  which?: (command: string) => string | null;
  run?: (command: string, args: string[]) => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function defaultWhich(command: string): string | null {
  try {
    return Bun.which(command) ?? null;
  } catch {
    return null;
  }
}

function statusFor(detected: boolean, connected: boolean): HarnessConnectionStatus {
  if (connected) return "connected";
  if (detected) return "detected";
  return "not_detected";
}

function containsHookCommand(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle) && value.includes("selftune");
  if (Array.isArray(value)) return value.some((entry) => containsHookCommand(entry, needle));
  if (!isRecord(value)) return false;
  return Object.values(value).some((entry) => containsHookCommand(entry, needle));
}

export function detectHarnessConnections(options: SettingsEnvironment = {}): HarnessConnection[] {
  const home = options.homeDir ?? homedir();
  const which = options.which ?? defaultWhich;

  const claudeDir = join(home, ".claude");
  const claudeSettings = join(claudeDir, "settings.json");
  const claudeProjects = join(claudeDir, "projects");
  const claudeDetected = existsSync(claudeDir) || Boolean(which("claude"));
  const claudeJson = readJson(claudeSettings);
  const claudeHooks = isRecord(claudeJson) && isRecord(claudeJson.hooks) ? claudeJson.hooks : null;
  const claudeConnected = Boolean(
    claudeHooks && missingClaudeCodeHookKeys(claudeHooks).length === 0,
  );

  const codexDir = process.env.CODEX_HOME || join(home, ".codex");
  const codexHooksPath = join(codexDir, "hooks.json");
  const codexDetected = existsSync(codexDir) || Boolean(which("codex"));
  const codexHooks = readJson(codexHooksPath);
  const codexHooksConnected = ["SessionStart", "PreToolUse", "PostToolUse", "Stop"].every(
    (event) => {
      if (!isRecord(codexHooks) || !isRecord(codexHooks.hooks)) return false;
      return containsHookCommand(codexHooks.hooks[event], "codex hook");
    },
  );
  const codexSessions = join(codexDir, "sessions");
  const codexConnected = codexHooksConnected || existsSync(codexSessions);

  const openCodeRoot = join(home, ".config", "opencode");
  const openCodePlugin = join(openCodeRoot, "plugins", "selftune-opencode-plugin.ts");
  const openCodeDataRoot = join(home, ".local", "share", "opencode");
  const openCodeDb = join(openCodeDataRoot, "opencode.db");
  const openCodeLegacySessions = join(openCodeDataRoot, "storage", "session");
  const openCodeDetected =
    existsSync(openCodeRoot) || existsSync(openCodeDb) || Boolean(which("opencode"));
  const openCodePluginContent = existsSync(openCodePlugin)
    ? readFileSync(openCodePlugin, "utf8")
    : "";
  const openCodePluginConnected =
    openCodePluginContent.includes("selftune-managed") &&
    openCodePluginContent.includes("opencode hook");
  const openCodeConnected =
    openCodePluginConnected || existsSync(openCodeDb) || existsSync(openCodeLegacySessions);

  const openClawDir = join(home, ".openclaw");
  const openClawAgents = join(openClawDir, "agents");
  const openClawDetected = existsSync(openClawDir) || Boolean(which("openclaw"));
  const openClawConnected = existsSync(openClawAgents);

  const piDir = join(home, ".pi");
  const piExtensionDir = join(piDir, "extensions", "selftune");
  const piSessions = join(piDir, "agent", "sessions");
  const piDetected = existsSync(piDir) || Boolean(which("pi"));
  const piHooksConnected = PI_HOOK_NAMES.every((hookName) => {
    const hookPath = join(piExtensionDir, hookName);
    if (!existsSync(hookPath)) return false;
    const content = readFileSync(hookPath, "utf8");
    return content.includes("selftune-managed") && content.includes("pi hook");
  });
  const piConnected = piHooksConnected || existsSync(piSessions);

  const result = (
    [
      {
        id: "claude_code",
        name: "Claude Code",
        detected: claudeDetected,
        connected: claudeConnected,
        import_available: existsSync(claudeProjects),
        hooks_supported: true,
        hooks_installed: claudeConnected,
        config_path: claudeSettings,
        connected_detail: "Live hooks connected",
      },
      {
        id: "codex",
        name: "Codex",
        detected: codexDetected,
        connected: codexConnected,
        import_available: existsSync(codexSessions),
        hooks_supported: true,
        hooks_installed: codexHooksConnected,
        config_path: codexHooksConnected ? codexHooksPath : codexSessions,
        connected_detail: codexHooksConnected ? "Live hooks connected" : "Session import available",
      },
      {
        id: "opencode",
        name: "OpenCode",
        detected: openCodeDetected,
        connected: openCodeConnected,
        import_available: existsSync(openCodeDb) || existsSync(openCodeLegacySessions),
        hooks_supported: true,
        hooks_installed: openCodePluginConnected,
        config_path: openCodePluginConnected ? openCodePlugin : openCodeDb,
        connected_detail: openCodePluginConnected
          ? "Live plugin connected"
          : "Session import available",
      },
      {
        id: "openclaw",
        name: "OpenClaw",
        detected: openClawDetected,
        connected: openClawConnected,
        import_available: existsSync(openClawAgents),
        hooks_supported: false,
        hooks_installed: false,
        config_path: openClawAgents,
        connected_detail: "Session import available",
      },
      {
        id: "pi",
        name: "Pi",
        detected: piDetected,
        connected: piConnected,
        import_available: existsSync(piSessions),
        hooks_supported: true,
        hooks_installed: piHooksConnected,
        config_path: piHooksConnected ? piExtensionDir : piSessions,
        connected_detail: piHooksConnected ? "Live hooks connected" : "Session import available",
      },
    ] as const
  ).map((harness): HarnessConnection => {
    const status = statusFor(harness.detected, harness.connected);
    return {
      ...harness,
      status,
      detail:
        status === "connected"
          ? harness.connected_detail
          : status === "detected"
            ? "Harness found; SelfTune integration is not installed"
            : "Harness not found on this Mac",
    };
  });

  return result;
}

function scheduleFormat(platform: NodeJS.Platform): DesktopScheduleFormat {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return "unsupported";
}

function settingsPath(options: SettingsEnvironment): string {
  return join(options.configDir ?? SELFTUNE_CONFIG_DIR, "schedule", SETTINGS_FILENAME);
}

function defaultStoredSettings(): StoredDesktopSettings {
  return {
    version: SETTINGS_VERSION,
    jobs: Object.fromEntries(
      SCHEDULE_ENTRIES.map((entry) => [entry.name, { enabled: false, schedule: entry.schedule }]),
    ) as StoredDesktopSettings["jobs"],
  };
}

function isScheduleJobId(value: string): value is DesktopScheduleJobId {
  return value in JOB_LABELS;
}

function loadStoredSettings(options: SettingsEnvironment): StoredDesktopSettings {
  const fallback = defaultStoredSettings();
  const parsed = readJson(settingsPath(options));
  if (!isRecord(parsed) || parsed.version !== SETTINGS_VERSION || !isRecord(parsed.jobs)) {
    return fallback;
  }

  for (const entry of SCHEDULE_ENTRIES) {
    if (!isScheduleJobId(entry.name)) continue;
    const saved = parsed.jobs[entry.name];
    if (
      isRecord(saved) &&
      typeof saved.enabled === "boolean" &&
      typeof saved.schedule === "string"
    ) {
      fallback.jobs[entry.name] = {
        enabled: saved.enabled,
        schedule: saved.schedule,
      };
    }
  }
  return fallback;
}

function artifactPaths(
  id: DesktopScheduleJobId,
  format: DesktopScheduleFormat,
  home: string,
): string[] {
  if (format === "launchd") {
    const suffix = id.replace("selftune-", "");
    return [join(home, "Library", "LaunchAgents", `com.selftune.${suffix}.plist`)];
  }
  if (format === "systemd") {
    const root = join(home, ".config", "systemd", "user");
    return [join(root, `${id}.timer`), join(root, `${id}.service`)];
  }
  return [];
}

function isActive(id: DesktopScheduleJobId, format: DesktopScheduleFormat, home: string): boolean {
  const paths = artifactPaths(id, format, home);
  return paths.length > 0 && paths.every((path) => existsSync(path));
}

export function loadDesktopSettings(options: SettingsEnvironment = {}): DesktopSettingsResponse {
  const home = options.homeDir ?? homedir();
  const format = scheduleFormat(options.platform ?? process.platform);
  const stored = loadStoredSettings(options);
  const hasStoredSettings = existsSync(settingsPath(options));
  const jobs = SCHEDULE_ENTRIES.filter((entry) => isScheduleJobId(entry.name)).map(
    (entry): DesktopScheduleJob => {
      const id = entry.name as DesktopScheduleJobId;
      const active = isActive(id, format, home);
      return {
        id,
        label: JOB_LABELS[id],
        description: entry.description,
        command: entry.command,
        default_schedule: entry.schedule,
        schedule: stored.jobs[id].schedule,
        enabled: hasStoredSettings ? stored.jobs[id].enabled : active,
        active,
      };
    },
  );

  return {
    harnesses: detectHarnessConnections(options),
    onboarding: loadOnboardingPreferences(options.configDir),
    remote_library: remoteLibrarySettings(options.configDir),
    schedule: {
      supported: format !== "unsupported",
      format,
      settings_path: settingsPath(options),
      jobs,
    },
  };
}

export function updateRemoteLibrarySettings(
  input: UpdateRemoteLibraryRequest,
  options: SettingsEnvironment = {},
): DesktopSettingsResponse {
  updateRemoteLibraryConfig(input, options.configDir);
  return loadDesktopSettings(options);
}

export function validateScheduleExpression(value: string): string | null {
  const expression = value.trim().replace(/\s+/g, " ");
  const everyMinutes = expression.match(/^\*\/(\d+) \* \* \* \*$/);
  if (everyMinutes) {
    const interval = Number.parseInt(everyMinutes[1], 10);
    return interval >= 1 && interval <= 59 ? null : "Minute interval must be between 1 and 59.";
  }
  const everyHours = expression.match(/^0 \*\/(\d+) \* \* \*$/);
  if (everyHours) {
    const interval = Number.parseInt(everyHours[1], 10);
    return interval >= 1 && interval <= 23 ? null : "Hour interval must be between 1 and 23.";
  }
  const daily = expression.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (daily) {
    const minute = Number.parseInt(daily[1], 10);
    const hour = Number.parseInt(daily[2], 10);
    return minute <= 59 && hour <= 23 ? null : "Daily time must use a valid hour and minute.";
  }
  return "Use */N * * * *, 0 */N * * *, or M H * * *.";
}

function normalizeUpdate(input: UpdateDesktopScheduleRequest): StoredDesktopSettings {
  if (!isRecord(input) || !Array.isArray(input.jobs)) {
    throw new Error("Schedule settings must include a jobs array.");
  }
  if (input.jobs.length !== SCHEDULE_ENTRIES.length) {
    throw new Error("Schedule settings must include every SelfTune job exactly once.");
  }

  const settings = defaultStoredSettings();
  const seen = new Set<DesktopScheduleJobId>();
  for (const job of input.jobs) {
    if (!isRecord(job) || typeof job.id !== "string" || !isScheduleJobId(job.id)) {
      throw new Error("Schedule settings include an unknown job.");
    }
    if (seen.has(job.id)) throw new Error(`Schedule job ${job.id} appears more than once.`);
    if (typeof job.enabled !== "boolean" || typeof job.schedule !== "string") {
      throw new Error(`Schedule job ${job.id} has invalid settings.`);
    }
    const normalizedSchedule = job.schedule.trim().replace(/\s+/g, " ");
    const validationError = validateScheduleExpression(normalizedSchedule);
    if (validationError) throw new Error(`${JOB_LABELS[job.id]}: ${validationError}`);
    seen.add(job.id);
    settings.jobs[job.id] = {
      enabled: job.enabled,
      schedule: normalizedSchedule,
    };
  }
  return settings;
}

function defaultRun(command: string, args: string[]): number {
  return spawnSync(command, args, { stdio: "ignore" }).status ?? 1;
}

function writeSettings(path: string, settings: StoredDesktopSettings): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

function reconcileLaunchd(
  settings: StoredDesktopSettings,
  home: string,
  binPath: string,
  run: (command: string, args: string[]) => number,
): void {
  for (const source of SCHEDULE_ENTRIES) {
    if (!isScheduleJobId(source.name)) continue;
    const job = settings.jobs[source.name];
    const entry: ScheduleEntry = { ...source, schedule: job.schedule };
    const definition = buildLaunchdDefinition(entry, binPath, home);
    const path = artifactPaths(source.name, "launchd", home)[0];
    if (existsSync(path)) run("launchctl", ["unload", path]);
    if (!job.enabled) {
      rmSync(path, { force: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, definition.content, "utf8");
    if (run("launchctl", ["load", path]) !== 0) {
      throw new Error(`Could not activate ${JOB_LABELS[source.name]}.`);
    }
  }
}

function reconcileSystemd(
  settings: StoredDesktopSettings,
  home: string,
  binPath: string,
  run: (command: string, args: string[]) => number,
): void {
  for (const source of SCHEDULE_ENTRIES) {
    if (!isScheduleJobId(source.name)) continue;
    const job = settings.jobs[source.name];
    const unit = `${source.name}.timer`;
    const paths = artifactPaths(source.name, "systemd", home);
    run("systemctl", ["--user", "disable", "--now", unit]);
    if (!job.enabled) {
      for (const path of paths) rmSync(path, { force: true });
      continue;
    }
    const definition = buildSystemdDefinition({ ...source, schedule: job.schedule }, binPath, home);
    mkdirSync(dirname(paths[0]), { recursive: true });
    writeFileSync(paths[0], definition.timerContent, "utf8");
    writeFileSync(paths[1], definition.serviceContent, "utf8");
  }
  if (run("systemctl", ["--user", "daemon-reload"]) !== 0) {
    throw new Error("Could not reload the systemd user manager.");
  }
  for (const source of SCHEDULE_ENTRIES) {
    if (!isScheduleJobId(source.name) || !settings.jobs[source.name].enabled) continue;
    if (run("systemctl", ["--user", "enable", "--now", `${source.name}.timer`]) !== 0) {
      throw new Error(`Could not activate ${JOB_LABELS[source.name]}.`);
    }
  }
}

export function updateDesktopSchedule(
  input: UpdateDesktopScheduleRequest,
  options: SettingsEnvironment = {},
): DesktopSettingsResponse {
  const settings = normalizeUpdate(input);
  const platform = options.platform ?? process.platform;
  const format = scheduleFormat(platform);
  if (format === "unsupported") {
    throw new Error(`Desktop scheduling is not supported on ${platform}.`);
  }
  const home = options.homeDir ?? homedir();
  const binPath = options.binPath ?? resolveSelftuneBin();
  const run = options.run ?? defaultRun;

  if (format === "launchd") reconcileLaunchd(settings, home, binPath, run);
  else reconcileSystemd(settings, home, binPath, run);

  writeSettings(settingsPath(options), settings);
  return loadDesktopSettings(options);
}
