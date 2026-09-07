import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import * as Schema from "effect/Schema";

import { DEFAULT_DAEMON_PORT } from "./daemon-cli-contract.js";

export { DEFAULT_DAEMON_PORT };
export const LOCAL_SERVICE_LABEL = "dev.selftune.daemon";

export const RuntimeOwner = Schema.Literals(["desktop", "cli"]);
export type RuntimeOwner = typeof RuntimeOwner.Type;

export const RuntimeSupervision = Schema.Literals(["desktop-child", "os-service", "none"]);
export type RuntimeSupervision = typeof RuntimeSupervision.Type;

export const ServerManifest = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("selftune-runtime"),
  pid: Schema.Number,
  port: Schema.Number,
  origin: Schema.String,
  started_at: Schema.String,
  owner: RuntimeOwner,
  supervision: RuntimeSupervision,
  owner_version: Schema.String,
  owner_executable_path: Schema.String,
  instance_id: Schema.String,
});

const LegacySupervisedDaemonManifest = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("supervised-daemon"),
  pid: Schema.Number,
  port: Schema.Number,
  origin: Schema.String,
  started_at: Schema.String,
  owner_version: Schema.String,
  owner_executable_path: Schema.String,
  instance_id: Schema.String,
});

const LegacyDesktopSidecarManifest = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("desktop-sidecar"),
  pid: Schema.Number,
  port: Schema.Number,
  origin: Schema.String,
  started_at: Schema.String,
  instance_id: Schema.String,
});

const StoredServerManifest = Schema.Union([
  ServerManifest,
  LegacySupervisedDaemonManifest,
  LegacyDesktopSidecarManifest,
]);

export type ServerManifest = typeof ServerManifest.Type;

