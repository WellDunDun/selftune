import { afterEach, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSelftunePaths } from "@selftune/config";

import { startDashboardServer } from "../src/dashboard-server.js";

const AUTH_TOKEN = "PLACEHOLDER_OTLP_DASHBOARD_TOKEN";
const traceId = "0123456789abcdef0123456789abcdef";
const spanId = "0123456789abcdef";
const directories: string[] = [];
const servers: Array<Awaited<ReturnType<typeof startDashboardServer>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function otlpTrace() {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "selftune-agent" } },
            { key: "selftune.platform", value: { stringValue: "codex" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "agent.runtime", version: "1.0.0" },
            spans: [
              {
                traceId,
                spanId,
                name: "agent.turn",
                kind: 1,
                startTimeUnixNano: "1784800800000000000",
                endTimeUnixNano: "1784800801000000000",
                status: { code: 1 },
                attributes: [
                  {
                    key: "gen_ai.request.model",
                    value: { stringValue: "gpt-5" },
                  },
                ],
                links: [{ traceId: "fedcba9876543210fedcba9876543210" }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function otlpLog() {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "selftune-agent" } },
            { key: "selftune.platform", value: { stringValue: "codex" } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "agent.runtime", version: "1.0.0" },
            logRecords: [
              {
                traceId,
                spanId,
                timeUnixNano: "1784800800500000000",
                severityNumber: 9,
                attributes: [
                  {
                    key: "event.name",
                    value: { stringValue: "agent.progress" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function countRows(databasePath: string, table: string): Promise<number> {
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(`SELECT count(*) AS count FROM ${table}`);
    const row = reader.getRowObjects()[0];
    return Number(row?.count);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

test("imports authenticated loopback OTLP trace and log exports through the shared runtime", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "selftune-otlp-dashboard-"));
  directories.push(configDirectory);
  const server = await startDashboardServer({
    port: 0,
    host: "127.0.0.1",
    authToken: AUTH_TOKEN,
    openBrowser: false,
    manageProcessSignals: false,
    skillSetConfigRoot: configDirectory,
  });
  servers.push(server);
  const paths = resolveSelftunePaths({
    environment: { SELFTUNE_CONFIG_DIR: configDirectory },
    homeDirectory: configDirectory,
  });
  expect(existsSync(paths.localAnalyticsPath)).toBe(true);
  const origin = `http://127.0.0.1:${server.port}`;
  const request = (path: string, payload: object, token = AUTH_TOKEN) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

  expect((await request("/v1/traces", otlpTrace(), "wrong-token")).status).toBe(401);
  expect((await request("/v1/traces", otlpTrace())).status).toBe(200);
  expect((await request("/v1/traces", otlpTrace())).status).toBe(200);
  expect((await request("/v1/logs", otlpLog())).status).toBe(200);
  await server.close();

  expect(await countRows(paths.localAnalyticsPath, "observability_resources")).toBe(2);
  expect(await countRows(paths.localAnalyticsPath, "observability_instrumentation_scopes")).toBe(2);
  expect(await countRows(paths.localAnalyticsPath, "observability_spans")).toBe(1);
  expect(await countRows(paths.localAnalyticsPath, "observability_logs")).toBe(1);
  expect(await countRows(paths.localAnalyticsPath, "observability_ingested_batches")).toBe(2);
  const sqlite = new Database(paths.localDatabasePath, { readonly: true });
  try {
    expect(
      sqlite
        .query(
          "SELECT count(*) AS count FROM analytical_import_checkpoints WHERE source_kind = 'otlp'",
        )
        .get(),
    ).toEqual({ count: 2 });
  } finally {
    sqlite.close();
  }
});

test("does not expose OTLP without loopback authentication", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "selftune-otlp-dashboard-disabled-"));
  directories.push(configDirectory);
  const unauthenticated = await startDashboardServer({
    port: 0,
    host: "127.0.0.1",
    openBrowser: false,
    manageProcessSignals: false,
    skillSetConfigRoot: configDirectory,
  });
  servers.push(unauthenticated);
  expect(
    (
      await fetch(`http://127.0.0.1:${unauthenticated.port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(otlpTrace()),
      })
    ).status,
  ).toBe(404);

  const selfhost = await startDashboardServer({
    port: 0,
    host: "127.0.0.1",
    authToken: AUTH_TOKEN,
    dashboardHost: "selfhost",
    openBrowser: false,
    manageProcessSignals: false,
    skillSetConfigRoot: configDirectory,
  });
  servers.push(selfhost);
  expect(
    (
      await fetch(`http://127.0.0.1:${selfhost.port}/v1/traces`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify(otlpTrace()),
      })
    ).status,
  ).toBe(404);
});
