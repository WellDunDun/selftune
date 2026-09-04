const { existsSync, readFileSync, realpathSync } = require("node:fs");
const { homedir } = require("node:os");
const { basename, dirname, join, relative, resolve, sep } = require("node:path");

function numericVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(candidate, installed) {
  const left = numericVersion(candidate);
  const right = numericVersion(installed);
  if (!left || !right) return candidate === installed;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function desktopDataRoots(environment = process.env, platform = process.platform) {
  if (platform === "darwin") {
    return [join(homedir(), "Library", "Application Support", "SelfTune")];
  }
  if (platform === "win32" && environment.APPDATA) {
    return [join(environment.APPDATA, "SelfTune"), join(environment.APPDATA, "selftune")];
  }
  const configRoot = environment.XDG_CONFIG_HOME || join(homedir(), ".config");
  return [join(configRoot, "SelfTune"), join(configRoot, "selftune")];
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

function resolveDesktopRuntime(installedVersion, options = {}) {
  if (options.environment?.SELFTUNE_DISABLE_DESKTOP_RUNTIME === "1") return null;
  const roots = options.dataRoots ?? desktopDataRoots(options.environment, options.platform);
  const executableName =
    (options.platform ?? process.platform) === "win32" ? "selftune.exe" : "selftune";

  for (const dataRoot of roots) {
    try {
      const runtimeRoot = realpathSync(join(dataRoot, "runtime"));
      const pointer = JSON.parse(readFileSync(join(runtimeRoot, "current.json"), "utf8"));
      if (
        !pointer ||
        typeof pointer.version !== "string" ||
        typeof pointer.path !== "string" ||
        !versionAtLeast(pointer.version, installedVersion)
      ) {
        continue;
      }
      const selectedRoot = realpathSync(resolve(pointer.path));
      if (!isInside(runtimeRoot, selectedRoot) || basename(selectedRoot) !== pointer.version)
        continue;
      const executable = realpathSync(join(selectedRoot, executableName));
      if (dirname(executable) !== selectedRoot || !existsSync(executable)) continue;
      return executable;
    } catch {
      // An absent, incomplete, or untrusted Desktop runtime is not a CLI failure.
    }
  }
  return null;
}

module.exports = { desktopDataRoots, resolveDesktopRuntime, versionAtLeast };
