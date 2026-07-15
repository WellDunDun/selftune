import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveInitialDashboardPath(options: {
  configDir?: string;
  homeDir?: string;
  testPath?: string;
}): string {
  if (options.testPath) return options.testPath;
  const configDir = options.configDir ?? join(options.homeDir ?? homedir(), ".selftune");
  return existsSync(join(configDir, "onboarding.json")) ? "/" : "/settings";
}
