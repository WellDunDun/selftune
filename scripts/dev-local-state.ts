/* oxlint-disable no-await-in-loop -- port blocks must be claimed sequentially */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer, type Server } from "node:net";
import { isAbsolute, join, resolve } from "node:path";

import * as Schema from "effect/Schema";

const BLOCK_BASE = 42_000;
const BLOCK_SIZE = 10;
const BLOCK_COUNT = 400;
const DASHBOARD_OFFSET = 0;
const VITE_OFFSET = 1;
const CONTROL_OFFSET = BLOCK_SIZE - 1;

export interface DevPorts {
  readonly dashboard: number;
  readonly vite: number;
  readonly control: number;
}

export interface DevPortClaim {
  readonly block: number;
  readonly ports: DevPorts;
  readonly authenticate: (manifest: DevManifest) => void;
  readonly close: () => Promise<void>;
  readonly releaseForBoot: () => Promise<void>;
}

export const DevManifest = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("selftune-dev"),
  worktree: Schema.String,
  urls: Schema.Struct({ dashboard: Schema.String, vite: Schema.String }),
  ports: Schema.Struct({ dashboard: Schema.Number, vite: Schema.Number, control: Schema.Number }),
  pids: Schema.Struct({ supervisor: Schema.Number, runtime: Schema.Number, vite: Schema.Number }),
  mode: Schema.Literal("hmr"),
  package_version: Schema.String,
  instance_id: Schema.String,
  started_at: Schema.String,
  auth_token: Schema.String,
});
export type DevManifest = typeof DevManifest.Type;

const ControlIdentity = Schema.Struct({
  service: Schema.Literal("selftune-dev-control"),
  instance_id: Schema.String,
  worktree: Schema.String,
  supervisor_pid: Schema.Number,
});

const DashboardHealth = Schema.Struct({
  ok: Schema.Literal(true),
  service: Schema.Literal("selftune-dashboard"),
  pid: Schema.Number,
  process_mode: Schema.Literal("dev-server"),
  spa_mode: Schema.Literal("proxy"),
  spa_proxy_url: Schema.String,
});

export type DevInstanceStatus =
  | { readonly healthy: true; readonly manifest: DevManifest }
  | { readonly healthy: false; readonly manifest: DevManifest | null; readonly reason: string };

export type DevProcessRole = "supervisor" | "runtime" | "vite";

export interface DevProcessCandidate {
  readonly pid: number;
  readonly role: DevProcessRole;
  readonly worktree: string;
  readonly orphan: boolean;
}

function hash(text: string): number {
  let value = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16_777_619);
  }
  return value >>> 0;
}

export function preferredDevPortBlock(worktree: string): number {
  return BLOCK_BASE + (hash(resolve(worktree)) % BLOCK_COUNT) * BLOCK_SIZE;
}

export function devManifestPath(worktree: string): string {
  return join(resolve(worktree), ".selftune-dev", "manifest.json");
}

export function encodeDevProcessTitle(role: DevProcessRole, worktree: string): string {
  return `selftune-dev:${role}:${Buffer.from(resolve(worktree), "utf8").toString("base64url")}`;
}

export function findDevProcessCandidates(
  processList: string,
  pathExists: (path: string) => boolean = existsSync,
): readonly DevProcessCandidate[] {
  const candidates: DevProcessCandidate[] = [];
  for (const line of processList.split(/\r?\n/)) {
    const processMatch = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!processMatch) continue;
    const marker = processMatch[2]?.match(
      /(?:^|\s)selftune-dev:(supervisor|runtime|vite):([A-Za-z0-9_-]+)(?:\s|$)/,
    );
    if (!marker) continue;
    const pid = Number.parseInt(processMatch[1] ?? "", 10);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    try {
      const worktree = Buffer.from(marker[2] ?? "", "base64url").toString("utf8");
      if (!isAbsolute(worktree) || resolve(worktree) !== worktree || worktree.includes("\0")) {
        continue;
      }
      const role = marker[1];
      if (role !== "supervisor" && role !== "runtime" && role !== "vite") continue;
      candidates.push({ pid, role, worktree, orphan: !pathExists(worktree) });
    } catch {
      // Ignore malformed process-title markers from foreign processes.
    }
  }
  return candidates;
}

