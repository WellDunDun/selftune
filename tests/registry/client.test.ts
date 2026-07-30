import { afterEach, describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Result, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  makeRegistryClientLayer,
  RegistryApiUrlError,
  RegistryAuthenticationError,
  RegistryClient,
  RegistryConfigError,
  RegistryDownloadSizeError,
  RegistryDownloadUrlError,
  RegistryHttpError,
  RegistryResponseDecodeError,
  RegistryResponseSizeError,
} from "../../packages/runtime/registry/client.js";
import type { PlatformCredentialStore } from "../../packages/runtime/credential-store.js";

const roots: string[] = [];
const credentials = new Map<string, string>();
const credentialStore: PlatformCredentialStore = {
  set: (account, value) => {
    credentials.set(account, value);
    return { provider: "file", account };
  },
  get: (reference) => credentials.get(reference.account) ?? null,
  delete: (reference) => {
    credentials.delete(reference.account);
  },
};

function makeConfig(responseUrl = "https://registry.test") {
  const root = mkdtempSync(join(tmpdir(), "selftune-registry-client-"));
  roots.push(root);
  const path = join(root, "config.json");
  const credential = credentialStore.set(`registry:${root}`, "registry-test-key", root);
  writeFileSync(
    path,
    JSON.stringify({
      agent_type: "unknown",
      cli_path: "/usr/local/bin/selftune",
      llm_mode: "agent",
      agent_cli: null,
      hooks_installed: false,
      initialized_at: "2026-07-17T00:00:00.000Z",
      alpha: {
        enrolled: true,
        user_id: "registry-test-user",
        consent_timestamp: "2026-07-17T00:00:00.000Z",
        cloud_api_url: responseUrl,
        credential,
      },
    }),
  );
  return path;
}

