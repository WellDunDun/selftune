import { SELFTUNE_CONFIG_PATH, loadConfig } from "@selftune/config";
import { Context, Duration, Effect, FileSystem, Layer, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  resolveCloudCredential,
  type CloudCredentialDependencies,
} from "../auth/cloud-credential.js";
import { DEFAULT_CLOUD_API_URL } from "../auth/device-code.js";
import { getSelftuneVersion } from "../utils/selftune-meta.js";
import { MAX_REGISTRY_ARCHIVE_COMPRESSED_BYTES } from "./archive-policy.js";

const REGISTRY_API_PATH = "/api/v1/registry";
const AUTHENTICATION_MESSAGE = "Not authenticated. Run 'selftune alpha upload' to set up.";
const MAX_REGISTRY_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_REGISTRY_DOWNLOAD_REDIRECTS = 5;
const REGISTRY_REQUEST_TIMEOUT = Duration.seconds(60);

export type RegistryHttpMethod = "GET" | "POST";

export interface RegistryRequestOptions {
  readonly method: RegistryHttpMethod;
  readonly path: string;
  readonly body?: unknown;
  readonly formData?: FormData;
}

export class RegistryAuthenticationError extends Schema.TaggedErrorClass<RegistryAuthenticationError>()(
  "RegistryAuthenticationError",
  { message: Schema.String },
) {}

export class RegistryConfigError extends Schema.TaggedErrorClass<RegistryConfigError>()(
  "RegistryConfigError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class RegistryTransportError extends Schema.TaggedErrorClass<RegistryTransportError>()(
  "RegistryTransportError",
  { message: Schema.String },
) {}

export class RegistryHttpError extends Schema.TaggedErrorClass<RegistryHttpError>()(
  "RegistryHttpError",
  {
    status: Schema.Number,
    message: Schema.String,
  },
) {}

export class RegistryResponseDecodeError extends Schema.TaggedErrorClass<RegistryResponseDecodeError>()(
  "RegistryResponseDecodeError",
  {
    status: Schema.Number,
    message: Schema.String,
  },
) {}

export class RegistryResponseSizeError extends Schema.TaggedErrorClass<RegistryResponseSizeError>()(
  "RegistryResponseSizeError",
  { message: Schema.String },
) {}

export class RegistryDownloadSizeError extends Schema.TaggedErrorClass<RegistryDownloadSizeError>()(
  "RegistryDownloadSizeError",
  { message: Schema.String },
) {}

export class RegistryDownloadUrlError extends Schema.TaggedErrorClass<RegistryDownloadUrlError>()(
  "RegistryDownloadUrlError",
  { message: Schema.String },
) {}

export class RegistryApiUrlError extends Schema.TaggedErrorClass<RegistryApiUrlError>()(
  "RegistryApiUrlError",
  { message: Schema.String },
) {}

export type RegistryClientError =
  | RegistryAuthenticationError
  | RegistryConfigError
  | RegistryTransportError
  | RegistryHttpError
  | RegistryResponseDecodeError
  | RegistryResponseSizeError
  | RegistryDownloadSizeError
  | RegistryDownloadUrlError
  | RegistryApiUrlError;

export interface RegistryClientService {
  readonly download: (url: string) => Effect.Effect<Uint8Array, RegistryClientError>;
  readonly request: <A>(
    schema: Schema.Decoder<A>,
    options: RegistryRequestOptions,
  ) => Effect.Effect<A, RegistryClientError>;
}

export class RegistryClient extends Context.Service<RegistryClient, RegistryClientService>()(
  "@selftune/runtime/RegistryClient",
) {}

function authenticationError(): RegistryAuthenticationError {
  return RegistryAuthenticationError.make({ message: AUTHENTICATION_MESSAGE });
}