function validLoopbackUrl(rawUrl: string, expectedPort: number): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port === String(expectedPort) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validManifest(manifest: DevManifest, expectedWorktree?: string): boolean {
  if (!isAbsolute(manifest.worktree)) return false;
  if (resolve(manifest.worktree) !== manifest.worktree) return false;
  if (expectedWorktree !== undefined && manifest.worktree !== resolve(expectedWorktree))
    return false;
  const ports = Object.values(manifest.ports);
  if (!ports.every((port) => Number.isSafeInteger(port) && port > 0 && port <= 65_535)) {
    return false;
  }
  const pids = Object.values(manifest.pids);
  if (!pids.every((pid) => Number.isSafeInteger(pid) && pid > 1)) return false;
  if (!validLoopbackUrl(manifest.urls.dashboard, manifest.ports.dashboard)) return false;
  if (!validLoopbackUrl(manifest.urls.vite, manifest.ports.vite)) return false;
  if (manifest.auth_token.length < 32) return false;
  if (Number.isNaN(Date.parse(manifest.started_at))) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    manifest.instance_id,
  );
}

export function readDevManifest(worktree: string): DevManifest | null {
  const path = devManifestPath(worktree);
  if (!existsSync(path)) return null;
  try {
    const manifest = Schema.decodeUnknownSync(DevManifest)(JSON.parse(readFileSync(path, "utf8")));
    return validManifest(manifest, worktree) ? manifest : null;
  } catch {
    return null;
  }
}

export function writeDevManifest(manifest: DevManifest): void {
  if (!validManifest(manifest)) throw new TypeError("Refusing to write an invalid dev manifest.");
  const directory = join(manifest.worktree, ".selftune-dev");
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const path = devManifestPath(manifest.worktree);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function tokenMatches(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function inspectDevInstance(worktree: string): Promise<DevInstanceStatus> {
  const manifest = readDevManifest(worktree);
  if (!manifest) return { healthy: false, manifest: null, reason: "No valid dev manifest." };
  if (!Object.values(manifest.pids).every(processIsAlive)) {
    return { healthy: false, manifest, reason: "A manifest-owned process is not running." };
  }
  try {
    const controlResponse = await fetch(`http://127.0.0.1:${manifest.ports.control}`, {
      headers: { Authorization: `Bearer ${manifest.auth_token}` },
      signal: AbortSignal.timeout(1_000),
    });
    if (!controlResponse.ok) {
      return { healthy: false, manifest, reason: "The dev control endpoint rejected ownership." };
    }
    const identity = Schema.decodeUnknownSync(ControlIdentity)(await controlResponse.json());
    if (
      identity.instance_id !== manifest.instance_id ||
      identity.worktree !== manifest.worktree ||
      identity.supervisor_pid !== manifest.pids.supervisor
    ) {
      return { healthy: false, manifest, reason: "The dev control identity does not match." };
    }

    const [dashboardResponse, viteResponse] = await Promise.all([
      fetch(new URL("/api/health", manifest.urls.dashboard), {
        signal: AbortSignal.timeout(1_000),
      }),
      fetch(manifest.urls.vite, { signal: AbortSignal.timeout(1_000) }),
    ]);
    if (!dashboardResponse.ok || !viteResponse.ok) {
      return { healthy: false, manifest, reason: "The dashboard or Vite endpoint is unhealthy." };
    }
    const health = Schema.decodeUnknownSync(DashboardHealth)(await dashboardResponse.json());
    if (
      health.pid !== manifest.pids.runtime ||
      new URL(health.spa_proxy_url).origin !== new URL(manifest.urls.vite).origin
    ) {
      return { healthy: false, manifest, reason: "The dashboard identity does not match." };
    }
    return { healthy: true, manifest };
  } catch {
    return { healthy: false, manifest, reason: "The manifest-owned dev stack is unreachable." };
  }
}

export async function removeStaleDevManifest(worktree: string): Promise<boolean> {
  const path = devManifestPath(worktree);
  if (!existsSync(path)) return false;
  const manifest = readDevManifest(worktree);
  if (manifest) {
    const status = await inspectDevInstance(worktree);
    if (status.healthy || manifestHasOwnedProcess(manifest)) return false;
  }
  rmSync(path, { force: true });
  return true;
}

function manifestHasOwnedProcess(manifest: DevManifest): boolean {
  try {
    const processList = execFileSync(
      "ps",
      ["-p", Object.values(manifest.pids).join(","), "-o", "pid=,command="],
      { encoding: "utf8" },
    );
    return findDevProcessCandidates(processList).some(
      (candidate) =>
        candidate.worktree === manifest.worktree && manifest.pids[candidate.role] === candidate.pid,
    );
  } catch {
    return false;
  }
}

export function removeDevManifestIfOwned(worktree: string, instanceId: string): void {
  const manifest = readDevManifest(worktree);
  if (manifest?.instance_id === instanceId) {
    rmSync(devManifestPath(worktree), { force: true });
  }
}

function listen(
  server: Server | HttpServer,
  options: { readonly host: string; readonly port: number; readonly ipv6Only?: boolean },
): Promise<boolean> {
  return new Promise((done) => {
    server.once("error", () => done(false));
    server.listen(options, () => done(true));
  });
}

function close(server: Server | HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((done) => server.close(() => done()));
}

function isListening(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      done(false);
    });
  });
}

