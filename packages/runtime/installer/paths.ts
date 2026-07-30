import { posix, win32 } from "node:path";

import { AGENT_REGISTRY_SEGMENTS } from "./agents.js";
import type { InstallerAgent, InstallerPlatform } from "./types.js";

function implementation(platform: InstallerPlatform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

export function canonicalizeInstallerPath(platform: InstallerPlatform, value: string): string {
  return implementation(platform).resolve(value).normalize();
}

export function isAbsoluteInstallerPath(platform: InstallerPlatform, value: string): boolean {
  return implementation(platform).isAbsolute(value);
}

export function installerRegistryRoot(
  platform: InstallerPlatform,
  baseRoot: string,
  agent: InstallerAgent,
): string {
  return implementation(platform).join(
    canonicalizeInstallerPath(platform, baseRoot),
    ...AGENT_REGISTRY_SEGMENTS[agent],
  );
}

export function installerSkillDestination(
  platform: InstallerPlatform,
  registryRoot: string,
  skillName: string,
): string {
  return implementation(platform).join(registryRoot, skillName);
}

export function installerPathKey(platform: InstallerPlatform, value: string): string {
  const canonical = canonicalizeInstallerPath(platform, value).normalize("NFC");
  return platform === "linux" ? canonical : canonical.toLocaleLowerCase("en-US");
}

export function isPathInside(
  platform: InstallerPlatform,
  parent: string,
  candidate: string,
): boolean {
  const path = implementation(platform);
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

export function isFilesystemRoot(platform: InstallerPlatform, value: string): boolean {
  const path = implementation(platform);
  const canonical = canonicalizeInstallerPath(platform, value);
  return canonical === path.parse(canonical).root;
}

export function isBroadProjectRoot(
  platform: InstallerPlatform,
  value: string,
  home: string,
): boolean {
  const canonical = canonicalizeInstallerPath(platform, value);
  const normalizedHome = canonicalizeInstallerPath(platform, home);
  if (installerPathKey(platform, canonical) === installerPathKey(platform, normalizedHome))
    return true;
  if (isFilesystemRoot(platform, canonical)) return true;
  return isBroadSystemRoot(platform, canonical);
}

export function isBroadSystemRoot(platform: InstallerPlatform, value: string): boolean {
  const canonical = canonicalizeInstallerPath(platform, value);
  const broad =
    platform === "win32"
      ? [
          win32.join(win32.parse(canonical).root, "Users"),
          win32.join(win32.parse(canonical).root, "Windows"),
          win32.join(win32.parse(canonical).root, "Program Files"),
          win32.join(win32.parse(canonical).root, "Program Files (x86)"),
        ]
      : [
          "/Applications",
          "/Users",
          "/bin",
          "/etc",
          "/home",
          "/lib",
          "/opt",
          "/sbin",
          "/tmp",
          "/usr",
          "/var",
        ];
  return broad.some(
    (entry) => installerPathKey(platform, entry) === installerPathKey(platform, canonical),
  );
}
