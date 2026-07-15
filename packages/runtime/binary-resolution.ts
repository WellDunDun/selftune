import { homedir } from "node:os";
import { join } from "node:path";

export function resolveSelftuneBin(): string {
  const configuredPath = process.env.SELFTUNE_BIN_PATH?.trim();
  if (configuredPath) return configuredPath;

  try {
    const resolved = Bun.which("selftune");
    if (resolved) return resolved;
  } catch {
    // Fall back to Bun's default global binary directory.
  }
  return join(homedir(), ".bun", "bin", "selftune");
}
