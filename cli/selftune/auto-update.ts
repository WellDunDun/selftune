/**
 * Auto-update check for selftune CLI.
 *
 * Runs before command dispatch (skipped for hooks and --help).
 * Set SELFTUNE_SKIP_AUTO_UPDATE=1 or SELFTUNE_SKIP_UPDATE_CHECK=1 to disable
 * it for source-tree smoke tests and hermetic automation.
 * Checks npm registry at most once per hour (cached in ~/.selftune/update-check.json).
 * If outdated, auto-updates the active global install (npm or Bun) and syncs
 * bundled skill files into common global skill registries.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "./constants.js";

const UPDATE_CHECK_PATH = join(SELFTUNE_CONFIG_DIR, "update-check.json");
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const PACKAGE_NAME = "selftune";
const PACKAGE_ROOT = resolve(import.meta.dir, "..", "..");
const BUNDLED_SKILL_DIR = join(PACKAGE_ROOT, "skill");

interface UpdateCheckCache {
  lastCheck: number;
  currentVersion: string;
  latestVersion: string;
}

export interface CachedUpdateStatus {
  checkedAt: number | null;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  autoUpdateSupported: boolean;
  updateHint: string | null;
}

type InstallSource = "bun-global" | "npm-global";

interface UpdateCommand {
  source: InstallSource;
  command: string;
  args: string[];
  manualCommand: string;
}

interface UpdateCommandOptions {
  homeDir?: string;
  moduleDir?: string;
  npmGlobalRoot?: string | null;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function isAutoUpdateSkipped(): boolean {
  return (
    isTruthyEnv(process.env.SELFTUNE_SKIP_AUTO_UPDATE) ||
    isTruthyEnv(process.env.SELFTUNE_SKIP_UPDATE_CHECK)
  );
}

function readCache(): UpdateCheckCache | null {
  try {
    if (!existsSync(UPDATE_CHECK_PATH)) return null;
    return JSON.parse(readFileSync(UPDATE_CHECK_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCheckCache): void {
  try {
    if (!existsSync(SELFTUNE_CONFIG_DIR)) {
      mkdirSync(SELFTUNE_CONFIG_DIR, { recursive: true });
    }
    writeFileSync(UPDATE_CHECK_PATH, JSON.stringify(cache, null, 2));
  } catch {
    // Non-critical — just skip caching
  }
}

function getCurrentVersion(): string {
  const pkgPath = join(import.meta.dir, "../../package.json");
  return JSON.parse(readFileSync(pkgPath, "utf-8")).version;
}

function normalizePath(path: string): string {
  return resolve(path).replaceAll("\\", "/");
}

function getActivePackageRoot(moduleDir = import.meta.dir): string {
  return resolve(moduleDir, "..", "..");
}

function getNpmGlobalRoot(): string | null {
  const result = spawnSync("npm", ["root", "-g"], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (result.status !== 0) return null;
  const root = result.stdout?.toString().trim();
  return root ? root : null;
}

function buildManualUpdateCommand(source: InstallSource, version: string): string {
  const packageSpec = `${PACKAGE_NAME}@${version}`;
  if (source === "bun-global") {
    return `bun add -g ${packageSpec}`;
  }
  return `npm install -g ${packageSpec}`;
}

export function resolveSelftuneUpdateCommand(
  version: string,
  options?: UpdateCommandOptions,
): UpdateCommand | null {
  const homeDir = options?.homeDir ?? homedir();
  const activePackageRoot = normalizePath(getActivePackageRoot(options?.moduleDir));

  const bunPackageRoot = normalizePath(
    join(homeDir, ".bun", "install", "global", "node_modules", PACKAGE_NAME),
  );
  if (
    activePackageRoot === bunPackageRoot ||
    activePackageRoot.includes("/.bun/install/global/node_modules/selftune")
  ) {
    return {
      source: "bun-global",
      command: "bun",
      args: ["add", "-g", `${PACKAGE_NAME}@${version}`],
      manualCommand: buildManualUpdateCommand("bun-global", version),
    };
  }

  const npmGlobalRoot = options?.npmGlobalRoot ?? getNpmGlobalRoot();
  if (npmGlobalRoot) {
    const npmPackageRoot = normalizePath(join(npmGlobalRoot, PACKAGE_NAME));
    if (activePackageRoot === npmPackageRoot) {
      return {
        source: "npm-global",
        command: "npm",
        args: ["install", "-g", `${PACKAGE_NAME}@${version}`],
        manualCommand: buildManualUpdateCommand("npm-global", version),
      };
    }
  }

  if (activePackageRoot.includes("/lib/node_modules/selftune")) {
    return {
      source: "npm-global",
      command: "npm",
      args: ["install", "-g", `${PACKAGE_NAME}@${version}`],
      manualCommand: buildManualUpdateCommand("npm-global", version),
    };
  }

  return null;
}

export function getSelftuneUpdateHint(version = "latest", options?: UpdateCommandOptions): string {
  return (
    resolveSelftuneUpdateCommand(version, options)?.manualCommand ??
    "npx skills add selftune-dev/selftune"
  );
}

export function getCachedUpdateStatus(options?: UpdateCommandOptions): CachedUpdateStatus {
  const currentVersion = getCurrentVersion();
  const cache = readCache();
  const latestVersion = cache?.latestVersion?.trim() ? cache.latestVersion.trim() : null;
  const autoUpdateSupported = resolveSelftuneUpdateCommand(currentVersion, options) !== null;
  const updateAvailable =
    latestVersion !== null && compareSemver(currentVersion, latestVersion) < 0;

  return {
    checkedAt: cache?.lastCheck ?? null,
    currentVersion,
    latestVersion,
    updateAvailable,
    autoUpdateSupported,
    updateHint: updateAvailable ? getSelftuneUpdateHint(latestVersion, options) : null,
  };
}

function readSkillVersion(skillDir: string): string | null {
  try {
    const skillPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillPath)) return null;
    const skillContent = readFileSync(skillPath, "utf-8");
    const match = skillContent.match(/^\s*version:\s*(.+)$/m);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export function getInstalledSkillDirs(homeDir = homedir()): string[] {
  return [
    join(homeDir, ".claude", "skills", PACKAGE_NAME),
    join(homeDir, ".agents", "skills", PACKAGE_NAME),
  ].filter((dir) => existsSync(dir));
}

export function syncInstalledSkillFiles(options?: {
  force?: boolean;
  homeDir?: string;
  packageSkillDir?: string;
}): string[] {
  const homeDir = options?.homeDir ?? homedir();
  const packageSkillDir = options?.packageSkillDir ?? BUNDLED_SKILL_DIR;
  if (!existsSync(packageSkillDir)) return [];

  const sourceVersion = readSkillVersion(packageSkillDir);
  const syncedDirs: string[] = [];

  for (const targetDir of getInstalledSkillDirs(homeDir)) {
    const targetVersion = readSkillVersion(targetDir);
    const shouldSync =
      options?.force ||
      sourceVersion === null ||
      targetVersion === null ||
      sourceVersion !== targetVersion;
    if (!shouldSync) continue;

    mkdirSync(targetDir, { recursive: true });
    for (const entry of readdirSync(packageSkillDir)) {
      cpSync(join(packageSkillDir, entry), join(targetDir, entry), {
        recursive: true,
        force: true,
      });
    }
    syncedDirs.push(targetDir);
  }

  return syncedDirs;
}

function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Check for updates and auto-install if outdated.
 * Non-blocking: silently skips on any failure.
 * Caches results to avoid hitting npm on every invocation.
 */
