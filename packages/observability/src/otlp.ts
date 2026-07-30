import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import OtlpRoot from "@opentelemetry/otlp-transformer/build/src/generated/root.js";

import { LocalTelemetryBatch } from "./trace-batch.js";

const MAX_GROUPS = 64;
const MAX_SIGNALS = 512;
const MAX_PER_KIND = 256;
const MAX_ATTRIBUTES = 64;
const MAX_VALUE_BYTES = 4 * 1024;
const MAX_VALUE_DEPTH = 8;

const OtlpSignal = Schema.Literals(["traces", "logs"]);
const OtlpEncoding = Schema.Literals(["json", "protobuf"]);

/** Versioned, transport-neutral OTLP receiver input. */
export class OtlpExportRequest extends Schema.Class<OtlpExportRequest>("OtlpExportRequest")({
  signal: OtlpSignal,
  encoding: OtlpEncoding,
  payload: Schema.Unknown,
}) {}

/** Deterministic local facts derived from one OTLP export request. */
export class NormalizedOtlpExport extends Schema.Class<NormalizedOtlpExport>(
  "NormalizedOtlpExport",
)({
  batch: LocalTelemetryBatch,
  source_revision: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
}) {}

/** Typed failures at the OTLP transport and normalization boundary. */
export class OtlpDecodeFailure extends Schema.TaggedErrorClass<OtlpDecodeFailure>()(
  "OtlpDecodeFailure",
  {
    reason: Schema.Literals([
      "unsupported_signal",
      "unsupported_encoding",
      "malformed_json",
      "malformed_protobuf",
      "invalid_id",
      "invalid_time",
      "over_limit",
      "invalid_payload",
    ]),
    message: Schema.String,
  },
) {}

type OtlpRoot = {
  opentelemetry: {
    proto: {
      collector: {
        trace: { v1: { ExportTraceServiceRequest: OtlpMessageType } };
        logs: { v1: { ExportLogsServiceRequest: OtlpMessageType } };
      };
    };
  };
};
type OtlpMessageType = {
  decode(input: Uint8Array): unknown;
  fromObject(input: object): unknown;
};
type OtlpRecord = Record<string, unknown>;

const generatedRoot = OtlpRoot as unknown as OtlpRoot;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const fail = (reason: OtlpDecodeFailure["reason"], message: string) =>
  Effect.fail(OtlpDecodeFailure.make({ reason, message }));

const stableHash = (domain: string, value: unknown) =>
  createHash("sha256").update(domain).update(canonicalJson(value)).digest("hex");

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString("hex"));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as OtlpRecord)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as OtlpRecord)[key])}`)
    .join(",")}}`;
};

const record = (value: unknown): OtlpRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as OtlpRecord)
    : undefined;
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const bytesToHex = (value: unknown): string | undefined => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (value === "") return "";
  if (typeof value === "string" && /^[0-9a-f]+$/i.test(value)) return value.toLowerCase();
  return undefined;
};

const compact = <T extends OtlpRecord>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as T;

const validId = (value: unknown, length: number) => {
  const id = bytesToHex(value);
  return id !== undefined && id.length === length && !/^0+$/.test(id) ? id : undefined;
};

const decimal = (value: unknown): string | undefined => {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  const item = record(value);
  if (item && number(item.low) !== undefined && number(item.high) !== undefined) {
    return String((BigInt(number(item.high)!) << 32n) + BigInt(number(item.low)! >>> 0));
  }
  return undefined;
};

const timestamp = (value: unknown): string | undefined => {
  const nanos = decimal(value);
  if (!nanos || BigInt(nanos) === 0n) return undefined;
  try {
    return new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString();
  } catch {
    return undefined;
  }
};