async function bindProbe(port: number): Promise<readonly Server[] | null> {
  const occupied = await Promise.all([isListening(port, "127.0.0.1"), isListening(port, "::1")]);
  if (occupied.some(Boolean)) return null;

  const ipv4 = createServer();
  if (!(await listen(ipv4, { host: "0.0.0.0", port }))) return null;

  const ipv6 = createServer();
  if (!(await listen(ipv6, { host: "::", port, ipv6Only: true }))) {
    await close(ipv4);
    return null;
  }
  return [ipv4, ipv6];
}

export async function claimDevPorts(worktree: string): Promise<DevPortClaim> {
  const preferred = preferredDevPortBlock(worktree);
  for (let attempt = 0; attempt < BLOCK_COUNT; attempt += 1) {
    const block =
      BLOCK_BASE + ((preferred - BLOCK_BASE + attempt * BLOCK_SIZE) % (BLOCK_COUNT * BLOCK_SIZE));
    let identity: DevManifest | null = null;
    const control = createHttpServer((request, response) => {
      const suppliedToken = request.headers.authorization?.startsWith("Bearer ")
        ? request.headers.authorization.slice("Bearer ".length)
        : "";
      if (identity === null || !tokenMatches(suppliedToken, identity.auth_token)) {
        response.writeHead(identity === null ? 503 : 401, { "Cache-Control": "no-store" });
        response.end();
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          service: "selftune-dev-control",
          instance_id: identity.instance_id,
          worktree: identity.worktree,
          supervisor_pid: identity.pids.supervisor,
        }),
      );
    });
    if (!(await listen(control, { host: "127.0.0.1", port: block + CONTROL_OFFSET }))) {
      continue;
    }

    const probes = await Promise.all(
      Array.from({ length: CONTROL_OFFSET }, (_, offset) => bindProbe(block + offset)),
    );
    const held = probes.flatMap((probe) => probe ?? []);
    if (probes.some((probe) => probe === null)) {
      await Promise.all([...held.map(close), close(control)]);
      continue;
    }

    let released = false;
    const releaseForBoot = async (): Promise<void> => {
      if (released) return;
      released = true;
      await Promise.all(held.map(close));
    };
    return {
      block,
      ports: {
        dashboard: block + DASHBOARD_OFFSET,
        vite: block + VITE_OFFSET,
        control: block + CONTROL_OFFSET,
      },
      authenticate: (manifest) => {
        if (
          manifest.worktree !== resolve(worktree) ||
          manifest.ports.dashboard !== block + DASHBOARD_OFFSET ||
          manifest.ports.vite !== block + VITE_OFFSET ||
          manifest.ports.control !== block + CONTROL_OFFSET
        ) {
          throw new TypeError("The dev control identity does not match its claimed port block.");
        }
        identity = manifest;
      },
      releaseForBoot,
      close: async () => {
        await releaseForBoot();
        await close(control);
      },
    };
  }
  throw new Error("No free SelfTune development port block is available in 42000-45999.");
}
