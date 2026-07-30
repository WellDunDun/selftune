import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireRuntimeLock,
  daemonManifestPath,
  loadOrCreateLocalAuthToken,
  loadOrCreateLocalAuthTokenWithDependencies,
  readServerManifest,
  readSupervisedDaemonManifest,
  removeDaemonManifestIfOwned,
  rotateLocalAuthToken,
  writeServerManifest,
  type RuntimeOwner,
  type RuntimeSupervision,
  type ServerManifest,
} from "@selftune/local/local-runtime";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryConfigRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "selftune-runtime-"));
  roots.push(root);
  return root;
}

function expectOwnerOnlyFile(path: string): void {
  const metadata = statSync(path);
  expect(metadata.isFile()).toBe(true);
  if (process.platform !== "win32") {
    expect(metadata.mode & 0o777).toBe(0o600);
  }
}

function runtimeManifest(
  owner: RuntimeOwner,
  supervision: RuntimeSupervision,
  pid = 1234,
): ServerManifest {
  return {
    version: 2,
    kind: "selftune-runtime",
    pid,
    port: 7888,
    origin: "http://127.0.0.1:7888",
    started_at: "2026-07-15T00:00:00.000Z",
    owner,
    supervision,
    owner_version: "0.3.0",
    owner_executable_path: "/opt/selftune/selftune",
    instance_id: "c85d9351-7171-44b7-988a-3cb9e949bce7",
  };
}

describe("local runtime durability", () => {
  it("creates and rotates an owner-only local token", () => {
    const root = temporaryConfigRoot();
    const first = loadOrCreateLocalAuthToken(root);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(loadOrCreateLocalAuthToken(root)).toBe(first);
    expectOwnerOnlyFile(join(root, "server-control", "auth.json"));
    expect(rotateLocalAuthToken(root)).not.toBe(first);
  });

  it("returns the persisted winner when first-start token creation interleaves", () => {
    const root = temporaryConfigRoot();
    const firstCandidate = "a".repeat(43);
    const winningCandidate = "b".repeat(43);
    let contenderResult = "";

    const firstResult = loadOrCreateLocalAuthTokenWithDependencies(root, {
      createToken: () => firstCandidate,
      beforeCommit: () => {
        contenderResult = loadOrCreateLocalAuthTokenWithDependencies(root, {
          createToken: () => winningCandidate,
        });
      },
    });

    const persisted: unknown = JSON.parse(
      readFileSync(join(root, "server-control", "auth.json"), "utf8"),
    );
    expect(contenderResult).toBe(winningCandidate);
    expect(firstResult).toBe(winningCandidate);
    expect(persisted).toEqual({ version: 1, token: winningCandidate });
    expect(readdirSync(join(root, "server-control"))).toEqual(["auth.json"]);
  });

  it("only removes a manifest owned by the terminating process", () => {
    const root = temporaryConfigRoot();
    writeServerManifest(root, runtimeManifest("cli", "os-service"));
    expect(readSupervisedDaemonManifest(root)?.pid).toBe(1234);
    expectOwnerOnlyFile(daemonManifestPath(root));

    removeDaemonManifestIfOwned(root, 9999);
    expect(readFileSync(daemonManifestPath(root), "utf8")).toContain("1234");
    removeDaemonManifestIfOwned(root, 1234);
    expect(readSupervisedDaemonManifest(root)).toBeNull();
  });

  it("records owner and supervision independently", () => {
    const root = temporaryConfigRoot();
    const cases: ReadonlyArray<readonly [RuntimeOwner, RuntimeSupervision]> = [
      ["desktop", "desktop-child"],
      ["desktop", "os-service"],
      ["cli", "os-service"],
      ["cli", "none"],
    ];

    for (const [owner, supervision] of cases) {
      writeServerManifest(root, runtimeManifest(owner, supervision));
      expect(readServerManifest(root)).toMatchObject({ owner, supervision });
      expect(readSupervisedDaemonManifest(root) !== null).toBe(supervision === "os-service");
    }
  });

  it("rejects ownership combinations with no valid lifecycle authority", () => {
    const root = temporaryConfigRoot();

    expect(() => writeServerManifest(root, runtimeManifest("desktop", "none"))).toThrow(
      "invalid daemon manifest",
    );
    expect(() => writeServerManifest(root, runtimeManifest("cli", "desktop-child"))).toThrow(
      "invalid daemon manifest",
    );
  });

  it("reads the legacy service manifest conservatively as CLI-owned", () => {
    const root = temporaryConfigRoot();
    mkdirSync(join(root, "server-control"));
    writeFileSync(
      daemonManifestPath(root),
      JSON.stringify({
        version: 1,
        kind: "supervised-daemon",
        pid: 1234,
        port: 7888,
        origin: "http://127.0.0.1:7888",
        started_at: "2026-07-15T00:00:00.000Z",
        owner_version: "0.3.0",
        owner_executable_path: "/opt/selftune/selftune",
        instance_id: "c85d9351-7171-44b7-988a-3cb9e949bce7",
      }),
    );

    expect(readServerManifest(root)).toMatchObject({
      version: 2,
      owner: "cli",
      supervision: "os-service",
    });
  });

  it("rejects forged manifests and holds one runtime lock per state directory", async () => {
    const root = temporaryConfigRoot();
    mkdirSync(join(root, "server-control"));
    writeFileSync(
      daemonManifestPath(root),
      JSON.stringify({
        ...runtimeManifest("cli", "os-service", -1),
        pid: -1,
        origin: "https://attacker.example",
      }),
    );
    expect(readSupervisedDaemonManifest(root)).toBeNull();

    const lock = acquireRuntimeLock(root, "c85d9351-7171-44b7-988a-3cb9e949bce7");
    expect(() => acquireRuntimeLock(root, "cb9c1aa9-6bc6-42d0-9f00-7080b67bf319")).toThrow(
      "already owned",
    );
    await lock.stop();
  });
});
