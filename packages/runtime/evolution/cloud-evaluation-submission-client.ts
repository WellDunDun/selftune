/**
 * Desktop-to-Cloud transport for a bounded evaluation submission.
 *
 * The caller supplies only the portable review artifact. Credentials are read
 * at this process boundary and never become part of the artifact or response.
 */
import { loadConfigSync, SELFTUNE_CONFIG_PATH } from "@selftune/config";
import {
  buildEvaluationSubmission,
  type EvaluationSubmissionV1,
} from "@selftune/dashboard-core/review/portable";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  resolveCloudCredential,
  type CloudCredentialDependencies,
} from "../auth/cloud-credential.js";
import { DEFAULT_CLOUD_API_URL } from "../auth/device-code.js";

const CLOUD_EVALUATION_SUBMISSION_PATH = "/api/v1/cloud/evaluation-submissions";
const CLOUD_REQUEST_TIMEOUT_MS = 20_000;
const MAX_CLOUD_RESPONSE_BYTES = 64 * 1024;

const CloudEvaluationSubmissionReceipt = Schema.Struct({
  run_id: Schema.String,
  status: Schema.String,
  dispatch: Schema.Literal("scheduled"),
});

const CloudRejection = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
});

export type CloudEvaluationSubmissionReceipt = typeof CloudEvaluationSubmissionReceipt.Type;

export class CloudEvaluationSubmissionInputError extends Schema.TaggedErrorClass<CloudEvaluationSubmissionInputError>()(
  "CloudEvaluationSubmissionInputError",
  { message: Schema.String },
) {}

export class CloudEvaluationSubmissionNotLinkedError extends Schema.TaggedErrorClass<CloudEvaluationSubmissionNotLinkedError>()(
  "CloudEvaluationSubmissionNotLinkedError",
  { message: Schema.String },
) {}

export class CloudEvaluationSubmissionTransportError extends Schema.TaggedErrorClass<CloudEvaluationSubmissionTransportError>()(
  "CloudEvaluationSubmissionTransportError",
  { message: Schema.String },
) {}

export class CloudEvaluationSubmissionRejectedError extends Schema.TaggedErrorClass<CloudEvaluationSubmissionRejectedError>()(
  "CloudEvaluationSubmissionRejectedError",
  { status: Schema.Number, code: Schema.String, message: Schema.String },
) {}

export class CloudEvaluationSubmissionResponseError extends Schema.TaggedErrorClass<CloudEvaluationSubmissionResponseError>()(
  "CloudEvaluationSubmissionResponseError",
  { status: Schema.Number, message: Schema.String },
) {}

export type CloudEvaluationSubmissionError =
  | CloudEvaluationSubmissionInputError
  | CloudEvaluationSubmissionNotLinkedError
  | CloudEvaluationSubmissionTransportError
  | CloudEvaluationSubmissionRejectedError
  | CloudEvaluationSubmissionResponseError;

export interface CloudEvaluationSubmissionClientService {
  readonly submit: (
    input: unknown,
  ) => Effect.Effect<CloudEvaluationSubmissionReceipt, CloudEvaluationSubmissionError>;
}

export class CloudEvaluationSubmissionClient extends Context.Service<
  CloudEvaluationSubmissionClient,
  CloudEvaluationSubmissionClientService
>()("@selftune/runtime/CloudEvaluationSubmissionClient") {}

export interface CloudEvaluationSubmissionClientDependencies {
  readonly configPath?: string;
  readonly credentialDependencies?: CloudCredentialDependencies;
  readonly fetch?: typeof globalThis.fetch;
}

function submissionInput(
  input: unknown,
): Effect.Effect<EvaluationSubmissionV1, CloudEvaluationSubmissionInputError> {
  return Effect.try({
    try: () => buildEvaluationSubmission(input as EvaluationSubmissionV1),
    catch: () =>
      CloudEvaluationSubmissionInputError.make({
        message: "Evaluation submission is invalid or contains unsafe local data.",
      }),
  });
}

function cloudUrl(baseUrl: string): Effect.Effect<string, CloudEvaluationSubmissionTransportError> {
  return Effect.try({
    try: () => {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new TypeError("Cloud API URL must use HTTP or HTTPS.");
      }
      url.pathname = CLOUD_EVALUATION_SUBMISSION_PATH;
      url.search = "";
      url.hash = "";
      return url.toString();
    },
    catch: () =>
      CloudEvaluationSubmissionTransportError.make({
        message: "The linked Cloud API URL is invalid.",
      }),
  });
}

