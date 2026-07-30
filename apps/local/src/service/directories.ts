import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function serviceLogDir(configDir: string): string {
  return join(configDir, "logs");
}

export function prepareServiceDirectories(configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(serviceLogDir(configDir), { recursive: true, mode: 0o700 });
  mkdirSync(join(configDir, "server-control"), { recursive: true, mode: 0o700 });
}
