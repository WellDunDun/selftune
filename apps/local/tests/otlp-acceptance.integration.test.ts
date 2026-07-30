import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import OtlpRoot from "../../../packages/observability/node_modules/@opentelemetry/otlp-transformer/build/src/generated/root.js";

import {
  checkpoints,
  cleanup,
  facts,
  importNativeCodex,
  importOtlpDirect,
  localPaths,
  logs,
  post,
  root,
  start,
  stop,
  trace,
} from "./otlp-acceptance-support.js";

afterEach(cleanup);

test("has one golden trace-plus-log outcome for direct, JSON, and official protobuf ingress", async () => {
  const direct = root("selftune-otlp-direct-");
  const json = root("selftune-otlp-json-");
  const protobuf = root("selftune-otlp-protobuf-");
  await importOtlpDirect(direct);
  const jsonOrigin = await start(json);
  expect(
    (await post(jsonOrigin, "/v1/traces", JSON.stringify(trace()), "application/json")).status,
  ).toBe(200);
  expect(
    (await post(jsonOrigin, "/v1/logs", JSON.stringify(logs()), "application/json")).status,
  ).toBe(200);
  const protobufOrigin = await start(protobuf);
  const traceService = OtlpRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
  const logService = OtlpRoot.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest;
  expect(
    (
      await post(
        protobufOrigin,
        "/v1/traces",
        traceService.encode(traceService.fromObject(trace())).finish(),
        "application/x-protobuf",
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await post(
        protobufOrigin,
        "/v1/logs",
        logService.encode(logService.fromObject(logs())).finish(),
        "application/x-protobuf",
      )
    ).status,
  ).toBe(200);
  await stop();
  await stop();
  const expected = await facts(direct);
  expect(expected.batches).toHaveLength(2);
  expect(expected.metrics).toHaveLength(5);
  expect(expected.resources).toHaveLength(2);
  expect(expected.scopes).toHaveLength(2);
  expect(expected).toMatchObject({
    spans: [
      expect.objectContaining({
        platform: "codex",
        source_authority: "external",
        trace_boundary: "external_trace",
        provider: "openai",
        model: "gpt-5",
        kind: "INTERNAL",
        status: "OK",
        conversation_id: "conversation-1",
        tool_name: "bash",
      }),
    ],
    metrics: expect.any(Array),
    resources: expect.any(Array),
    scopes: expect.any(Array),
    logs: [expect.objectContaining({ event_name: "agent.progress", severity: "INFO" })],
  });
  expect(await facts(json)).toEqual(expected);
  expect(await facts(protobuf)).toEqual(expected);
  expect([checkpoints(direct), checkpoints(json), checkpoints(protobuf)]).toEqual([2, 2, 2]);
});

test("replay after restart and checkpoint failure both converge without fact inflation", async () => {
  const directory = root("selftune-otlp-recovery-");
  expect(
    (await post(await start(directory), "/v1/traces", JSON.stringify(trace()), "application/json"))
      .status,
  ).toBe(200);
  await stop();
  const beforeReplay = await facts(directory);
  expect(
    (await post(await start(directory), "/v1/traces", JSON.stringify(trace()), "application/json"))
      .status,
  ).toBe(200);
  await stop();
  const replay = await facts(directory);
  expect(replay).toEqual(beforeReplay);
  const failing = root("selftune-otlp-failing-");
  const failingOrigin = await start(failing);
  const database = new Database(localPaths(failing).localDatabasePath);
  database.run(
    "CREATE TRIGGER fail_otlp_checkpoint BEFORE INSERT ON analytical_import_checkpoints WHEN NEW.source_kind = 'otlp' BEGIN SELECT RAISE(ABORT, 'private checkpoint failure'); END",
  );
  database.close();
  const failed = await post(
    failingOrigin,
    "/v1/traces",
    JSON.stringify(trace()),
    "application/json",
  );
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain("private checkpoint failure");
  await stop();
  const beforeRecovery = await facts(failing);
  expect(beforeRecovery.spans).toHaveLength(1);
  expect(checkpoints(failing)).toBe(0);
  const repaired = new Database(localPaths(failing).localDatabasePath);
  repaired.run("DROP TRIGGER fail_otlp_checkpoint");
  repaired.close();
  expect(
    (await post(await start(failing), "/v1/traces", JSON.stringify(trace()), "application/json"))
      .status,
  ).toBe(200);
  await stop();
  expect(await facts(failing)).toEqual(beforeRecovery);
  expect(checkpoints(failing)).toBe(1);
});

test("malformed OTLP fails closed while native Codex remains importable in the same store", async () => {
  const directory = root("selftune-otlp-fail-open-");
  expect((await post(await start(directory), "/v1/traces", "{", "application/json")).status).toBe(
    400,
  );
  await stop();
  const afterMalformed = await facts(directory);
  expect(afterMalformed.batches).toHaveLength(0);
  expect(afterMalformed.spans).toHaveLength(0);
  expect(afterMalformed.logs).toHaveLength(0);
  await importNativeCodex(directory);
  const nativeFacts = await facts(directory);
  expect(nativeFacts.spans).toEqual([
    expect.objectContaining({
      platform: "codex",
      capture_mode: "rollout",
      source_authority: "source_truth",
      trace_boundary: "actionable_turn",
    }),
  ]);
  expect(checkpoints(directory, "otlp")).toBe(0);
  expect(checkpoints(directory, "codex")).toBe(1);
  await expect(importNativeCodex(directory, "9.9.9")).rejects.toMatchObject({
    _tag: "LocalTraceImportFailure",
  });
  expect(await facts(directory)).toEqual(nativeFacts);
  expect(checkpoints(directory, "codex")).toBe(1);
});
