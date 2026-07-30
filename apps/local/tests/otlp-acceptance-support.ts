import { DuckDBInstance } from "@duckdb/node-api";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveSelftunePaths } from "@selftune/config";
import { openDb } from "@selftune/local-store";
import { LocalTraceImporter } from "@selftune/observability/local-trace-importer";
import { LocalTelemetryBatch, LocalTelemetrySpan } from "@selftune/observability/trace-batch";
import { makeDuckDbNodeApiAnalyticalStoreLive } from "@selftune/observability/duckdb-node-api";
import { normalizeOtlpExport } from "@selftune/observability/otlp";
import { makeLocalTraceImporterLive } from "@selftune/orchestration/sync/local-trace-importer";

import { startDashboardServer } from "../src/dashboard-server.js";

export const token = "PLACEHOLDER_OTLP_ACCEPTANCE_TOKEN";
const traceId = "ASNFZ4mrze8BI0VniavN7w==";
const spanId = "ASNFZ4mrze8=";
const directories: string[] = [];
const servers: Array<Awaited<ReturnType<typeof startDashboardServer>>> = [];

export const cleanup = async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
};
export const trace = () => ({
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "acceptance-agent" } },
          { key: "service.instance.id", value: { stringValue: "desktop-1" } },
          { key: "selftune.platform", value: { stringValue: "codex" } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "acceptance.instrumentation", version: "1.0" },
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
                { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
                { key: "gen_ai.request.model", value: { stringValue: "gpt-5" } },
                { key: "gen_ai.conversation.id", value: { stringValue: "conversation-1" } },
                { key: "gen_ai.tool.name", value: { stringValue: "bash" } },
                { key: "gen_ai.usage.input_tokens", value: { intValue: "11" } },
                { key: "gen_ai.usage.output_tokens", value: { intValue: "7" } },
              ],
            },
          ],
        },
      ],
    },
  ],
});
export const logs = () => ({
  resourceLogs: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "acceptance-agent" } }],
      },
      scopeLogs: [
        {
          scope: { name: "acceptance.instrumentation", version: "1.0" },
          logRecords: [
            {
              traceId,
              spanId,
              timeUnixNano: "1784800800500000000",
              severityNumber: 9,
              attributes: [{ key: "event.name", value: { stringValue: "agent.progress" } }],
            },
          ],
        },
      ],
    },
  ],
});
export function root(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
const pathsFor = (directory: string) =>
  resolveSelftunePaths({
    environment: { SELFTUNE_CONFIG_DIR: directory },
    homeDirectory: directory,
  });
export async function facts(directory: string) {
  const instance = await DuckDBInstance.create(pathsFor(directory).localAnalyticsPath);
  const connection = await instance.connect();
  const query = async (sql: string) => (await connection.runAndReadAll(sql)).getRowObjects();
  try {
    return {
      batches: await query(
        "SELECT source_revision, normalizer_version FROM observability_ingested_batches ORDER BY batch_id",
      ),
      spans: await query(
        "SELECT platform, capture_mode, source_authority, trace_boundary, provider, model, kind, status, conversation_id, tool_name FROM observability_spans",
      ),
      metrics: await query(
        "SELECT metric_name, value, unit FROM observability_metrics ORDER BY metric_name",
      ),
      resources: await query(
        "SELECT service_name, service_instance_id, platform FROM observability_resources ORDER BY resource_id",
      ),
      scopes: await query(
        "SELECT scope_name, scope_version FROM observability_instrumentation_scopes ORDER BY scope_id",
      ),
      logs: await query("SELECT event_name, severity FROM observability_logs"),
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
export function checkpoints(directory: string, sourceKind = "otlp") {
  const database = new Database(pathsFor(directory).localDatabasePath, { readonly: true });
  try {
    return Number(
      database
        .query("SELECT count(*) AS count FROM analytical_import_checkpoints WHERE source_kind = ?")
        .get(sourceKind)?.count,
    );
  } finally {
    database.close();
  }
}
export async function start(directory: string) {
  const server = await startDashboardServer({
    port: 0,
    host: "127.0.0.1",
    authToken: token,
    openBrowser: false,
    manageProcessSignals: false,
    skillSetConfigRoot: directory,
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
export const stop = async () => {
  await servers.pop()?.close();
};
export const post = (origin: string, path: string, body: BodyInit, contentType: string) =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": contentType },
    body,
  });
const importer = (directory: string) => {
  const paths = pathsFor(directory);
  const database = openDb(paths.localDatabasePath);
  const layer = Layer.provide(
    makeLocalTraceImporterLive(database),
    makeDuckDbNodeApiAnalyticalStoreLive(paths.localAnalyticsPath),
  );
  const run = (request: object) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* LocalTraceImporter).importTrace(request);
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
  return { database, run };
};
export async function importOtlpDirect(directory: string) {
  const local = importer(directory);
  try {
    const traceNormalized = await Effect.runPromise(
      normalizeOtlpExport({ signal: "traces", encoding: "json", payload: trace() }),
    );
    await local.run({
      source_kind: "otlp",
      source_revision: traceNormalized.source_revision,
      normalizer_version: "otlp-v1",
      batch: traceNormalized.batch,
    });
    const logsNormalized = await Effect.runPromise(
      normalizeOtlpExport({ signal: "logs", encoding: "json", payload: logs() }),
    );
    await local.run({
      source_kind: "otlp",
      source_revision: logsNormalized.source_revision,
      normalizer_version: "otlp-v1",
      batch: logsNormalized.batch,
    });
  } finally {
    local.database.close();
  }
}
export async function importNativeCodex(directory: string, schemaVersion = "1.0.0") {
  const local = importer(directory);
  try {
    const batch = LocalTelemetryBatch.make({
      schema_version: "1.0.0",
      semantic_convention_version: "1.0.0",
      batch_id: "codex-native-batch",
      links: [],
      spans: [
        LocalTelemetrySpan.make({
          trace_id: "0123456789abcdef0123456789abcdef",
          span_id: "0123456789abcdef",
          name: "codex rollout",
          started_at: "2026-07-23T10:00:00.000Z",
          ended_at: "2026-07-23T10:00:01.000Z",
          platform: "codex",
          capture_mode: "rollout",
          source_authority: "source_truth",
          trace_boundary: "actionable_turn",
          operation_name: "invoke_agent",
          source_id: "codex-native-source",
          input_tokens: 1,
          output_tokens: 2,
          error_count: 0,
          tool_call_count: 1,
        }),
      ],
    });
    await local.run({
      source_kind: "codex",
      source_revision: "codex-native-1",
      normalizer_version: "native-v1",
      batch: schemaVersion === "1.0.0" ? batch : { ...batch, schema_version: schemaVersion },
    });
  } finally {
    local.database.close();
  }
}
export const localPaths = pathsFor;
