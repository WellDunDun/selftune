import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SelftuneConfig } from "../types.js";
import { findSelftunePackageRoot } from "../package-root.js";

let cachedVersion: string | null = null;

export function getSelftuneVersion(fallback = "0.0.0"): string {
  if (cachedVersion !== null) return cachedVersion;

  try {
    const pkg = JSON.parse(
      readFileSync(join(findSelftunePackageRoot(), "package.json"), "utf-8"),
    ) as { version?: unknown };
    cachedVersion =
      typeof pkg.version === "string" && pkg.version.trim().length > 0 ? pkg.version : fallback;
  } catch {
    cachedVersion = fallback;
  }

  return cachedVersion;
}

export function readConfiguredAgentType(
  configPath: string,
  fallback: SelftuneConfig["agent_type"] = "unknown",
): SelftuneConfig["agent_type"] {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      agent_type?: unknown;
    };
    return typeof config.agent_type === "string"
      ? (config.agent_type as SelftuneConfig["agent_type"])
      : fallback;
  } catch {
    return fallback;
  }
}
