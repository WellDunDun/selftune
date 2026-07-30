import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CompatibilityExportWorker } from "@selftune/runtime/alpha-upload/worker";

import { startDashboardServer } from "../src/dashboard-server.js";

const directories: string[] = [];
const servers: Array<Awaited<ReturnType<typeof startDashboardServer>>> = [];
const authToken = "PLACEHOLDER_COMPATIBILITY_EXPORT_TOKEN";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryConfigDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "selftune-compatibility-export-"));
  directories.push(directory);
  return directory;
}

function trackedWorker(events: string[]): CompatibilityExportWorker {
  return {
    start: () => events.push("worker:start"),
    requestFlush: async () => null,
    status: () => ({ state: "stopped", lastSummary: null, lastError: null, nextAttemptAt: null }),
    stop: async () => {
      events.push("worker:stop");
    },
  };
}

test("the standalone local daemon owns exactly one compatibility-export worker", async () => {
  const events: string[] = [];
  const server = await startDashboardServer({
    authToken,
    compatibilityExportWorkerFactory: () => trackedWorker(events),
    host: "127.0.0.1",
    manageProcessSignals: false,
    openBrowser: false,
    port: 0,
    runtimeMode: "standalone",
    skillSetConfigRoot: temporaryConfigDirectory(),
  });
  servers.push(server);

  expect(events).toEqual(["worker:start"]);
  await server.close();
  expect(events).toEqual(["worker:start", "worker:stop"]);
});

test("test and selfhost hosts never start the cloud compatibility-export worker", async () => {
  const events: string[] = [];
  const testServer = await startDashboardServer({
    authToken,
    compatibilityExportWorkerFactory: () => trackedWorker(events),
    dashboardHost: "local",
    host: "127.0.0.1",
    manageProcessSignals: false,
    openBrowser: false,
    port: 0,
    runtimeMode: "test",
    skillSetConfigRoot: temporaryConfigDirectory(),
  });
  const selfhostServer = await startDashboardServer({
    authToken,
    compatibilityExportWorkerFactory: () => trackedWorker(events),
    dashboardHost: "selfhost",
    host: "127.0.0.1",
    manageProcessSignals: false,
    openBrowser: false,
    port: 0,
    runtimeMode: "standalone",
    skillSetConfigRoot: temporaryConfigDirectory(),
  });
  servers.push(testServer, selfhostServer);

  expect(events).toEqual([]);
});

test("a daemon bind failure stops its already-started compatibility-export worker", async () => {
  const blocker = await startDashboardServer({
    authToken,
    host: "127.0.0.1",
    manageProcessSignals: false,
    openBrowser: false,
    port: 0,
    runtimeMode: "test",
    skillSetConfigRoot: temporaryConfigDirectory(),
  });
  servers.push(blocker);
  const events: string[] = [];

  await expect(
    startDashboardServer({
      authToken,
      compatibilityExportWorkerFactory: () => trackedWorker(events),
      host: "127.0.0.1",
      manageProcessSignals: false,
      openBrowser: false,
      port: blocker.port,
      runtimeMode: "standalone",
      skillSetConfigRoot: temporaryConfigDirectory(),
    }),
  ).rejects.toThrow("Failed to start server");

  expect(events).toEqual(["worker:start", "worker:stop"]);
});