const credentialUrl = (username: string, password: string, host: string) =>
  `https://${username}:${password}@${host}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  credentials.clear();
});

function testLayer(
  configPath: string,
  execute: (request: HttpClientRequest.HttpClientRequest) => Response,
) {
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, execute(request))),
    ),
  );
  return makeRegistryClientLayer(configPath, { credentialStore }).pipe(
    Layer.provide(httpLayer),
    Layer.provide(BunServices.layer),
  );
}

describe("RegistryClient", () => {
  test("loads canonical config lazily and sends authenticated schema-decoded JSON", async () => {
    const configPath = makeConfig();
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const ResponseSchema = Schema.Struct({ ok: Schema.Boolean });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RegistryClient;
        return yield* client.request(ResponseSchema, {
          method: "POST",
          path: "/sync",
          body: { installations: [] },
        });
      }).pipe(
        Effect.provide(
          testLayer(configPath, (request) => {
            requests.push(request);
            return Response.json({ ok: true });
          }),
        ),
      ),
    );

    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://registry.test/api/v1/registry/sync");
    expect(requests[0]?.headers.authorization).toBe("Bearer registry-test-key");
    expect(requests[0]?.headers["user-agent"]).toStartWith("selftune/");
    expect(requests[0]?.body.toJSON()).toMatchObject({
      _tag: "Uint8Array",
      body: JSON.stringify({ installations: [] }),
      contentType: "application/json",
    });
  });

  test("normalizes the API origin before constructing registry routes", async () => {
    const configPath = makeConfig("https://registry.test/");
    let requestUrl = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RegistryClient;
        yield* client.request(Schema.Unknown, { method: "GET", path: "?name=deploy" });
      }).pipe(
        Effect.provide(
          testLayer(configPath, (request) => {
            requestUrl = request.url;
            return Response.json({});
          }),
        ),
      ),
    );

    expect(requestUrl).toBe("https://registry.test/api/v1/registry?name=deploy");
  });

  test("rejects unsafe or ambiguous configured API URLs before transport execution", async () => {
    const inputs = [
      "http://registry.test",
      credentialUrl("EXAMPLE_USER", "EXAMPLE_PASSWORD", "registry.test"),
      "https://registry.test/proxy",
      "https://registry.test?target=other",
      "https://registry.test#other",
    ];

    const outcomes = await Promise.all(
      inputs.map(async (input) => {
        const configPath = makeConfig(input);
        let requests = 0;
        const outcome = await Effect.runPromise(
          Effect.result(
            Effect.gen(function* () {
              const client = yield* RegistryClient;
              return yield* client.request(Schema.Unknown, { method: "GET", path: "" });
            }).pipe(
              Effect.provide(
                testLayer(configPath, () => {
                  requests++;
                  return Response.json({});
                }),
              ),
            ),
          ),
        );
        return { outcome, requests };
      }),
    );
    for (const { outcome, requests } of outcomes) {
      expect(Result.isFailure(outcome) && outcome.failure).toBeInstanceOf(RegistryApiUrlError);
      expect(requests).toBe(0);
    }
  });

  test("allows loopback HTTP API origins for local self-hosting", async () => {
    const configPath = makeConfig("http://127.0.0.1:8787");
    let requestUrl = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RegistryClient;
        yield* client.request(Schema.Unknown, { method: "GET", path: "" });
      }).pipe(
        Effect.provide(
          testLayer(configPath, (request) => {
            requestUrl = request.url;
            return Response.json({});
          }),
        ),
      ),
    );

    expect(requestUrl).toBe("http://127.0.0.1:8787/api/v1/registry");
  });

  test("distinguishes missing authentication from malformed canonical config", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-registry-client-config-"));
    roots.push(root);
    const missingPath = join(root, "missing.json");
    const malformedPath = join(root, "malformed.json");
    writeFileSync(malformedPath, "{not-json");
    let requests = 0;
    const program = Effect.gen(function* () {
      const client = yield* RegistryClient;
      return yield* client.request(Schema.Unknown, { method: "GET", path: "" });
    });
    const execute = () => {
      requests++;
      return Response.json({});
    };
    const missing = await Effect.runPromise(
      Effect.result(program.pipe(Effect.provide(testLayer(missingPath, execute)))),
    );
    const malformed = await Effect.runPromise(
      Effect.result(program.pipe(Effect.provide(testLayer(malformedPath, execute)))),
    );

    expect(Result.isFailure(missing) && missing.failure).toBeInstanceOf(
      RegistryAuthenticationError,
    );
    expect(Result.isFailure(malformed) && malformed.failure).toBeInstanceOf(RegistryConfigError);
    expect(requests).toBe(0);
  });

  test("returns typed HTTP and response decoding failures", async () => {
    const configPath = makeConfig();
    const schema = Schema.Struct({ entries: Schema.Array(Schema.String) });
    const request = Effect.gen(function* () {
      const client = yield* RegistryClient;
      return yield* client.request(schema, { method: "GET", path: "" });
    });
    const httpFailure = await Effect.runPromise(
      Effect.result(
        request.pipe(
          Effect.provide(
            testLayer(configPath, () => new Response("x".repeat(500), { status: 503 })),
          ),
        ),
      ),
    );
    const decodeFailure = await Effect.runPromise(
      Effect.result(
        request.pipe(Effect.provide(testLayer(configPath, () => Response.json({ entries: [1] })))),
      ),
    );

    expect(Result.isFailure(httpFailure) && httpFailure.failure).toBeInstanceOf(RegistryHttpError);
    if (Result.isFailure(httpFailure)) expect(httpFailure.failure.message).toHaveLength(310);
    expect(Result.isFailure(decodeFailure) && decodeFailure.failure).toBeInstanceOf(
      RegistryResponseDecodeError,
    );
  });

  test("stops streaming an API response after the bounded body limit", async () => {
    const configPath = makeConfig();
    const outcome = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const client = yield* RegistryClient;
          return yield* client.request(Schema.Unknown, { method: "GET", path: "" });
        }).pipe(
          Effect.provide(
            testLayer(
              configPath,
              () =>
                new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(new Uint8Array(1024 * 1024));
                      controller.enqueue(new Uint8Array([1]));
                      controller.close();
                    },
                  }),
                ),
            ),
          ),
        ),
      ),
    );

    expect(Result.isFailure(outcome) && outcome.failure).toBeInstanceOf(RegistryResponseSizeError);
  });

  test("keeps multipart content type under the transport's control", async () => {
    const configPath = makeConfig();
    let captured: HttpClientRequest.HttpClientRequest | undefined;
    const formData = new FormData();
    formData.append("metadata", "{}");
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RegistryClient;
        yield* client.request(Schema.Record(Schema.String, Schema.Unknown), {
          method: "POST",
          path: "",
          formData,
        });
      }).pipe(
        Effect.provide(
          testLayer(configPath, (request) => {
            captured = request;
            return Response.json({ success: true });
          }),
        ),
      ),
    );

    expect(captured?.headers["content-type"]).toBeUndefined();
    expect(captured?.body.toJSON()).toMatchObject({ _tag: "FormData" });
  });

  test("rejects oversized downloads before buffering a declared body", async () => {
    const configPath = makeConfig();
    const outcome = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const client = yield* RegistryClient;
          return yield* client.download("https://objects.test/archive");
        }).pipe(
          Effect.provide(
            testLayer(
              configPath,
              () =>
                new Response("", {
                  headers: { "content-length": String(16 * 1024 * 1024 + 1) },
                }),
            ),
          ),
        ),
      ),
    );

    expect(Result.isFailure(outcome) && outcome.failure).toBeInstanceOf(RegistryDownloadSizeError);
  });

  test("stops streaming an archive when the actual body exceeds the compressed limit", async () => {
    const configPath = makeConfig();
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const outcome = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const client = yield* RegistryClient;
          return yield* client.download("https://objects.test/archive");
        }).pipe(
          Effect.provide(
            testLayer(
              configPath,
              () =>
                new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(chunk);
                      controller.enqueue(chunk);
                      controller.enqueue(new Uint8Array([1]));
                      controller.close();
                    },
                  }),
                ),
            ),
          ),
        ),
      ),
    );

    expect(Result.isFailure(outcome) && outcome.failure).toBeInstanceOf(RegistryDownloadSizeError);
  });

  test("follows at most five validated download redirects", async () => {
    const configPath = makeConfig();
    const requests: string[] = [];
    const archive = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RegistryClient;
        return yield* client.download("https://objects.test/start");
      }).pipe(
        Effect.provide(
          testLayer(configPath, (request) => {
            requests.push(request.url);
            const current = new URL(request.url);
            const step = current.pathname === "/start" ? 0 : Number(current.pathname.slice(1));
            return step < 5
              ? new Response(null, { status: 302, headers: { location: `/${step + 1}` } })
              : new Response(new Uint8Array([1, 2, 3]));
          }),
        ),
      ),
    );

    expect(archive).toEqual(new Uint8Array([1, 2, 3]));
    expect(requests).toHaveLength(6);

    const overflow = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const client = yield* RegistryClient;
          return yield* client.download("https://objects.test/start");
        }).pipe(
          Effect.provide(
            testLayer(
              configPath,
              () => new Response(null, { status: 302, headers: { location: "/next" } }),
            ),
          ),
        ),
      ),
    );
    expect(Result.isFailure(overflow) && overflow.failure).toBeInstanceOf(RegistryHttpError);
    if (Result.isFailure(overflow)) expect(overflow.failure.message).toContain("5 redirects");
  });

  test("rejects credentials and insecure protocols introduced by download redirects", async () => {
    const configPath = makeConfig();
    const outcomes = await Promise.all(
      [
        `${credentialUrl("EXAMPLE_USER", "EXAMPLE_PASSWORD", "objects.test")}/archive`,
        "http://objects.test/archive",
      ].map(async (location) => {
        let requests = 0;
        const outcome = await Effect.runPromise(
          Effect.result(
            Effect.gen(function* () {
              const client = yield* RegistryClient;
              return yield* client.download("https://objects.test/start");
            }).pipe(
              Effect.provide(
                testLayer(configPath, () => {
                  requests++;
                  return new Response(null, { status: 302, headers: { location } });
                }),
              ),
            ),
          ),
        );
        return { outcome, requests };
      }),
    );
    for (const { outcome, requests } of outcomes) {
      expect(Result.isFailure(outcome) && outcome.failure).toBeInstanceOf(RegistryDownloadUrlError);
      expect(requests).toBe(1);
    }
  });

  test("rejects non-HTTPS remote archive URLs before transport execution", async () => {
    const configPath = makeConfig();
    let requests = 0;
    const outcome = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const client = yield* RegistryClient;
          return yield* client.download("http://objects.example/archive");
        }).pipe(
          Effect.provide(
            testLayer(configPath, () => {
              requests++;
              return new Response("");
            }),
          ),
        ),
      ),
    );

    expect(Result.isFailure(outcome) && outcome.failure).toBeInstanceOf(RegistryDownloadUrlError);
    expect(requests).toBe(0);
  });
});
