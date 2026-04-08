/**
 * Auto-update check for selftune CLI.
 *
 * Runs before command dispatch (skipped for hooks and --help).
 * Checks npm registry at most once per hour (cached in ~/.selftune/update-check.json).
 * If outdated, auto-updates via `npm install -g selftune@latest` and notifies the user.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "./constants.js";

const UPDATE_CHECK_PATH = join(SELFTUNE_CONFIG_DIR, "update-check.json");
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface UpdateCheckCache {
  lastCheck: number;
  currentVersion: string;
  latestVersion: string;
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
    const currentVersion = getCurrentVersion();
    const cache = readCache();

    // Skip if checked recently
    if (cache && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) {
      // Even with a recent check, if we know we're outdated, try updating
      if (cache.latestVersion && compareSemver(currentVersion, cache.latestVersion) < 0) {
        await performUpdate(currentVersion, cache.latestVersion);
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
        writeCache({ lastCheck: Date.now(), currentVersion, latestVersion: currentVersion });
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
    }
  } catch {
    // Non-critical — silently skip
  }
}

async function performUpdate(currentVersion: string, latestVersion: string): Promise<void> {
  console.error(`[selftune] Update available: v${currentVersion} → v${latestVersion}. Updating...`);

  const result = spawnSync("npm", ["install", "-g", `selftune@${latestVersion}`], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });

  if (result.status === 0) {
    console.error(`[selftune] Updated to v${latestVersion}.`);
    // Update cache to reflect new version
    writeCache({ lastCheck: Date.now(), currentVersion: latestVersion, latestVersion });

    try {
      const claudeDir = join(homedir(), ".claude");
      if (existsSync(claudeDir)) {
        const { installAgentFiles } = await import("./claude-agents.js");
        installAgentFiles({ force: true });
      }
    } catch {
      // Non-critical — updated CLI is usable even if agent sync fails
    }

    // Sync skill files to ~/.claude/skills/selftune/ if installed there
    try {
      const skillInstallDir = join(homedir(), ".claude", "skills", "selftune");
      if (existsSync(skillInstallDir)) {
        const packageSkillDir = join(import.meta.dir, "../../skill");
        if (existsSync(packageSkillDir)) {
          const cpResult = spawnSync(
            "sh",
            ["-c", `cp -R "${packageSkillDir}"/* "${skillInstallDir}"/`],
            {
              stdio: ["ignore", "pipe", "pipe"],
              timeout: 10000,
            },
          );
          if (cpResult.status !== 0) {
            console.error(
              "[selftune] Skill file sync failed — run: npx skills add selftune-dev/selftune",
            );
          }
        }
      }
    } catch {
      // Non-critical — skill files can be updated manually
    }
  } else {
    const stderr = result.stderr?.toString().trim();
    console.error(
      `[selftune] Auto-update failed. Run manually: npm install -g selftune@${latestVersion}`,
    );
    if (stderr) {
      console.error(`  ${stderr.split("\n")[0]}`);
    }
  }
}
