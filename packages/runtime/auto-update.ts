/**
 * Advisory update check for selftune CLI.
 *
 * Runs before command dispatch (skipped for hooks and --help).
 * Set SELFTUNE_SKIP_AUTO_UPDATE=1 or SELFTUNE_SKIP_UPDATE_CHECK=1 to disable
 * it for source-tree smoke tests and hermetic automation.
 * Selects the npm latest or beta dist-tag from the running version, caches
 * valid channel results for one hour, and caches failed checks for five minutes.
 * If outdated, caches the latest version and prints a manual update command.
 * Already-current installs sync bundled skill files into global skill registries.
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "./constants.js";
import { findSelftunePackageRoot } from "./package-root.js";
import { optionalEvidence } from "./utils/transcript-contract.js";

const UPDATE_CHECK_PATH = join(SELFTUNE_CONFIG_DIR, "update-check.json");
const PACKAGE_NAME = "selftune";
const NPM_DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;
const STABLE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const NEGATIVE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 5000;
const PACKAGE_ROOT = findSelftunePackageRoot();
const BUNDLED_SKILL_DIR = join(PACKAGE_ROOT, "skill");

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

interface CachedUpdateStatusOptions extends UpdateCommandOptions {
  cachePath?: string;
  currentVersion?: string;
}

type RegistryDistTagsResponse = Pick<Response, "json" | "ok">;

export interface UpdateCheckOptions extends UpdateCommandOptions {
  readonly cachePath?: string;
  readonly currentVersion?: string;
  readonly fetchDistTags?: (signal: AbortSignal) => Promise<RegistryDistTagsResponse>;
  readonly now?: () => number;
  readonly notify?: (message: string) => void;
  readonly syncSkills?: () => ReadonlyArray<string>;
  readonly timeoutMs?: number;
}

export type UpdateChannel = "latest" | "beta";

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string | number> | null;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function resolveUpdateChannel(version: string): UpdateChannel {
  return version.includes("-beta.") ? "beta" : "latest";
}

function parseVersion(version: string): ParsedVersion | null {
  const match = SEMVER_PATTERN.exec(version.trim());
  if (!match) return null;
  const [, majorRaw, minorRaw, patchRaw, prereleaseRaw] = match;
  if (majorRaw === undefined || minorRaw === undefined || patchRaw === undefined) return null;
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const patch = Number(patchRaw);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return {
    major,
    minor,
    patch,
    prerelease: prereleaseRaw
      ? prereleaseRaw
          .split(".")
          .map((identifier) => (/^\d+$/.test(identifier) ? Number(identifier) : identifier))
      : null,
  };
}

function comparePrereleaseIdentifiers(
  left: ReadonlyArray<string | number> | null,
  right: ReadonlyArray<string | number> | null,
): -1 | 0 | 1 {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index++) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    if (Schema.is(Schema.Number)(leftIdentifier) && Schema.is(Schema.Number)(rightIdentifier)) {
      return leftIdentifier < rightIdentifier ? -1 : 1;
    }
    if (Schema.is(Schema.Number)(leftIdentifier)) return -1;
    if (Schema.is(Schema.Number)(rightIdentifier)) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function compareVersions(left: string, right: string): -1 | 0 | 1 | null {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (leftVersion === null || rightVersion === null) return null;
  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major < rightVersion.major ? -1 : 1;
  }
  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor < rightVersion.minor ? -1 : 1;
  }
  if (leftVersion.patch !== rightVersion.patch) {
    return leftVersion.patch < rightVersion.patch ? -1 : 1;
  }
  return comparePrereleaseIdentifiers(leftVersion.prerelease, rightVersion.prerelease);
}

const Version = Schema.String.check(
  Schema.makeFilter((version) => parseVersion(version) !== null || "Expected a version"),
);
const decodeDistTags = Schema.decodeUnknownOption(
  Schema.Struct({
    latest: optionalEvidence(
      Version.check(
        Schema.makeFilter(
          (version) =>
            resolveUpdateChannel(version) === "latest" || "Expected a stable-channel version",
        ),
      ),
    ),
    beta: optionalEvidence(
      Version.check(
        Schema.makeFilter(
          (version) =>
            resolveUpdateChannel(version) === "beta" || "Expected a beta-channel version",
        ),
      ),
    ),
  }),
);

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

const UpdateCheckCache = Schema.Struct({
  channel: Schema.Literals(["latest", "beta"]),
  lastCheck: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  currentVersion: Version,
  latestVersion: Schema.Union([Schema.Literal(""), Version]),
}).check(
  Schema.makeFilter(
    (cache) =>
      cache.latestVersion === "" ||
      resolveUpdateChannel(cache.latestVersion) === cache.channel ||
      "Cached version does not match the update channel",
  ),
);
type UpdateCheckCache = typeof UpdateCheckCache.Type;
const decodeUpdateCheckCache = Schema.decodeUnknownOption(Schema.fromJsonString(UpdateCheckCache));
const decodePackageVersion = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ version: Version })),
);

function readCache(path = UPDATE_CHECK_PATH): UpdateCheckCache | null {
  try {
    if (!existsSync(path)) return null;
    return Option.getOrNull(decodeUpdateCheckCache(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCheckCache, path = UPDATE_CHECK_PATH): void {
  try {
    const parentDir = dirname(path);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(cache, null, 2));
  } catch {
    // Non-critical — just skip caching
  }
}

function getCurrentVersion(): string {
  if (process.env.SELFTUNE_VERSION) return process.env.SELFTUNE_VERSION;
  try {
    const pkgPath = join(PACKAGE_ROOT, "package.json");
    return decodePackageVersion(readFileSync(pkgPath, "utf-8")).version;
  } catch {
    return "0.0.0";
  }
}

function normalizePath(path: string): string {
  return resolve(path).replaceAll("\\", "/");
}

function getActivePackageRoot(moduleDir?: string): string {
  return moduleDir ? resolve(moduleDir, "..", "..") : PACKAGE_ROOT;
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

  const npmGlobalRoot = options?.npmGlobalRoot;
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

  if (
    activePackageRoot.includes("/lib/node_modules/selftune") ||
    activePackageRoot.includes("/npm/node_modules/selftune")
  ) {
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

export function getCachedUpdateStatus(options?: CachedUpdateStatusOptions): CachedUpdateStatus {
  const currentVersion = options?.currentVersion ?? getCurrentVersion();
  const cache = readCache(options?.cachePath);
  const channel = resolveUpdateChannel(currentVersion);
  const channelCache = cache?.channel === channel ? cache : null;
  const cachedLatestVersion = channelCache?.latestVersion ?? "";
  const latestVersion = parseVersion(cachedLatestVersion) === null ? null : cachedLatestVersion;
  const updateAvailable =
    latestVersion !== null && compareVersions(currentVersion, latestVersion) === -1;

  return {
    checkedAt: channelCache?.lastCheck ?? null,
    currentVersion,
    latestVersion,
    updateAvailable,
    autoUpdateSupported: false,
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

function writeUpdateNotice(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Check for updates without mutating the running installation. */
export async function checkForUpdates(options: UpdateCheckOptions = {}): Promise<void> {
  try {
    if (isAutoUpdateSkipped()) return;

    const cachePath = options.cachePath ?? UPDATE_CHECK_PATH;
    const currentVersion = options.currentVersion ?? getCurrentVersion();
    const now = options.now ?? Date.now;
    const notify = options.notify ?? writeUpdateNotice;
    const syncSkills = options.syncSkills ?? syncInstalledSkillFiles;
    const cache = readCache(cachePath);
    const checkedAt = now();
    const channel = resolveUpdateChannel(currentVersion);
    const channelCache = cache?.channel === channel ? cache : null;

    const cacheAge = channelCache === null ? null : checkedAt - channelCache.lastCheck;
    const cacheInterval =
      channelCache?.latestVersion === "" ? NEGATIVE_CHECK_INTERVAL_MS : STABLE_CHECK_INTERVAL_MS;
    if (channelCache !== null && cacheAge !== null && cacheAge >= 0 && cacheAge < cacheInterval) {
      const comparison = compareVersions(currentVersion, channelCache.latestVersion);
      if (channelCache.latestVersion && comparison !== null && comparison >= 0) {
        syncSkills();
      }
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REGISTRY_TIMEOUT_MS);
    let selectedVersion: string | null;
    try {
      const response = await (options.fetchDistTags?.(controller.signal) ??
        fetch(NPM_DIST_TAGS_URL, { signal: controller.signal }));
      if (!response.ok) {
        writeCache(
          {
            channel,
            lastCheck: checkedAt,
            currentVersion,
            latestVersion: "",
          },
          cachePath,
        );
        return;
      }
      const tags = Option.getOrNull(decodeDistTags(await response.json()));
      selectedVersion = tags?.[channel]?.trim() ?? null;
    } catch {
      writeCache({ channel, lastCheck: checkedAt, currentVersion, latestVersion: "" }, cachePath);
      return;
    } finally {
      clearTimeout(timeout);
    }

    writeCache(
      { channel, lastCheck: checkedAt, currentVersion, latestVersion: selectedVersion ?? "" },
      cachePath,
    );
    if (selectedVersion === null) return;

    if (compareVersions(currentVersion, selectedVersion) === -1) {
      notify(
        `[selftune] Update available: v${currentVersion} -> v${selectedVersion}. Run: ${getSelftuneUpdateHint(selectedVersion, options)}`,
      );
      return;
    }

    syncSkills();
  } catch {
    // Non-critical — silently skip
  }
}