export async function autoUpdate(): Promise<void> {
  try {
    if (isAutoUpdateSkipped()) return;

    const currentVersion = getCurrentVersion();
    const cache = readCache();

    // Skip if checked recently
    if (cache && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) {
      // Even with a recent check, if we know we're outdated, try updating
      if (cache.latestVersion && compareSemver(currentVersion, cache.latestVersion) < 0) {
        await performUpdate(currentVersion, cache.latestVersion);
      } else if (cache.latestVersion && compareSemver(currentVersion, cache.latestVersion) >= 0) {
        syncInstalledSkillFiles();
      }
      return;
    }

    // Fetch latest version from npm
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let latestVersion: string;
    try {
      const res = await fetch("https://registry.npmjs.org/selftune/latest", {
        signal: controller.signal,
      });
      if (!res.ok) {
        writeCache({
          lastCheck: Date.now(),
          currentVersion,
          latestVersion: "",
        });
        return;
      }
      const data = (await res.json()) as { version: string };
      latestVersion = data.version;
    } finally {
      clearTimeout(timeout);
    }

    // Cache the result
    writeCache({ lastCheck: Date.now(), currentVersion, latestVersion });

    // Auto-update if outdated
    if (compareSemver(currentVersion, latestVersion) < 0) {
      await performUpdate(currentVersion, latestVersion);
      return;
    }

    syncInstalledSkillFiles();
  } catch {
    // Non-critical — silently skip
  }
}

async function performUpdate(currentVersion: string, latestVersion: string): Promise<void> {
  const updateCommand = resolveSelftuneUpdateCommand(latestVersion);
  if (!updateCommand) {
    syncInstalledSkillFiles();
    return;
  }

  console.error(`[selftune] Update available: v${currentVersion} → v${latestVersion}. Updating...`);

  const result = spawnSync(updateCommand.command, updateCommand.args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });

  if (result.status === 0) {
    console.error(`[selftune] Updated to v${latestVersion}.`);
    // Update cache to reflect new version
    writeCache({
      lastCheck: Date.now(),
      currentVersion: latestVersion,
      latestVersion,
    });

    try {
      const claudeDir = join(homedir(), ".claude");
      if (existsSync(claudeDir)) {
        const { installAgentFiles } = await import("./claude-agents.js");
        installAgentFiles({ force: true });
      }
    } catch {
      // Non-critical — updated CLI is usable even if agent sync fails
    }

    // Refresh installed selftune skill registries after a successful package update.
    try {
      const syncedSkillDirs = syncInstalledSkillFiles({ force: true });
      if (getInstalledSkillDirs().length > 0 && syncedSkillDirs.length === 0) {
        console.error(
          `[selftune] Skill file sync failed — run: ${getSelftuneUpdateHint(latestVersion)}`,
        );
      }
    } catch {
      // Non-critical — skill files can be updated manually
    }
  } else {
    const stderr = result.stderr?.toString().trim();
    console.error(`[selftune] Auto-update failed. Run manually: ${updateCommand.manualCommand}`);
    if (stderr) {
      console.error(`  ${stderr.split("\n")[0]}`);
    }
  }
}