const readBoundedResponse = Effect.fn("CloudEvaluationSubmission.readBoundedResponse")(function* (
  response: Response,
): Effect.fn.Return<string, CloudEvaluationSubmissionResponseError> {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CLOUD_RESPONSE_BYTES) {
    return yield* CloudEvaluationSubmissionResponseError.make({
      status: response.status,
      message: "Cloud response exceeds the 64 KiB size limit.",
    });
  }
  const text = yield* Effect.tryPromise({
    try: async () => {
      if (!response.body) return "";
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          totalBytes += chunk.value.byteLength;
          if (totalBytes > MAX_CLOUD_RESPONSE_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new RangeError("response too large");
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    },
    catch: (error) =>
      CloudEvaluationSubmissionResponseError.make({
        status: response.status,
        message:
          error instanceof RangeError
            ? "Cloud response exceeds the 64 KiB size limit."
            : "Cloud response could not be read.",
      }),
  });
  return text;
});

const decodeJson = Effect.fn("CloudEvaluationSubmission.decodeJson")(function* (
  text: string,
  status: number,
) {
  return yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () =>
      CloudEvaluationSubmissionResponseError.make({
        status,
        message: "Cloud returned an invalid response.",
      }),
  });
});

export function makeCloudEvaluationSubmissionClientLayer(
  dependencies: CloudEvaluationSubmissionClientDependencies = {},
): Layer.Layer<CloudEvaluationSubmissionClient> {
  const configPath = dependencies.configPath ?? SELFTUNE_CONFIG_PATH;
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  return Layer.succeed(CloudEvaluationSubmissionClient, {
    submit: (input) =>
      Effect.gen(function* () {
        const submission = yield* submissionInput(input);
        const config = yield* Effect.try({
          try: () => loadConfigSync(configPath),
          catch: () =>
            CloudEvaluationSubmissionNotLinkedError.make({
              message: "Cloud account configuration could not be loaded.",
            }),
        });
        const apiKey = yield* Effect.try({
          try: () =>
            resolveCloudCredential(config, {
              ...dependencies.credentialDependencies,
              configPath,
            }),
          catch: () =>
            CloudEvaluationSubmissionNotLinkedError.make({
              message: "The linked Cloud credential could not be resolved.",
            }),
        });
        if (!apiKey) {
          return yield* CloudEvaluationSubmissionNotLinkedError.make({
            message: "Link this Desktop to Cloud before submitting an evaluation.",
          });
        }
        const url = yield* cloudUrl(config?.alpha?.cloud_api_url ?? DEFAULT_CLOUD_API_URL);
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchImplementation(url, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(submission),
              signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS),
            }),
          catch: () =>
            CloudEvaluationSubmissionTransportError.make({
              message: "Cloud evaluation submission could not be delivered.",
            }),
        });
        const text = yield* readBoundedResponse(response);
        const payload = yield* decodeJson(text, response.status);
        if (!response.ok) {
          const rejection = yield* Schema.decodeUnknownEffect(CloudRejection)(payload).pipe(
            Effect.mapError(() =>
              CloudEvaluationSubmissionRejectedError.make({
                status: response.status,
                code: "CLOUD_REJECTED",
                message: "Cloud rejected the evaluation submission.",
              }),
            ),
          );
          return yield* CloudEvaluationSubmissionRejectedError.make({
            status: response.status,
            code: rejection.error.code,
            message: rejection.error.message.slice(0, 500),
          });
        }
        return yield* Schema.decodeUnknownEffect(CloudEvaluationSubmissionReceipt)(payload).pipe(
          Effect.mapError(() =>
            CloudEvaluationSubmissionResponseError.make({
              status: response.status,
              message: "Cloud returned an invalid evaluation receipt.",
            }),
          ),
        );
      }).pipe(
        Effect.timeout(`${CLOUD_REQUEST_TIMEOUT_MS} millis`),
        Effect.catchTag("TimeoutError", () =>
          CloudEvaluationSubmissionTransportError.make({
            message: "Cloud evaluation submission timed out.",
          }),
        ),
      ),
  });
}