const checkValue = (value: unknown, depth = 0): OtlpDecodeFailure | undefined => {
  if (depth > MAX_VALUE_DEPTH)
    return OtlpDecodeFailure.make({
      reason: "over_limit",
      message: "OTLP value nesting exceeds 8",
    });
  if (typeof value === "string" && encoder.encode(value).byteLength > MAX_VALUE_BYTES) {
    return OtlpDecodeFailure.make({
      reason: "over_limit",
      message: "OTLP attribute value exceeds 4 KiB",
    });
  }
  if (value instanceof Uint8Array && value.byteLength > MAX_VALUE_BYTES) {
    return OtlpDecodeFailure.make({
      reason: "over_limit",
      message: "OTLP attribute value exceeds 4 KiB",
    });
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const failure = checkValue(child, depth + 1);
      if (failure) return failure;
    }
    return undefined;
  }
  const item = record(value);
  if (!item) return undefined;
  for (const child of Object.values(item)) {
    const failure = checkValue(child, depth + 1);
    if (failure) return failure;
  }
  return undefined;
};

const decodeAttributes = (
  value: unknown,
): Effect.Effect<Map<string, unknown>, OtlpDecodeFailure> => {
  const values = array(value);
  if (values.length > MAX_ATTRIBUTES) return fail("over_limit", "OTLP attributes exceed 64");
  const result = new Map<string, unknown>();
  for (const item of values) {
    const attribute = record(item);
    const key = attribute && string(attribute.key);
    if (!key) continue;
    const failure = checkValue(attribute.value);
    if (failure) return Effect.fail(failure);
    result.set(key, attribute.value);
  }
  return Effect.succeed(result);
};

const attributeString = (attributes: Map<string, unknown>, key: string): string | undefined => {
  const value = record(attributes.get(key));
  const result = value && string(value.stringValue);
  return result && result.length > 0 && result.length <= 256 ? result : undefined;
};
const attributeCount = (attributes: Map<string, unknown>, key: string): number => {
  const value = record(attributes.get(key));
  const integer = value && decimal(value.intValue);
  if (integer) {
    const parsed = BigInt(integer);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : 0;
  }
  const floating = value && number(value.doubleValue);
  return floating !== undefined && Number.isInteger(floating) && floating >= 0 ? floating : 0;
};

const platformFrom = (attributes: Map<string, unknown>) => {
  const platform = attributeString(attributes, "selftune.platform");
  return platform === "claude_code" ||
    platform === "codex" ||
    platform === "opencode" ||
    platform === "pi" ||
    platform === "cline"
    ? platform
    : "otlp";
};
const linkKind = (attributes: Map<string, unknown>) => {
  const kind = attributeString(attributes, "selftune.link.kind");
  return kind === "replay_of" ||
    kind === "evaluation_of" ||
    kind === "repair_of" ||
    kind === "evolution_of"
    ? kind
    : undefined;
};

/** OTLP JSON permits hexadecimal trace/span identifiers while protobufjs expects bytes/base64. */
const prepareJsonIds = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(prepareJsonIds);
  const item = record(value);
  if (!item) return value;
  return Object.fromEntries(
    Object.entries(item).map(([key, child]) => {
      const expectedLength =
        key === "traceId" ? 32 : key === "spanId" || key === "parentSpanId" ? 16 : 0;
      if (
        expectedLength > 0 &&
        typeof child === "string" &&
        new RegExp(`^[0-9a-fA-F]{${expectedLength}}$`).test(child)
      ) {
        return [key, Buffer.from(child, "hex").toString("base64")];
      }
      return [key, prepareJsonIds(child)];
    }),
  );
};

const decodePayload = (
  request: OtlpExportRequest,
): Effect.Effect<OtlpRecord, OtlpDecodeFailure> => {
  const type =
    request.signal === "traces"
      ? generatedRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest
      : generatedRoot.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest;
  try {
    if (request.encoding === "protobuf") {
      if (!(request.payload instanceof Uint8Array))
        return fail("invalid_payload", "protobuf OTLP payload must be Uint8Array");
      return Effect.succeed(type.decode(request.payload) as OtlpRecord);
    }
    const json =
      typeof request.payload === "string"
        ? JSON.parse(request.payload)
        : request.payload instanceof Uint8Array
          ? JSON.parse(decoder.decode(request.payload))
          : request.payload;
    if (!record(json)) return fail("malformed_json", "JSON OTLP payload must be an object");
    return Effect.succeed(type.fromObject(prepareJsonIds(json) as object) as OtlpRecord);
  } catch (error) {
    return fail(
      request.encoding === "protobuf" ? "malformed_protobuf" : "malformed_json",
      String(error),
    );
  }
};