function joinChunks(chunks: ReadonlyArray<Uint8Array>, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function responseText(response: HttpClientResponse.HttpClientResponse) {
  if (
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304 ||
    response.headers["content-length"] === "0"
  ) {
    return Effect.succeed("");
  }
  const declaredLength = Number.parseInt(response.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REGISTRY_API_RESPONSE_BYTES) {
    return Effect.fail(
      RegistryResponseSizeError.make({
        message: "Registry API response exceeds the 1 MiB size limit",
      }),
    );
  }
  return Stream.runFoldEffect(
    response.stream,
    (): { readonly chunks: ReadonlyArray<Uint8Array>; readonly size: number } => ({
      chunks: [],
      size: 0,
    }),
    (state, chunk) => {
      const size = state.size + chunk.byteLength;
      return size > MAX_REGISTRY_API_RESPONSE_BYTES
        ? Effect.fail(
            RegistryResponseSizeError.make({
              message: "Registry API response exceeds the 1 MiB size limit",
            }),
          )
        : Effect.succeed({ chunks: [...state.chunks, chunk], size });
    },
  ).pipe(
    Effect.map((state) => new TextDecoder().decode(joinChunks(state.chunks, state.size))),
    Effect.mapError((cause) =>
      cause instanceof RegistryResponseSizeError
        ? cause
        : RegistryTransportError.make({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
    ),
  );
}

const decodeResponse = Effect.fn("selftune.registry.decodeResponse")(function* <A>(
  schema: Schema.Decoder<A>,
  response: HttpClientResponse.HttpClientResponse,
) {
  const text = yield* responseText(response);
  if (response.status < 200 || response.status >= 300) {
    return yield* RegistryHttpError.make({
      status: response.status,
      message: `HTTP ${response.status}: ${text.slice(0, 300)}`,
    });
  }

  const parsed = yield* Effect.try({
    try: (): unknown => (text ? JSON.parse(text) : {}),
    catch: (cause) =>
      RegistryResponseDecodeError.make({
        status: response.status,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

  return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
    Effect.mapError((cause) =>
      RegistryResponseDecodeError.make({
        status: response.status,
        message: cause.message,
      }),
    ),
  );
});

function makeRequest(
  url: string,
  apiKey: string,
  options: RegistryRequestOptions,
): Effect.Effect<HttpClientRequest.HttpClientRequest, RegistryTransportError> {
  let request = HttpClientRequest.make(options.method)(url).pipe(
    HttpClientRequest.setHeader("Authorization", `Bearer ${apiKey}`),
    HttpClientRequest.setHeader("User-Agent", `selftune/${getSelftuneVersion()}`),
  );

  if (options.formData) {
    request = HttpClientRequest.bodyFormData(request, options.formData);
    return Effect.succeed(request);
  }
  if (options.body === undefined) return Effect.succeed(request);

  return HttpClientRequest.bodyJson(request, options.body).pipe(
    Effect.mapError((cause) =>
      RegistryTransportError.make({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
  );
}

function readBoundedArchive(response: HttpClientResponse.HttpClientResponse) {
  return Stream.runFoldEffect(
    response.stream,
    (): { readonly chunks: ReadonlyArray<Uint8Array>; readonly size: number } => ({
      chunks: [],
      size: 0,
    }),
    (state, chunk) => {
      const size = state.size + chunk.byteLength;
      return size > MAX_REGISTRY_ARCHIVE_COMPRESSED_BYTES
        ? Effect.fail(
            RegistryDownloadSizeError.make({
              message: "Registry archive exceeds the 16 MiB compressed size limit",
            }),
          )
        : Effect.succeed({ chunks: [...state.chunks, chunk], size });
    },
  ).pipe(
    Effect.map((state) => {
      return joinChunks(state.chunks, state.size);
    }),
    Effect.mapError((cause) =>
      cause instanceof RegistryDownloadSizeError
        ? cause
        : RegistryTransportError.make({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
    ),
  );
}

function isLoopbackUrl(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function hasSecureProtocol(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackUrl(url));
}

function validateDownloadUrl(input: string): Effect.Effect<string, RegistryDownloadUrlError> {
  return Effect.try({
    try: () => {
      const url = new URL(input);
      if (!hasSecureProtocol(url)) {
        throw new Error("Registry download URLs must use HTTPS");
      }
      if (url.username || url.password) {
        throw new Error("Registry download URLs must not contain credentials");
      }
      return url.toString();
    },
    catch: (cause) =>
      RegistryDownloadUrlError.make({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}

function resolveDownloadRedirect(
  location: string,
  currentUrl: string,
): Effect.Effect<string, RegistryDownloadUrlError> {
  return Effect.try({
    try: () => new URL(location, currentUrl).toString(),
    catch: (cause) =>
      RegistryDownloadUrlError.make({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }).pipe(Effect.flatMap(validateDownloadUrl));
}

function normalizeApiUrl(input: string): Effect.Effect<string, RegistryApiUrlError> {
  return Effect.try({
    try: () => {
      const url = new URL(input);
      if (!hasSecureProtocol(url)) {
        throw new Error("Registry API URLs must use HTTPS (HTTP is allowed only for loopback)");
      }
      if (url.username || url.password) {
        throw new Error("Registry API URLs must not contain credentials");
      }
      if (url.search || url.hash) {
        throw new Error("Registry API URLs must not contain a query or fragment");
      }
      if (url.pathname !== "/") {
        throw new Error("Registry API URLs must not contain a path");
      }
      return url.origin;
    },
    catch: (cause) =>
      RegistryApiUrlError.make({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}

function makeRegistryUrl(apiUrl: string, requestPath: string): string {
  const base = new URL(apiUrl);
  const queryIndex = requestPath.indexOf("?");
  const path = queryIndex === -1 ? requestPath : requestPath.slice(0, queryIndex);
  const search = queryIndex === -1 ? "" : requestPath.slice(queryIndex + 1);
  const basePath = base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}${REGISTRY_API_PATH}${path}`;
  base.search = search;
  return base.toString();
}

export function makeRegistryClientLayer(
  configPath = SELFTUNE_CONFIG_PATH,
  cloudCredentialDeps: CloudCredentialDependencies = {},
): Layer.Layer<RegistryClient, never, FileSystem.FileSystem | HttpClient.HttpClient> {
  return Layer.effect(
    RegistryClient,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const http = yield* HttpClient.HttpClient;
      const scopedHttp = HttpClient.withScope(http);

      const loadCredentials = Effect.fn("selftune.registry.loadCredentials")(function* () {
        const config = yield* loadConfig(configPath).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.mapError((cause) =>
            RegistryConfigError.make({
              path: configPath,
              message: cause instanceof Error ? cause.message : String(cause),
            }),
          ),
        );
        const apiKey = yield* Effect.try({
          try: () =>
            resolveCloudCredential(config, {
              ...cloudCredentialDeps,
              configPath,
            }),
          catch: (cause) =>
            RegistryConfigError.make({
              path: configPath,
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        if (!apiKey) return yield* authenticationError();

        return {
          apiUrl: yield* normalizeApiUrl(config?.alpha?.cloud_api_url || DEFAULT_CLOUD_API_URL),
          apiKey,
        };
      });

      const execute = Effect.fn("selftune.registry.execute")(function* (
        request: HttpClientRequest.HttpClientRequest,
      ) {
        return yield* scopedHttp.execute(request).pipe(
          Effect.mapError((cause) =>
            RegistryTransportError.make({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
          ),
        );
      });

      const downloadWithRedirects = Effect.fn("selftune.registry.downloadWithRedirects")(function* (
        initialUrl: string,
      ) {
        let currentUrl = yield* validateDownloadUrl(initialUrl);
        for (let redirects = 0; ; redirects++) {
          const response = yield* execute(HttpClientRequest.get(currentUrl));
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.location;
            if (!location) {
              return yield* RegistryHttpError.make({
                status: response.status,
                message: `Download failed: HTTP ${response.status} without a Location header`,
              });
            }
            if (redirects >= MAX_REGISTRY_DOWNLOAD_REDIRECTS) {
              return yield* RegistryHttpError.make({
                status: response.status,
                message: `Download failed: exceeded ${MAX_REGISTRY_DOWNLOAD_REDIRECTS} redirects`,
              });
            }
            currentUrl = yield* resolveDownloadRedirect(location, currentUrl);
            continue;
          }
          if (response.status < 200 || response.status >= 300) {
            return yield* RegistryHttpError.make({
              status: response.status,
              message: `Download failed: HTTP ${response.status}`,
            });
          }
          const declaredLength = Number.parseInt(response.headers["content-length"] ?? "", 10);
          if (
            Number.isFinite(declaredLength) &&
            declaredLength > MAX_REGISTRY_ARCHIVE_COMPRESSED_BYTES
          ) {
            return yield* RegistryDownloadSizeError.make({
              message: "Registry archive exceeds the 16 MiB compressed size limit",
            });
          }
          return yield* readBoundedArchive(response);
        }
      });

      return {
        download: (url: string) =>
          downloadWithRedirects(url).pipe(
            Effect.scoped,
            Effect.timeout(REGISTRY_REQUEST_TIMEOUT),
            Effect.catchTag("TimeoutError", () =>
              RegistryTransportError.make({
                message: "Registry download timed out after 60 seconds",
              }),
            ),
          ),
        request: <A>(schema: Schema.Decoder<A>, options: RegistryRequestOptions) =>
          Effect.gen(function* () {
            // Configuration stays lazy so local validation can fail before authentication or I/O.
            const credentials = yield* loadCredentials();
            const request = yield* makeRequest(
              makeRegistryUrl(credentials.apiUrl, options.path),
              credentials.apiKey,
              options,
            );
            const response = yield* execute(request);
            return yield* decodeResponse(schema, response);
          }).pipe(
            Effect.scoped,
            Effect.timeout(REGISTRY_REQUEST_TIMEOUT),
            Effect.catchTag("TimeoutError", () =>
              RegistryTransportError.make({
                message: "Registry request timed out after 60 seconds",
              }),
            ),
          ),
      };
    }),
  );
}

export const registryClientLayer = makeRegistryClientLayer();

export const registryRequest = Effect.fn("selftune.registry.request")(function* <A>(
  schema: Schema.Decoder<A>,
  options: RegistryRequestOptions,
) {
  const registry = yield* RegistryClient;
  return yield* registry.request(schema, options);
});
