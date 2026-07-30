import { describe, expect, test } from "bun:test";

import { createOtlpRoutes, OtlpInvalidPayloadError } from "../src/routes/otlp.js";

const origin = "http://localhost";

function request(path: string, contentType: string, body: BodyInit | null = "payload"): Request {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

function handle(
  routes: ReturnType<typeof createOtlpRoutes>,
  requestValue: Request,
): Promise<Response | null> {
  return routes.handle(requestValue, new URL(requestValue.url));
}

async function errorCode(response: Response | null): Promise<string | undefined> {
  return (await response?.json())?.error?.code;
}

describe("OTLP HTTP routes", () => {
  test("passes both OTLP signals and encodings to the injected ingest seam", async () => {
    const received: Array<readonly [string, string, Uint8Array, AbortSignal]> = [];
    const routes = createOtlpRoutes((signal, encoding, body, abortSignal) =>
      received.push([signal, encoding, body, abortSignal]),
    );

    const traces = await handle(
      routes,
      request("/v1/traces", "application/json; charset=utf-8", "{}"),
    );
    const logs = await handle(
      routes,
      request("/v1/logs", "application/x-protobuf", new Uint8Array([1, 2])),
    );

    expect(traces?.status).toBe(200);
    expect(traces?.headers.get("content-type")).toBe("application/json");
    expect(await traces?.text()).toBe("{}");
    expect(logs?.status).toBe(200);
    expect(logs?.headers.get("content-type")).toBe("application/x-protobuf");
    expect((await logs?.arrayBuffer())?.byteLength).toBe(0);
    expect(received).toEqual([
      ["traces", "json", new TextEncoder().encode("{}"), expect.any(AbortSignal)],
      ["logs", "protobuf", new Uint8Array([1, 2]), expect.any(AbortSignal)],
    ]);
  });

  test("leaves unknown routes and methods to the enclosing server", async () => {
    const routes = createOtlpRoutes(() => undefined);
    const unknown = request("/v1/metrics", "application/json");
    const wrongMethod = new Request(`${origin}/v1/traces`, {
      headers: { "content-type": "application/json" },
    });

    expect(await handle(routes, unknown)).toBeNull();
    expect(await handle(routes, wrongMethod)).toBeNull();
  });

  test("rejects invalid content metadata and oversized declared or streamed bodies", async () => {
    const routes = createOtlpRoutes(() => undefined);
    const invalidLength = request("/v1/traces", "application/json");
    invalidLength.headers.set("content-length", "not-a-number");
    const declaredOversize = request("/v1/traces", "application/json");
    declaredOversize.headers.set("content-length", String(1024 * 1024 + 1));
    const streamedOversize = new Request(`${origin}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024 + 1));
          controller.close();
        },
      }),
    });

    expect(
      await errorCode(
        await handle(routes, request("/v1/logs", "application/x-protobuf; charset=utf-8")),
      ),
    ).toBe("OTLP_UNSUPPORTED_MEDIA_TYPE");
    expect(await errorCode(await handle(routes, invalidLength))).toBe("OTLP_BAD_REQUEST");
    expect(await errorCode(await handle(routes, declaredOversize))).toBe("OTLP_PAYLOAD_TOO_LARGE");
    expect(await errorCode(await handle(routes, streamedOversize))).toBe("OTLP_PAYLOAD_TOO_LARGE");
  });

  test("limits concurrent work and recovers capacity after it completes", async () => {
    const releases: Array<() => void> = [];
    let resolveAllStarted: (() => void) | undefined;
    const allStarted = new Promise<void>((resolve) => {
      resolveAllStarted = resolve;
    });
    const routes = createOtlpRoutes(() => {
      if (releases.length >= 4) return undefined;
      return new Promise<void>((resolve) => {
        releases.push(resolve);
        if (releases.length === 4) resolveAllStarted?.();
      });
    });
    const admitted = Array.from({ length: 4 }, () =>
      handle(routes, request("/v1/traces", "application/json")),
    );
    await allStarted;
    const throttled = await handle(routes, request("/v1/traces", "application/json"));

    expect(throttled?.status).toBe(429);
    expect(throttled?.headers.get("retry-after")).toBe("1");
    expect(await errorCode(throttled)).toBe("OTLP_TOO_MANY_REQUESTS");
    releases.forEach((release) => release());
    expect((await Promise.all(admitted)).map((response) => response?.status)).toEqual([
      200, 200, 200, 200,
    ]);
    expect((await handle(routes, request("/v1/logs", "application/json")))?.status).toBe(200);
  });

  test("retains timed-out work in the concurrency limit and aborts it", async () => {
    const abortSignals: AbortSignal[] = [];
    const routes = createOtlpRoutes((_signal, _encoding, _body, abortSignal) => {
      abortSignals.push(abortSignal);
      return new Promise<void>(() => undefined);
    });

    const timedOut = await Promise.all(
      Array.from({ length: 4 }, () => handle(routes, request("/v1/traces", "application/json"))),
    );
    const throttled = await handle(routes, request("/v1/logs", "application/json"));

    expect(timedOut.map((response) => response?.status)).toEqual([504, 504, 504, 504]);
    expect(abortSignals.every((abortSignal) => abortSignal.aborted)).toBe(true);
    expect(throttled?.status).toBe(429);
  }, 5_000);

  test("times out a stalled request body and releases its admission after cancellation", async () => {
    let cancelled = false;
    const routes = createOtlpRoutes(() => undefined);
    const stalled = new Request(`${origin}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel() {
          cancelled = true;
        },
      }),
    });

    expect((await handle(routes, stalled))?.status).toBe(504);
    await Bun.sleep(10);
    expect(cancelled).toBe(true);
    expect((await handle(routes, request("/v1/logs", "application/json")))?.status).toBe(200);
  }, 5_000);

  test("returns bounded failures for callback errors and invalid payloads, then recovers", async () => {
    let calls = 0;
    const routes = createOtlpRoutes(() => {
      calls += 1;
      if (calls === 1) throw new OtlpInvalidPayloadError();
      if (calls === 2) throw new Error("private callback detail");
    });

    const invalid = await handle(routes, request("/v1/traces", "application/json"));
    const failed = await handle(routes, request("/v1/logs", "application/json"));
    const recovered = await handle(routes, request("/v1/traces", "application/json"));

    expect(invalid?.status).toBe(400);
    expect(await errorCode(invalid)).toBe("OTLP_BAD_REQUEST");
    expect(failed?.status).toBe(500);
    expect(await errorCode(failed)).toBe("OTLP_INGEST_FAILED");
    expect(recovered?.status).toBe(200);
  }, 5_000);
});
