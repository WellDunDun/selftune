import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface AuthRecord {
  version: 1;
  token: string;
}

export function loadOrCreateLocalAuthToken(configDir: string): string {
  const controlDir = join(configDir, "server-control");
  const authPath = join(controlDir, "auth.json");
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });

  if (existsSync(authPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "version" in parsed &&
        parsed.version === 1 &&
        "token" in parsed &&
        typeof parsed.token === "string" &&
        parsed.token.length >= 32
      ) {
        chmodSync(authPath, 0o600);
        return parsed.token;
      }
    } catch {
      // Replace malformed local credentials with a new owner-only token.
    }
  }

  const record: AuthRecord = { version: 1, token: randomBytes(32).toString("base64url") };
  writeFileSync(authPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(authPath, 0o600);
  return record.token;
}
