import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { flow } from "effect";
import { traceExportCodec } from "../../packages/observability/src/otlp-codec.js";

import { normalizeOtlpExport } from "../../packages/observability/src/otlp.js";

const bytes = (hex: string) => Buffer.from(hex, "hex").toString("base64");
const traceId = bytes("11111111111111111111111111111111");
const spanId = bytes("2222222222222222");
const alternateSpanId = bytes("5555555555555555");
const linkedTraceId = bytes("33333333333333333333333333333333");
const linkedSpanId = bytes("4444444444444444");

const fixture = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "agent-host" } },
          { key: "service.version", value: { stringValue: "1.2.3" } },
          { key: "selftune.platform", value: { stringValue: "codex" } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "integration", version: "1" },
          spans: [
            {
              traceId,
              spanId,
              name: "invoke agent",
              kind: 5,
              startTimeUnixNano: "1700000000000000000",
              endTimeUnixNano: "1700000001000000000",
              attributes: [
                { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
                { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
                { key: "gen_ai.request.model", value: { stringValue: "gpt-test" } },
                { key: "gen_ai.conversation.id", value: { stringValue: "conversation-42" } },
                { key: "gen_ai.tool.name", value: { stringValue: "shell" } },
                {
                  key: "gen_ai.tool.call.arguments",
                  value: { stringValue: "private tool arguments" },
                },
                {
                  key: "gen_ai.tool.call.result",
                  value: { stringValue: "private tool result" },
                },
                { key: "gen_ai.usage.input_tokens", value: { intValue: "12" } },
                { key: "gen_ai.usage.output_tokens", value: { intValue: 8 } },
                { key: "gen_ai.input.messages", value: { stringValue: "never persist this" } },
              ],
              links: [
                {
                  traceId: linkedTraceId,
                  spanId: linkedSpanId,
                  attributes: [
                    { key: "selftune.link.kind", value: { stringValue: "evaluation_of" } },
                  ],
                },
              ],
              status: { code: 2, message: "private failure detail" },
            },
          ],
        },
      ],
    },
  ],
};

const normalize = flow(normalizeOtlpExport, Effect.runPromise);