/** Decode official OTLP JSON/protobuf and produce bounded, metadata-only local facts. */
export const normalizeOtlpExport = (
  input: unknown,
): Effect.Effect<NormalizedOtlpExport, OtlpDecodeFailure> =>
  Effect.gen(function* () {
    const envelope = record(input);
    if (
      envelope &&
      typeof envelope.signal === "string" &&
      envelope.signal !== "traces" &&
      envelope.signal !== "logs"
    )
      return yield* fail("unsupported_signal", `unsupported OTLP signal: ${envelope.signal}`);
    if (
      envelope &&
      typeof envelope.encoding === "string" &&
      envelope.encoding !== "json" &&
      envelope.encoding !== "protobuf"
    )
      return yield* fail("unsupported_encoding", `unsupported OTLP encoding: ${envelope.encoding}`);
    const request = yield* Schema.decodeUnknownEffect(OtlpExportRequest)(input).pipe(
      Effect.catchTag("SchemaError", (error) => fail("invalid_payload", error.message)),
    );
    if (request.signal !== "traces" && request.signal !== "logs")
      return yield* fail("unsupported_signal", "unsupported OTLP signal");
    if (request.encoding !== "json" && request.encoding !== "protobuf")
      return yield* fail("unsupported_encoding", "unsupported OTLP encoding");
    const decoded = yield* decodePayload(request);
    const groups = array(decoded[request.signal === "traces" ? "resourceSpans" : "resourceLogs"]);
    if (groups.length > MAX_GROUPS)
      return yield* fail("over_limit", "OTLP resource groups exceed 64");

    const resourcesById = new Map<string, OtlpRecord>();
    const scopesById = new Map<string, OtlpRecord>();
    const spans: unknown[] = [];
    const logs: unknown[] = [];
    const span_links: unknown[] = [];
    const spanIdentities = new Set<string>();
    const spanLinkIdentities = new Set<string>();
    let signalCount = 0;

    for (const [groupOrdinal, groupValue] of groups.entries()) {
      const group = record(groupValue) ?? {};
      const resourceAttributes = yield* decodeAttributes(record(group.resource)?.attributes);
      const service_name = attributeString(resourceAttributes, "service.name") ?? "otlp";
      const service_namespace = attributeString(resourceAttributes, "service.namespace");
      const service_version = attributeString(resourceAttributes, "service.version");
      const service_instance_id = attributeString(resourceAttributes, "service.instance.id");
      const deployment_environment = attributeString(
        resourceAttributes,
        "deployment.environment.name",
      );
      const schema_url = string(group.schemaUrl) ?? string(record(group.resource)?.schemaUrl);
      const platform = platformFrom(resourceAttributes);
      const resource_id = stableHash("selftune:otlp:resource:v1", {
        service_name,
        service_namespace,
        service_version,
        service_instance_id,
        deployment_environment,
        schema_url,
        platform,
      }).slice(0, 64);
      resourcesById.set(
        resource_id,
        compact({
          resource_id,
          service_name,
          service_namespace,
          service_version,
          service_instance_id,
          deployment_environment,
          schema_url,
          platform,
        }),
      );
      if (resourcesById.size > MAX_GROUPS)
        return yield* fail("over_limit", "OTLP unique resources exceed 64");
      const scopes = array(group[request.signal === "traces" ? "scopeSpans" : "scopeLogs"]);
      for (const [scopeOrdinal, scopeValue] of scopes.entries()) {
        const scopeGroup = record(scopeValue) ?? {};
        const scope = record(scopeGroup.scope) ?? {};
        const scopeAttributes = yield* decodeAttributes(scope.attributes);
        const name = string(scope.name) ?? "otlp";
        const version = string(scope.version);
        const scope_id = stableHash("selftune:otlp:scope:v1", {
          resource_id,
          name,
          version,
          attributes: [...scopeAttributes.entries()],
        }).slice(0, 64);
        scopesById.set(
          scope_id,
          compact({
            scope_id,
            resource_id,
            name,
            version,
            schema_url: string(scopeGroup.schemaUrl),
          }),
        );
        if (scopesById.size > MAX_GROUPS)
          return yield* fail("over_limit", "OTLP instrumentation scopes exceed 64");
        const signals = array(scopeGroup[request.signal === "traces" ? "spans" : "logRecords"]);
        if (signals.length > MAX_PER_KIND)
          return yield* fail("over_limit", "OTLP scope has more than 256 signals");
        signalCount += signals.length;
        if (signalCount > MAX_SIGNALS)
          return yield* fail("over_limit", "OTLP request has more than 512 signals");

        for (const [signalOrdinal, signalValue] of signals.entries()) {
          const signal = record(signalValue) ?? {};
          const signalAttributes = yield* decodeAttributes(signal.attributes);
          if (request.signal === "traces") {
            const trace_id = validId(signal.traceId, 32);
            const span_id = validId(signal.spanId, 16);
            const started_at = timestamp(signal.startTimeUnixNano);
            const ended_at = timestamp(signal.endTimeUnixNano);
            if (!trace_id || !span_id)
              return yield* fail("invalid_id", "OTLP span has an invalid trace or span ID");
            const spanIdentity = `${trace_id}:${span_id}`;
            if (spanIdentities.has(spanIdentity))
              return yield* fail(
                "invalid_payload",
                "OTLP export contains a duplicate trace/span identity",
              );
            spanIdentities.add(spanIdentity);
            if (!started_at || !ended_at)
              return yield* fail("invalid_time", "OTLP span has invalid timestamps");
            const parent_span_id =
              signal.parentSpanId == null || bytesToHex(signal.parentSpanId) === ""
                ? undefined
                : validId(signal.parentSpanId, 16);
            if (
              signal.parentSpanId != null &&
              bytesToHex(signal.parentSpanId) !== "" &&
              !parent_span_id
            )
              return yield* fail("invalid_id", "OTLP span has an invalid parent ID");
            const statusCode = record(signal.status) && number(record(signal.status)!.code);
            const status = statusCode === 2 ? "ERROR" : statusCode === 1 ? "OK" : "UNSET";
            const kind = (
              {
                0: "UNSPECIFIED",
                1: "INTERNAL",
                2: "SERVER",
                3: "CLIENT",
                4: "PRODUCER",
                5: "CONSUMER",
              } as const
            )[number(signal.kind) ?? 0];
            spans.push(
              compact({
                trace_id,
                span_id,
                name: string(signal.name) || "otlp",
                started_at,
                ended_at,
                platform,
                capture_mode: "otlp",
                source_authority: "external",
                trace_boundary: "external_trace",
                operation_name:
                  attributeString(signalAttributes, "gen_ai.operation.name") ??
                  string(signal.name) ??
                  "otlp",
                source_id:
                  attributeString(signalAttributes, "selftune.source.id") ??
                  stableHash("selftune:otlp:source:v1", { trace_id, span_id }).slice(0, 64),
                resource_id,
                scope_id,
                parent_span_id,
                kind,
                status,
                provider:
                  attributeString(signalAttributes, "gen_ai.provider.name") ??
                  attributeString(signalAttributes, "gen_ai.system"),
                model:
                  attributeString(signalAttributes, "gen_ai.request.model") ??
                  attributeString(signalAttributes, "gen_ai.response.model"),
                conversation_id: attributeString(signalAttributes, "gen_ai.conversation.id"),
                tool_name: attributeString(signalAttributes, "gen_ai.tool.name"),
                input_tokens: attributeCount(signalAttributes, "gen_ai.usage.input_tokens"),
                output_tokens: attributeCount(signalAttributes, "gen_ai.usage.output_tokens"),
                error_count:
                  status === "ERROR" || attributeString(signalAttributes, "error.type") ? 1 : 0,
                tool_call_count:
                  attributeString(signalAttributes, "gen_ai.tool.name") ||
                  attributeString(signalAttributes, "gen_ai.tool.call.id")
                    ? 1
                    : 0,
              }),
            );
            if (spans.length > MAX_PER_KIND)
              return yield* fail("over_limit", "OTLP request has more than 256 spans");
            const links = array(signal.links);
            if (links.length > MAX_PER_KIND)
              return yield* fail("over_limit", "OTLP span has more than 256 links");
            for (const linkValue of links) {
              const link = record(linkValue) ?? {};
              const linkAttributes = yield* decodeAttributes(link.attributes);
              const target_trace_id = validId(link.traceId, 32);
              const target_span_id =
                link.spanId == null || bytesToHex(link.spanId) === ""
                  ? undefined
                  : validId(link.spanId, 16);
              if (
                !target_trace_id ||
                (link.spanId != null && bytesToHex(link.spanId) !== "" && !target_span_id)
              )
                return yield* fail("invalid_id", "OTLP span link has invalid IDs");
              const link_id = stableHash("selftune:otlp:link:v1", {
                trace_id,
                span_id,
                target_trace_id,
                target_span_id,
                kind: linkKind(linkAttributes),
              }).slice(0, 32);
              if (spanLinkIdentities.has(link_id)) continue;
              spanLinkIdentities.add(link_id);
              span_links.push(
                compact({
                  link_id,
                  trace_id,
                  span_id,
                  target_trace_id,
                  target_span_id,
                  kind: linkKind(linkAttributes),
                }),
              );
              if (span_links.length > MAX_PER_KIND)
                return yield* fail("over_limit", "OTLP request has more than 256 span links");
            }
          } else {
            const trace_id = validId(signal.traceId, 32);
            const span_id =
              signal.spanId == null || bytesToHex(signal.spanId) === ""
                ? undefined
                : validId(signal.spanId, 16);
            const occurred_at =
              timestamp(signal.timeUnixNano) ?? timestamp(signal.observedTimeUnixNano);
            if (
              !trace_id ||
              (signal.spanId != null && bytesToHex(signal.spanId) !== "" && !span_id)
            )
              return yield* fail("invalid_id", "OTLP log has invalid correlation IDs");
            if (!occurred_at)
              return yield* fail("invalid_time", "OTLP log has an invalid timestamp");
            const event_name =
              string(signal.eventName) ??
              attributeString(signalAttributes, "event.name") ??
              "otlp.log";
            const severityNumber = number(signal.severityNumber) ?? 0;
            const severity =
              severityNumber >= 21
                ? "FATAL"
                : severityNumber >= 17
                  ? "ERROR"
                  : severityNumber >= 13
                    ? "WARN"
                    : severityNumber >= 9
                      ? "INFO"
                      : severityNumber >= 5
                        ? "DEBUG"
                        : severityNumber > 0
                          ? "TRACE"
                          : undefined;
            logs.push(
              compact({
                log_id: stableHash("selftune:otlp:log:v1", {
                  trace_id,
                  span_id,
                  occurred_at,
                  event_name,
                  groupOrdinal,
                  scopeOrdinal,
                  signalOrdinal,
                  scope_id,
                }).slice(0, 64),
                trace_id,
                span_id,
                timestamp: occurred_at,
                event_name,
                resource_id,
                scope_id,
                severity,
              }),
            );
            if (logs.length > MAX_PER_KIND)
              return yield* fail("over_limit", "OTLP request has more than 256 logs");
          }
        }
      }
    }
    const draft = {
      schema_version: "1.0.0" as const,
      semantic_convention_version: "1.0.0" as const,
      batch_id: "pending",
      spans,
      resources: [...resourcesById.values()],
      instrumentation_scopes: [...scopesById.values()],
      logs,
      span_links,
    };
    const source_revision = stableHash("selftune:otlp:source-revision:v1", draft);
    const batch = yield* Schema.decodeUnknownEffect(LocalTelemetryBatch)({
      ...draft,
      batch_id: stableHash("selftune:otlp:batch:v1", draft).slice(0, 64),
    }).pipe(Effect.catchTag("SchemaError", (error) => fail("invalid_payload", error.message)));
    return NormalizedOtlpExport.make({ batch, source_revision });
  });