export interface RuntimeLock {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

const AuthRecord = Schema.Struct({
  version: Schema.Literal(1),
  token: Schema.String.check(Schema.isMinLength(32)),
});
type AuthRecord = typeof AuthRecord.Type;

export interface LocalAuthTokenDependencies {
  readonly beforeCommit?: () => void;
  readonly createToken: () => string;
}

const defaultLocalAuthTokenDependencies: LocalAuthTokenDependencies = {
  createToken: () => randomBytes(32).toString("base64url"),
};

export function resolveLocalConfigDir(): string {
  return process.env.SELFTUNE_CONFIG_DIR ?? join(homedir(), ".selftune");
}

export function serverControlDir(configDir = resolveLocalConfigDir()): string {
  return join(configDir, "server-control");
}

export function daemonManifestPath(configDir = resolveLocalConfigDir()): string {
  return join(serverControlDir(configDir), "server.json");
}

export function localAuthPath(configDir = resolveLocalConfigDir()): string {
  return join(serverControlDir(configDir), "auth.json");
}

function ensureControlDir(configDir: string): void {
  mkdirSync(serverControlDir(configDir), { recursive: true, mode: 0o700 });
}

function readAuthRecord(configDir: string): AuthRecord | null {
  const path = localAuthPath(configDir);
  if (!existsSync(path)) return null;
  try {
    const record = Schema.decodeUnknownSync(Schema.fromJsonString(AuthRecord))(
      readFileSync(path, "utf8"),
    );
    chmodSync(path, 0o600);
    return record;
  } catch {
    // The installation path refuses to overwrite an existing invalid token.
  }
  return null;
}

function uniqueTemporaryPath(path: string): string {
  return `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
}

function writeOwnerOnlyFile(path: string, contents: string): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function isAlreadyExistsError(cause: unknown): boolean {
  return Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }))(cause);
}

function installAuthRecordCandidate(
  configDir: string,
  token: string,
  beforeCommit?: () => void,
): string {
  ensureControlDir(configDir);
  const path = localAuthPath(configDir);
  const temporary = uniqueTemporaryPath(path);
  const record: AuthRecord = { version: 1, token };
  try {
    writeOwnerOnlyFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    beforeCommit?.();
    try {
      linkSync(temporary, path);
      chmodSync(path, 0o600);
      return token;
    } catch (cause) {
      if (!isAlreadyExistsError(cause)) throw cause;
      const winner = readAuthRecord(configDir);
      if (winner) return winner.token;
      throw new Error(
        `SelfTune local authentication at ${path} exists but is invalid. Remove that file and restart SelfTune.`,
        { cause },
      );
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function replaceAuthRecord(configDir: string, token: string): string {
  ensureControlDir(configDir);
  const path = localAuthPath(configDir);
  const record: AuthRecord = { version: 1, token };
  const temporary = uniqueTemporaryPath(path);
  try {
    writeOwnerOnlyFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    return token;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function loadOrCreateLocalAuthTokenWithDependencies(
  configDir: string,
  dependencies: LocalAuthTokenDependencies,
): string {
  const existing = readAuthRecord(configDir);
  if (existing) return existing.token;
  const token = dependencies.createToken();
  if (token.length < 32) throw new TypeError("SelfTune local authentication tokens are too short.");
  return installAuthRecordCandidate(configDir, token, dependencies.beforeCommit);
}

export function loadOrCreateLocalAuthToken(configDir = resolveLocalConfigDir()): string {
  return loadOrCreateLocalAuthTokenWithDependencies(configDir, defaultLocalAuthTokenDependencies);
}

export function readLocalAuthToken(configDir = resolveLocalConfigDir()): string | null {
  return readAuthRecord(configDir)?.token ?? null;
}

export function rotateLocalAuthToken(configDir = resolveLocalConfigDir()): string {
  return replaceAuthRecord(configDir, randomBytes(32).toString("base64url"));
}

export function readServerManifest(configDir = resolveLocalConfigDir()): ServerManifest | null {
  const path = daemonManifestPath(configDir);
  if (!existsSync(path)) return null;
  try {
    const stored = Schema.decodeUnknownSync(StoredServerManifest)(
      JSON.parse(readFileSync(path, "utf8")),
    );
    const manifest: ServerManifest =
      stored.version === 2
        ? stored
        : stored.kind === "supervised-daemon"
          ? {
              version: 2,
              kind: "selftune-runtime",
              pid: stored.pid,
              port: stored.port,
              origin: stored.origin,
              started_at: stored.started_at,
              owner: "cli",
              supervision: "os-service",
              owner_version: stored.owner_version,
              owner_executable_path: stored.owner_executable_path,
              instance_id: stored.instance_id,
            }
          : {
              version: 2,
              kind: "selftune-runtime",
              pid: stored.pid,
              port: stored.port,
              origin: stored.origin,
              started_at: stored.started_at,
              owner: "desktop",
              supervision: "desktop-child",
              owner_version: "unknown",
              owner_executable_path: process.execPath,
              instance_id: stored.instance_id,
            };
    if (!validManifest(manifest)) return null;
    return manifest;
  } catch {
    return null;
  }
}

function validManifest(manifest: ServerManifest): boolean {
  if (!Number.isSafeInteger(manifest.pid) || manifest.pid <= 1) return false;
  if (!Number.isSafeInteger(manifest.port) || manifest.port <= 0 || manifest.port > 65_535) {
    return false;
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      manifest.instance_id,
    )
  ) {
    return false;
  }
  if (Number.isNaN(Date.parse(manifest.started_at))) return false;
  if (!isAbsolute(manifest.owner_executable_path)) {
    return false;
  }
  const ownershipIsValid =
    (manifest.owner === "desktop" && manifest.supervision === "desktop-child") ||
    manifest.supervision === "os-service" ||
    (manifest.owner === "cli" && manifest.supervision === "none");
  if (!ownershipIsValid) return false;
  try {
    const url = new URL(manifest.origin);
    const loopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return (
      url.protocol === "http:" &&
      loopback &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      url.port === String(manifest.port)
    );
  } catch {
    return false;
  }
}

export function readSupervisedDaemonManifest(
  configDir = resolveLocalConfigDir(),
): ServerManifest | null {
  const manifest = readServerManifest(configDir);
  return manifest?.supervision === "os-service" ? manifest : null;
}

export function writeServerManifest(configDir: string, manifest: ServerManifest): void {
  ensureControlDir(configDir);
  const path = daemonManifestPath(configDir);
  if (!validManifest(manifest))
    throw new TypeError("Refusing to write an invalid daemon manifest.");
  const temporary = uniqueTemporaryPath(path);
  try {
    writeOwnerOnlyFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function removeDaemonManifestIfOwned(
  configDir: string,
  pid: number,
  instanceId?: string,
): void {
  const manifest = readServerManifest(configDir);
  if (manifest?.pid === pid && (instanceId === undefined || manifest.instance_id === instanceId)) {
    try {
      unlinkSync(daemonManifestPath(configDir));
    } catch (cause) {
      if (!isMissingFileError(cause)) throw cause;
    }
  }
}

function isMissingFileError(cause: unknown): boolean {
  return Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(cause);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runtimeLockPort(configDir: string): number {
  const digest = createHash("sha256").update(resolve(configDir)).digest();
  return 40_000 + (digest.readUInt16BE(0) % 20_000);
}

export function acquireRuntimeLock(configDir: string, instanceId: string): RuntimeLock {
  const port = runtimeLockPort(configDir);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () =>
        Response.json(
          { service: "selftune-runtime-lock", instance_id: instanceId },
          { headers: { "Cache-Control": "no-store" } },
        ),
    });
  } catch {
    throw new Error(`SelfTune state at ${resolve(configDir)} is already owned by another runtime.`);
  }
  return {
    port,
    stop: () => server.stop(true),
  };
}
