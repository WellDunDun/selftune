import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INSTALLATION_ID_FILE = "desktop-installation-id";
const INSTALLATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readInstallationId(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return INSTALLATION_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Stable, local-only device identity used to rotate only this installation's Cloud key. */
export function desktopCloudClientId(configRoot: string): string {
  const path = join(configRoot, INSTALLATION_ID_FILE);
  const existing = readInstallationId(path);
  if (existing) return `selftune-desktop-${existing}`;

  mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  const generated = randomUUID();
  try {
    writeFileSync(path, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (cause) {
    const concurrent = readInstallationId(path);
    if (concurrent) return `selftune-desktop-${concurrent}`;
    throw cause;
  }
  return `selftune-desktop-${generated}`;
}
