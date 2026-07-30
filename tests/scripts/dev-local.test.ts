import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimDevPorts,
  devManifestPath,
  encodeDevProcessTitle,
  findDevProcessCandidates,
  inspectDevInstance,
  preferredDevPortBlock,
  removeStaleDevManifest,
  writeDevManifest,
  type DevManifest,
} from "../../scripts/dev-local-state";

const listeners: Server[] = [];
const temporaryDirectories: string[] = [];
const bunServers: ReturnType<typeof Bun.serve>[] = [];

async function listen(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  listeners.push(server);
  return server;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all(bunServers.splice(0).map((server) => server.stop(true)));
  await Promise.all(listeners.splice(0).map(close));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("worktree-safe local development", () => {
  test("walks atomically from an occupied preferred port block", async () => {
    const worktree = "/tmp/selftune-worktree-a";
    const preferred = preferredDevPortBlock(worktree);
    await listen(preferred + 5);

    const claim = await claimDevPorts(worktree);
    try {
      expect(claim.block).toBe(preferred + 10);
      expect(claim.ports).toEqual({
        dashboard: preferred + 10,
        vite: preferred + 11,
        control: preferred + 19,
      });
    } finally {
      await claim.close();
    }
  });

  test("gives colliding worktrees different blocks when they claim concurrently", async () => {
    const firstWorktree = "/tmp/selftune-collision-a";
    const preferred = preferredDevPortBlock(firstWorktree);
    let secondWorktree = "";
    for (let index = 0; index < 10_000; index += 1) {
      const candidate = `/tmp/selftune-collision-${index}`;
      if (preferredDevPortBlock(candidate) === preferred) {
        secondWorktree = candidate;
        break;
      }
    }
    expect(secondWorktree).not.toBe("");

    const [first, second] = await Promise.all([
      claimDevPorts(firstWorktree),
      claimDevPorts(secondWorktree),
    ]);
    try {
      expect(new Set([first.block, second.block]).size).toBe(2);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  test("discovers only the authenticated healthy HMR instance for this worktree", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "selftune-dev-worktree-"));
    temporaryDirectories.push(worktree);
    const claim = await claimDevPorts(worktree);
    await claim.releaseForBoot();

    const dashboardUrl = `http://127.0.0.1:${claim.ports.dashboard}`;
    const viteUrl = `http://127.0.0.1:${claim.ports.vite}`;
    bunServers.push(
      Bun.serve({
        hostname: "127.0.0.1",
        port: claim.ports.dashboard,
        fetch: () =>
          Response.json({
            ok: true,
            service: "selftune-dashboard",
            pid: process.pid,
            process_mode: "dev-server",
            spa_mode: "proxy",
            spa_proxy_url: viteUrl,
          }),
      }),
      Bun.serve({
        hostname: "127.0.0.1",
        port: claim.ports.vite,
        fetch: () => new Response("vite hmr"),
      }),
    );

    const manifest: DevManifest = {
      version: 1,
      kind: "selftune-dev",
      worktree,
      urls: { dashboard: dashboardUrl, vite: viteUrl },
      ports: claim.ports,
      pids: { supervisor: process.pid, runtime: process.pid, vite: process.pid },
      mode: "hmr",
      package_version: "0.2.33",
      instance_id: crypto.randomUUID(),
      started_at: new Date().toISOString(),
      auth_token: "a".repeat(43),
    };
    claim.authenticate(manifest);
    writeDevManifest(manifest);

    expect(statSync(devManifestPath(worktree)).mode & 0o777).toBe(0o600);
    expect(await inspectDevInstance(worktree)).toEqual({ healthy: true, manifest });
    expect(await removeStaleDevManifest(worktree)).toBe(false);

    await claim.close();
    expect(await removeStaleDevManifest(worktree)).toBe(true);
  });

  test("removes a stale manifest without signaling an unproven process", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "selftune-dev-stale-"));
    temporaryDirectories.push(worktree);
    const preferred = preferredDevPortBlock(worktree);
    const manifest: DevManifest = {
      version: 1,
      kind: "selftune-dev",
      worktree,
      urls: {
        dashboard: `http://127.0.0.1:${preferred}`,
        vite: `http://127.0.0.1:${preferred + 1}`,
      },
      ports: { dashboard: preferred, vite: preferred + 1, control: preferred + 9 },
      pids: { supervisor: process.pid, runtime: 99_992, vite: 99_993 },
      mode: "hmr",
      package_version: "0.2.33",
      instance_id: crypto.randomUUID(),
      started_at: new Date().toISOString(),
      auth_token: "b".repeat(43),
    };
    writeDevManifest(manifest);

    expect((await inspectDevInstance(worktree)).healthy).toBe(false);
    expect(await removeStaleDevManifest(worktree)).toBe(true);
    expect(existsSync(devManifestPath(worktree))).toBe(false);

    mkdirSync(join(worktree, ".selftune-dev"), { recursive: true });
    writeFileSync(devManifestPath(worktree), "not a manifest\n");
    expect(await removeStaleDevManifest(worktree)).toBe(true);
    expect(existsSync(devManifestPath(worktree))).toBe(false);
  });

  test("reaping selects only explicitly owned processes whose worktree is gone", () => {
    const live = "/tmp/selftune-live";
    const removed = "/tmp/selftune-removed";
    const processList = [
      `101 ${encodeDevProcessTitle("supervisor", live)}`,
      `102 ${encodeDevProcessTitle("runtime", removed)}`,
      "103 bun run apps/local/src/dashboard-server.ts --port 7888",
      "104 vite --strictPort --port 5199",
    ].join("\n");

    expect(findDevProcessCandidates(processList, (path) => path === live)).toEqual([
      { pid: 101, role: "supervisor", worktree: live, orphan: false },
      { pid: 102, role: "runtime", worktree: removed, orphan: true },
    ]);
  });
});
