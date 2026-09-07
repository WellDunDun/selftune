import OtlpRoot from "@opentelemetry/otlp-transformer/build/src/generated/root.js";
import { Predicate, Schema } from "effect";

type ProtobufMessageCodec = Pick<
  ReturnType<typeof OtlpRoot.lookupType>,
  "decode" | "fromObject" | "encode"
>;

// The generated runtime exports static message constructors, but its declaration
// describes a reflective protobuf Root. Check the static codec interface here;
// callers still validate decoded messages before treating them as local facts.
const MessageCodec = Schema.declare<ProtobufMessageCodec>(
  (value): value is ProtobufMessageCodec =>
    Predicate.isFunction(value) &&
    "decode" in value &&
    Predicate.isFunction(value.decode) &&
    "fromObject" in value &&
    Predicate.isFunction(value.fromObject) &&
    "encode" in value &&
    Predicate.isFunction(value.encode),
);

const Root = Schema.Struct({
  opentelemetry: Schema.Struct({
    proto: Schema.Struct({
      collector: Schema.Struct({
        trace: Schema.Struct({ v1: Schema.Struct({ ExportTraceServiceRequest: MessageCodec }) }),
        logs: Schema.Struct({ v1: Schema.Struct({ ExportLogsServiceRequest: MessageCodec }) }),
      }),
    }),
  }),
});

const root = Schema.decodeUnknownSync(Root)(OtlpRoot);
export const traceExportCodec =
  root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
export const logExportCodec = root.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest;
