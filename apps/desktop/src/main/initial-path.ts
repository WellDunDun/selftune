import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveInitialDashboardPath(options: {
  configDir?: string;
  homeDir?: string;
  testPath?: string;
}): string {
  if (options.testPath) return options.testPath;
  const configDir = options.configDir ?? join(options.homeDir ?? homedir(), ".selftune");
  try {
    const config: unknown = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    const preferences =
      typeof config === "object" && config !== null && "preferences" in config
        ? config.preferences
        : null;
    if (typeof preferences === "object" && preferences !== null) return "/";
  } catch {
    // No config yet; check the legacy marker below.
  }
  try {
    // Legacy installs recorded completion in onboarding.json; the daemon
    // migrates it into config.json.preferences on first settings load.
    const legacy: unknown = JSON.parse(readFileSync(join(configDir, "onboarding.json"), "utf8"));
    if (typeof legacy === "object" && legacy !== null && "completed" in legacy) {
      return legacy.completed === true ? "/" : "/settings";
    }
  } catch {
    // No legacy marker either.
  }
  return "/settings";
}
