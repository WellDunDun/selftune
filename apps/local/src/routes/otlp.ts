const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 4;
const INGEST_TIMEOUT_MS = 2_000;
const noop = () => undefined;

export type OtlpSignal = "traces" | "logs";
export type OtlpEncoding = "json" | "protobuf";

export type OtlpIngest = (
  signal: OtlpSignal,
  encoding: OtlpEncoding,
  body: Uint8Array,
  abortSignal: AbortSignal,
) => void | Promise<void>;

export interface OtlpRoutes {
  readonly handle: (request: Request, url: URL) => Promise<Response | null>;
}

type OtlpFailureCode =
  | "OTLP_BAD_REQUEST"
  | "OTLP_PAYLOAD_TOO_LARGE"
  | "OTLP_UNSUPPORTED_MEDIA_TYPE"
  | "OTLP_TOO_MANY_REQUESTS"
  | "OTLP_INGEST_FAILED"
  | "OTLP_INGEST_TIMEOUT";

export class OtlpInvalidPayloadError extends Error {
  readonly _tag = "OtlpInvalidPayloadError";
}

function failure(status: number, code: OtlpFailureCode, retryAfter?: string): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(JSON.stringify({ error: { code } }), { status, headers });
}

function contentEncoding(contentType: string | null): OtlpEncoding | null {
  if (contentType === null) return null;
  const normalized = contentType.trim().toLowerCase();
  if (normalized === "application/x-protobuf") return "protobuf";
  if (normalized === "application/json" || normalized === "application/json; charset=utf-8") {
    return "json";
  }
  return null;
}

function declaredBodyLength(contentLength: string | null): number | null | "invalid" {
  if (contentLength === null) return null;
  if (!/^\d+$/.test(contentLength)) return "invalid";
  const length = Number(contentLength);
  return Number.isSafeInteger(length) ? length : "invalid";
}

type BodyReadResult = Uint8Array | "invalid" | "too_large";

async function readBoundedBody(
  request: Request,
  abortSignal: AbortSignal,
): Promise<BodyReadResult> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let cancel = noop;
  const aborted = new Promise<"aborted">((resolve) => {
    cancel = () => {
      void reader.cancel().catch(() => undefined);
      resolve("aborted");
    };
  });
  if (abortSignal.aborted) cancel();
  else abortSignal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- request streams must be consumed sequentially
      const result = await Promise.race([reader.read(), aborted]);
      if (result === "aborted") return "invalid";
      const { done, value } = result;
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        // oxlint-disable-next-line no-await-in-loop -- stop an oversized incoming stream promptly
        await reader.cancel();
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    return "invalid";
  } finally {
    abortSignal.removeEventListener("abort", cancel);
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function success(encoding: OtlpEncoding): Response {
  if (encoding === "protobuf") {
    return new Response(null, {
      status: 200,
      headers: { "content-type": "application/x-protobuf" },
    });
  }
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function createOtlpRoutes(ingest: OtlpIngest): OtlpRoutes {
  let activeRequests = 0;

  const handle = async (request: Request, url: URL): Promise<Response | null> => {
    const signal: OtlpSignal | null =
      url.pathname === "/v1/traces" ? "traces" : url.pathname === "/v1/logs" ? "logs" : null;
    if (signal === null || request.method !== "POST") return null;

    const encoding = contentEncoding(request.headers.get("content-type"));
    if (encoding === null) return failure(415, "OTLP_UNSUPPORTED_MEDIA_TYPE");

    const contentLength = declaredBodyLength(request.headers.get("content-length"));
    if (contentLength === "invalid") return failure(400, "OTLP_BAD_REQUEST");
    if (contentLength !== null && contentLength > MAX_BODY_BYTES) {
      return failure(413, "OTLP_PAYLOAD_TOO_LARGE");
    }
    if (activeRequests >= MAX_ACTIVE_REQUESTS) {
      return failure(429, "OTLP_TOO_MANY_REQUESTS", "1");
    }

    activeRequests += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        activeRequests -= 1;
      }
    };
    let retainAdmission = false;
    try {
      const controller = new AbortController();
      const completion = Promise.resolve()
        .then(async () => {
          const body = await readBoundedBody(request, controller.signal);
          if (body === "invalid") return "bad_request" as const;
          if (body === "too_large") return "payload_too_large" as const;
          await ingest(signal, encoding, body, controller.signal);
          return "complete" as const;
        })
        .then(
          (outcome) => outcome,
          (cause: unknown) =>
            cause instanceof OtlpInvalidPayloadError ? ("invalid" as const) : ("failed" as const),
        );
      void completion.then(release);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        completion,
        new Promise<"timeout">((resolve) => {
          timeout = setTimeout(() => resolve("timeout"), INGEST_TIMEOUT_MS);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (outcome === "timeout") {
        retainAdmission = true;
        controller.abort();
        return failure(504, "OTLP_INGEST_TIMEOUT");
      }
      if (outcome === "bad_request") return failure(400, "OTLP_BAD_REQUEST");
      if (outcome === "payload_too_large") return failure(413, "OTLP_PAYLOAD_TOO_LARGE");
      if (outcome === "invalid") return failure(400, "OTLP_BAD_REQUEST");
      if (outcome === "failed") return failure(500, "OTLP_INGEST_FAILED");
      return success(encoding);
    } finally {
      if (!retainAdmission) release();
    }
  };

  return { handle };
}
