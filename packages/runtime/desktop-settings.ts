import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { loadConfigSync } from "@selftune/config";
import { SELFTUNE_CONFIG_DIR } from "./constants.js";
import type {
  DesktopScheduleFormat,
  DesktopScheduleJob,
  DesktopScheduleJobId,
  DesktopSettingsResponse,
  HarnessConnection,
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
import { remoteLibrarySettings, updateRemoteLibraryConfig } from "./remote-library/config.js";
import { getInstalledSkillDirs } from "./auto-update.js";

const SETTINGS_VERSION = 1;
const SETTINGS_FILENAME = "desktop-settings.json";

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
  userId?: number;
  harnessConnections?: ReadonlyArray<HarnessConnection>;
  loadHarnessConnections?: () => ReadonlyArray<HarnessConnection>;
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

export function detectHarnessConnections(options: SettingsEnvironment = {}): HarnessConnection[] {
  return [...(options.loadHarnessConnections?.() ?? options.harnessConnections ?? [])];
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

function isActive(
  id: DesktopScheduleJobId,
  format: DesktopScheduleFormat,
  home: string,
  run: (command: string, args: string[]) => number,
  userId: number,
): boolean {
  const paths = artifactPaths(id, format, home);
  if (paths.length === 0 || !paths.every((path) => existsSync(path))) return false;
  if (format === "launchd") {
    const suffix = id.replace("selftune-", "");
    return run("launchctl", ["print", `gui/${userId}/com.selftune.${suffix}`]) === 0;
  }
  if (format === "systemd") {
    return run("systemctl", ["--user", "is-active", "--quiet", `${id}.timer`]) === 0;
  }
  return false;
}

export function loadDesktopSettings(options: SettingsEnvironment = {}): DesktopSettingsResponse {
  const home = options.homeDir ?? homedir();
  const format = scheduleFormat(options.platform ?? process.platform);
  const run = options.run ?? defaultRun;
  const userId = options.userId ?? process.getuid?.() ?? 0;
  const stored = loadStoredSettings(options);
  const hasStoredSettings = existsSync(settingsPath(options));
  const jobs = SCHEDULE_ENTRIES.filter((entry) => isScheduleJobId(entry.name)).map(
    (entry): DesktopScheduleJob => {
      const id = entry.name as DesktopScheduleJobId;
      const active = isActive(id, format, home, run, userId);
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
  const harnesses = detectHarnessConnections(options);
  const agentSkillLocations = getInstalledSkillDirs(home);
  const onboarding = loadOnboardingPreferences(options.configDir);
  const configRoot = options.configDir ?? SELFTUNE_CONFIG_DIR;
  const alpha = (() => {
    try {
      return loadConfigSync(join(configRoot, "config.json"))?.alpha;
    } catch {
      return undefined;
    }
  })();
  for (const id of Object.keys(onboarding.hook_harnesses)) {
    const harness = harnesses.find((entry) => entry.id === id);
    onboarding.hook_harnesses[id] = harness?.hooks_installed ?? false;
  }

  return {
    harnesses,
    agent_skill: {
      installed: agentSkillLocations.length > 0,
      locations: agentSkillLocations,
      install_command: "npx skills add selftune-dev/selftune",
    },
    onboarding,
    cloud_account: {
      linked: Boolean(alpha?.enrolled && alpha.cloud_user_id?.trim() && alpha.cloud_org_id?.trim()),
      cloud_user_id: alpha?.cloud_user_id ?? null,
      cloud_org_id: alpha?.cloud_org_id ?? null,
    },
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
  userId: number,
): void {
  for (const source of SCHEDULE_ENTRIES) {
    if (!isScheduleJobId(source.name)) continue;
    const job = settings.jobs[source.name];
    const entry: ScheduleEntry = { ...source, schedule: job.schedule };
    const definition = buildLaunchdDefinition(entry, binPath, home);
    const path = artifactPaths(source.name, "launchd", home)[0];
    const suffix = source.name.replace("selftune-", "");
    const domain = `gui/${userId}`;
    const target = `${domain}/com.selftune.${suffix}`;
    run("launchctl", ["bootout", target]);
    if (!job.enabled) {
      run("launchctl", ["disable", target]);
      rmSync(path, { force: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, definition.content, { encoding: "utf8", mode: 0o600 });
    if (
      run("launchctl", ["enable", target]) !== 0 ||
      run("launchctl", ["bootstrap", domain, path]) !== 0 ||
      run("launchctl", ["print", target]) !== 0
    ) {
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
  const userId = options.userId ?? process.getuid?.() ?? 0;

  if (format === "launchd") reconcileLaunchd(settings, home, binPath, run, userId);
  else reconcileSystemd(settings, home, binPath, run);

  writeSettings(settingsPath(options), settings);
  return loadDesktopSettings(options);
}

/** Reapply persisted scheduler intent after login, reboot, or service replacement. */
export function reconcilePersistedDesktopSchedule(options: SettingsEnvironment = {}): boolean {
  if (!existsSync(settingsPath(options))) return false;
  const settings = loadStoredSettings(options);
  const platform = options.platform ?? process.platform;
  const format = scheduleFormat(platform);
  if (format === "unsupported") return false;
  const home = options.homeDir ?? homedir();
  const binPath = options.binPath ?? resolveSelftuneBin();
  const run = options.run ?? defaultRun;
  const userId = options.userId ?? process.getuid?.() ?? 0;

  if (format === "launchd") reconcileLaunchd(settings, home, binPath, run, userId);
  else reconcileSystemd(settings, home, binPath, run);
  return true;
}