describe("OTLP codec", () => {
  test.each([
    { input: null, reason: "invalid_payload" },
    { input: { signal: "metrics", encoding: "json", payload: {} }, reason: "unsupported_signal" },
    { input: { signal: "traces", encoding: "xml", payload: {} }, reason: "unsupported_encoding" },
    { input: { signal: "traces", encoding: "json", payload: [] }, reason: "malformed_json" },
    {
      input: { signal: "traces", encoding: "protobuf", payload: "not-bytes" },
      reason: "invalid_payload",
    },
    {
      input: { signal: "traces", encoding: "json", payload: { resourceSpans: () => [] } },
      reason: "malformed_json",
    },
  ])("retains typed failures for malformed transport input: $reason", async ({ input, reason }) => {
    const error = await Effect.runPromise(normalizeOtlpExport(input).pipe(Effect.flip));
    expect(error.reason).toBe(reason);
  });

  test("normalizes equivalent official JSON and protobuf into the same receipt facts", async () => {
    const type = traceExportCodec;
    const protobuf = type.encode(type.fromObject(fixture)).finish();
    const [json, jsonBytes, binary] = await Promise.all([
      normalize({ signal: "traces", encoding: "json", payload: fixture }),
      normalize({
        signal: "traces",
        encoding: "json",
        payload: new TextEncoder().encode(JSON.stringify(fixture)),
      }),
      normalize({ signal: "traces", encoding: "protobuf", payload: protobuf }),
    ]);

    expect(binary).toEqual(json);
    expect(jsonBytes).toEqual(json);
    expect(json.source_revision).toHaveLength(64);
    // Existing v1 receipts retain their identities after boundary validation changes.
    expect(json.source_revision).toBe(
      "6a387a02675df923ecff5d302cee823a9ede441d99fa8d01fc43f296f3e2b932",
    );
    expect(json.batch.batch_id).toBe(
      "61b20314dcac7dbccda99cee91cb6801e6935d7ba3f1f75319070772069c8e97",
    );
    expect(json.batch.resources).toHaveLength(1);
    expect(json.batch.instrumentation_scopes?.[0]?.resource_id).toBe(
      json.batch.resources?.[0]?.resource_id,
    );
    expect(json.batch.spans[0]).toMatchObject({
      provider: "openai",
      model: "gpt-test",
      input_tokens: 12,
      output_tokens: 8,
      conversation_id: "conversation-42",
      tool_name: "shell",
      status: "ERROR",
      kind: "CONSUMER",
    });
    expect(JSON.stringify(json.batch)).not.toContain("never persist this");
    expect(JSON.stringify(json.batch)).not.toContain("private failure detail");
    expect(JSON.stringify(json.batch)).not.toContain("private tool arguments");
    expect(JSON.stringify(json.batch)).not.toContain("private tool result");
    expect(json.batch.spans[0]?.trace_boundary).toBe("external_trace");
    expect(json.batch.span_links?.[0]).toMatchObject({ kind: "evaluation_of" });
    expect(
      (await normalize({ signal: "traces", encoding: "json", payload: fixture })).batch.batch_id,
    ).toBe(json.batch.batch_id);
  });

  test("deduplicates repeated dimensions without accepting duplicate span identities", async () => {
    const sameDimensions = structuredClone(fixture.resourceSpans[0]);
    sameDimensions.scopeSpans[0].spans[0].spanId = alternateSpanId;
    const repeated = await normalize({
      signal: "traces",
      encoding: "json",
      payload: { resourceSpans: [fixture.resourceSpans[0], sameDimensions] },
    });
    expect(repeated.batch.resources).toHaveLength(1);
    expect(repeated.batch.instrumentation_scopes).toHaveLength(1);
    expect(repeated.batch.spans).toHaveLength(2);

    const other = structuredClone(fixture.resourceSpans[0]);
    other.scopeSpans[0].spans[0].spanId = alternateSpanId;
    other.resource.attributes.push({
      key: "service.instance.id",
      value: { stringValue: "other-instance" },
    });
    const distinct = await normalize({
      signal: "traces",
      encoding: "json",
      payload: { resourceSpans: [fixture.resourceSpans[0], other] },
    });
    expect(distinct.batch.resources).toHaveLength(2);
    expect(distinct.batch.resources?.[0]?.resource_id).not.toBe(
      distinct.batch.resources?.[1]?.resource_id,
    );
    const duplicate = await Effect.runPromiseExit(
      normalizeOtlpExport({
        signal: "traces",
        encoding: "json",
        payload: { resourceSpans: [fixture.resourceSpans[0], fixture.resourceSpans[0]] },
      }),
    );
    expect(duplicate._tag).toBe("Failure");
    const repeatedLink = structuredClone(fixture);
    repeatedLink.resourceSpans[0].scopeSpans[0].spans[0].links.push(
      structuredClone(repeatedLink.resourceSpans[0].scopeSpans[0].spans[0].links[0]),
    );
    expect(
      (await normalize({ signal: "traces", encoding: "json", payload: repeatedLink })).batch
        .span_links,
    ).toHaveLength(1);
  });

  test("normalizes correlated metadata-only logs and rejects malformed or excessive input", async () => {
    const logs = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              scope: { name: "events" },
              logRecords: [
                {
                  traceId,
                  spanId,
                  timeUnixNano: "1700000000000000000",
                  eventName: "skill.inferred",
                  body: { stringValue: "secret body" },
                  attributes: [{ key: "event.name", value: { stringValue: "ignored-name" } }],
                },
              ],
            },
          ],
        },
      ],
    };
    const normalized = await normalize({ signal: "logs", encoding: "json", payload: logs });
    expect(normalized.batch.logs?.[0]).toMatchObject({ event_name: "skill.inferred" });
    expect(JSON.stringify(normalized.batch)).not.toContain("secret body");
    const repeatedLogs = structuredClone(logs);
    repeatedLogs.resourceLogs[0].scopeLogs[0].logRecords.push(
      structuredClone(repeatedLogs.resourceLogs[0].scopeLogs[0].logRecords[0]),
    );
    const duplicated = await normalize({ signal: "logs", encoding: "json", payload: repeatedLogs });
    expect(duplicated.batch.logs).toHaveLength(2);
    expect(duplicated.batch.logs?.[0]?.log_id).not.toBe(duplicated.batch.logs?.[1]?.log_id);

    const uncorrelated = await Effect.runPromiseExit(
      normalizeOtlpExport({
        signal: "logs",
        encoding: "json",
        payload: { resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: "1" }] }] }] },
      }),
    );
    expect(uncorrelated._tag).toBe("Failure");
    const tooMany = {
      ...fixture,
      resourceSpans: Array.from({ length: 65 }, () => fixture.resourceSpans[0]),
    };
    const limited = await Effect.runPromiseExit(
      normalizeOtlpExport({ signal: "traces", encoding: "json", payload: tooMany }),
    );
    expect(limited._tag).toBe("Failure");
    const malformed = await Effect.runPromiseExit(
      normalizeOtlpExport({
        signal: "traces",
        encoding: "protobuf",
        payload: new Uint8Array([255]),
      }),
    );
    expect(malformed._tag).toBe("Failure");
  });
});
