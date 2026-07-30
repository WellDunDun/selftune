/**
 * Desktop-to-Cloud transport for discovering evaluation targets for one exact
 * installed skill revision. This is deliberately read-only and case-free.
 */
import { loadConfigSync, SELFTUNE_CONFIG_PATH } from "@selftune/config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  resolveCloudCredential,
  type CloudCredentialDependencies,
} from "../auth/cloud-credential.js";
import { DEFAULT_CLOUD_API_URL } from "../auth/device-code.js";

const CLOUD_EVALUATION_TARGETS_PATH = "/api/v1/cloud/evaluation-targets";
const CLOUD_REQUEST_TIMEOUT_MS = 20_000;
const MAX_CLOUD_RESPONSE_BYTES = 64 * 1024;
const MAX_TARGETS = 50;
const MAX_BLOCKERS = 100;
const MAX_SKILL_NAME_LENGTH = 200;
const MAX_SKILL_REVISION_LENGTH = 128;

const BoundedId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  // oxlint-disable-next-line no-control-regex -- portable identifiers reject ASCII control bytes.
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
);
const BoundedName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  // oxlint-disable-next-line no-control-regex -- portable names reject ASCII control bytes.
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
);
const SkillRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Sha256Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));
const RepetitionCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }));

const EvaluationLane = Schema.Literals([
  "structural_validation",
  "trigger_routing",
  "outcome_task",
]);

export class CloudEvaluationTarget extends Schema.Class<CloudEvaluationTarget>(
  "CloudEvaluationTarget",
)({
  source_id: BoundedId,
  snapshot_id: BoundedId,
  skill_id: BoundedId,
  skill_name: BoundedName,
  skill_revision: SkillRevision,
  suite_id: BoundedId,
  suite_name: BoundedName,
  lane: EvaluationLane,
  manifest_digest: Sha256Digest,
  verifier_kind: BoundedId,
  min_repetitions: RepetitionCount,
  max_repetitions: RepetitionCount,
  verification_only: Schema.Boolean,
}) {}

export class CloudEvaluationTargetBlocker extends Schema.Class<CloudEvaluationTargetBlocker>(
  "CloudEvaluationTargetBlocker",
)({
  code: BoundedId,
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000)),
  suite_id: Schema.optional(BoundedId),
}) {}

const CloudEvaluationTargetDiscovery = Schema.Struct({
  targets: Schema.Array(CloudEvaluationTarget),
  blockers: Schema.Array(CloudEvaluationTargetBlocker),
});

const CloudRejection = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
});

export type CloudEvaluationTargetDiscovery = typeof CloudEvaluationTargetDiscovery.Type;

export interface CloudEvaluationTargetQuery {
  readonly skill_name: string;
  readonly skill_revision: string;
}

export class CloudEvaluationTargetInputError extends Schema.TaggedErrorClass<CloudEvaluationTargetInputError>()(
  "CloudEvaluationTargetInputError",
  { message: Schema.String },
) {}

export class CloudEvaluationTargetNotLinkedError extends Schema.TaggedErrorClass<CloudEvaluationTargetNotLinkedError>()(
  "CloudEvaluationTargetNotLinkedError",
  { message: Schema.String },
) {}

export class CloudEvaluationTargetTransportError extends Schema.TaggedErrorClass<CloudEvaluationTargetTransportError>()(
  "CloudEvaluationTargetTransportError",
  { message: Schema.String },
) {}

export class CloudEvaluationTargetRejectedError extends Schema.TaggedErrorClass<CloudEvaluationTargetRejectedError>()(
  "CloudEvaluationTargetRejectedError",
  { status: Schema.Number, code: Schema.String, message: Schema.String },
) {}

export class CloudEvaluationTargetResponseError extends Schema.TaggedErrorClass<CloudEvaluationTargetResponseError>()(
  "CloudEvaluationTargetResponseError",
  { status: Schema.Number, message: Schema.String },
) {}

export type CloudEvaluationTargetError =
  | CloudEvaluationTargetInputError
  | CloudEvaluationTargetNotLinkedError
  | CloudEvaluationTargetTransportError
  | CloudEvaluationTargetRejectedError
  | CloudEvaluationTargetResponseError;

export interface CloudEvaluationTargetClientService {
  readonly discover: (
    query: unknown,
  ) => Effect.Effect<CloudEvaluationTargetDiscovery, CloudEvaluationTargetError>;
}

export class CloudEvaluationTargetClient extends Context.Service<
  CloudEvaluationTargetClient,
  CloudEvaluationTargetClientService
>()("@selftune/runtime/CloudEvaluationTargetClient") {}

export interface CloudEvaluationTargetClientDependencies {
  readonly configPath?: string;
  readonly credentialDependencies?: CloudCredentialDependencies;
  readonly fetch?: typeof globalThis.fetch;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    // oxlint-disable-next-line no-control-regex -- Cloud boundary input rejects ASCII control bytes.
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function targetQuery(
  input: unknown,
): Effect.Effect<CloudEvaluationTargetQuery, CloudEvaluationTargetInputError> {
  return Effect.try({
    try: () => {
      if (!isRecord(input) || !hasExactKeys(input, ["skill_name", "skill_revision"])) {
        throw new TypeError("Expected an exact skill name and revision.");
      }
      if (!isBoundedText(input.skill_name, MAX_SKILL_NAME_LENGTH)) {
        throw new TypeError("Skill name is invalid.");
      }
      if (!isBoundedText(input.skill_revision, MAX_SKILL_REVISION_LENGTH)) {
        throw new TypeError("Skill revision is invalid.");
      }
      if (!/^[a-f0-9]{64}$/.test(input.skill_revision)) {
        throw new TypeError("Skill revision is not a canonical package revision.");
      }
      return { skill_name: input.skill_name, skill_revision: input.skill_revision };
    },
    catch: () =>
      CloudEvaluationTargetInputError.make({
        message: "Evaluation target discovery requires a bounded exact skill name and revision.",
      }),
  });
}

function cloudUrl(
  baseUrl: string,
  query: CloudEvaluationTargetQuery,
): Effect.Effect<string, CloudEvaluationTargetTransportError> {
  return Effect.try({
    try: () => {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new TypeError("Cloud API URL must use HTTP or HTTPS.");
      }
      url.pathname = CLOUD_EVALUATION_TARGETS_PATH;
      url.search = "";
      url.hash = "";
      url.searchParams.set("skill_name", query.skill_name);
      url.searchParams.set("skill_revision", query.skill_revision);
      return url.toString();
    },
    catch: () =>
      CloudEvaluationTargetTransportError.make({
        message: "The linked Cloud API URL is invalid.",
      }),
  });
}

const readBoundedResponse = Effect.fn("CloudEvaluationTarget.readBoundedResponse")(function* (
  response: Response,
): Effect.fn.Return<string, CloudEvaluationTargetResponseError> {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CLOUD_RESPONSE_BYTES) {
    return yield* CloudEvaluationTargetResponseError.make({
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
      CloudEvaluationTargetResponseError.make({
        status: response.status,
        message:
          error instanceof RangeError
            ? "Cloud response exceeds the 64 KiB size limit."
            : "Cloud response could not be read.",
      }),
  });
  return text;
});

const decodeJson = Effect.fn("CloudEvaluationTarget.decodeJson")(function* (
  text: string,
  status: number,
) {
  return yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () =>
      CloudEvaluationTargetResponseError.make({
        status,
        message: "Cloud returned an invalid response.",
      }),
  });
});

function hasExactTargetResponseShape(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["targets", "blockers"])) return false;
  if (!Array.isArray(value.targets) || !Array.isArray(value.blockers)) return false;
  if (value.targets.length > MAX_TARGETS || value.blockers.length > MAX_BLOCKERS) return false;
  return (
    value.targets.every(
      (target) =>
        isRecord(target) &&
        hasExactKeys(target, [
          "source_id",
          "snapshot_id",
          "skill_id",
          "skill_name",
          "skill_revision",
          "suite_id",
          "suite_name",
          "lane",
          "manifest_digest",
          "verifier_kind",
          "min_repetitions",
          "max_repetitions",
          "verification_only",
        ]),
    ) &&
    value.blockers.every(
      (blocker) =>
        isRecord(blocker) &&
        (hasExactKeys(blocker, ["code", "message"]) ||
          hasExactKeys(blocker, ["code", "message", "suite_id"])),
    )
  );
}

function discoveryPayload(
  payload: unknown,
  status: number,
  query: CloudEvaluationTargetQuery,
): Effect.Effect<CloudEvaluationTargetDiscovery, CloudEvaluationTargetResponseError> {
  if (!hasExactTargetResponseShape(payload)) {
    return Effect.fail(
      CloudEvaluationTargetResponseError.make({
        status,
        message: "Cloud returned an invalid evaluation target list.",
      }),
    );
  }
  return Schema.decodeUnknownEffect(CloudEvaluationTargetDiscovery)(payload).pipe(
    Effect.filterOrFail(
      (discovery) =>
        discovery.targets.every(
          (target) =>
            target.skill_name === query.skill_name &&
            target.skill_revision === query.skill_revision &&
            target.min_repetitions <= target.max_repetitions &&
            (target.lane === "structural_validation"
              ? target.verification_only
              : !target.verification_only) &&
            (target.lane !== "outcome_task" || target.min_repetitions >= 3),
        ),
      () =>
        CloudEvaluationTargetResponseError.make({
          status,
          message: "Cloud returned an inconsistent evaluation target list.",
        }),
    ),
    Effect.mapError(() =>
      CloudEvaluationTargetResponseError.make({
        status,
        message: "Cloud returned an invalid evaluation target list.",
      }),
    ),
  );
}

export function makeCloudEvaluationTargetClientLayer(
  dependencies: CloudEvaluationTargetClientDependencies = {},
): Layer.Layer<CloudEvaluationTargetClient> {
  const configPath = dependencies.configPath ?? SELFTUNE_CONFIG_PATH;
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  return Layer.succeed(CloudEvaluationTargetClient, {
    discover: (input) =>
      Effect.gen(function* () {
        const query = yield* targetQuery(input);
        const config = yield* Effect.try({
          try: () => loadConfigSync(configPath),
          catch: () =>
            CloudEvaluationTargetNotLinkedError.make({
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
            CloudEvaluationTargetNotLinkedError.make({
              message: "The linked Cloud credential could not be resolved.",
            }),
        });
        if (!apiKey) {
          return yield* CloudEvaluationTargetNotLinkedError.make({
            message: "Link this Desktop to Cloud before discovering evaluation targets.",
          });
        }
        const url = yield* cloudUrl(config?.alpha?.cloud_api_url ?? DEFAULT_CLOUD_API_URL, query);
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchImplementation(url, {
              method: "GET",
              headers: { Authorization: `Bearer ${apiKey}` },
              signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS),
            }),
          catch: () =>
            CloudEvaluationTargetTransportError.make({
              message: "Cloud evaluation targets could not be loaded.",
            }),
        });
        const text = yield* readBoundedResponse(response);
        const payload = yield* decodeJson(text, response.status);
        if (!response.ok) {
          const rejection = yield* Schema.decodeUnknownEffect(CloudRejection)(payload).pipe(
            Effect.mapError(() =>
              CloudEvaluationTargetRejectedError.make({
                status: response.status,
                code: "CLOUD_REJECTED",
                message: "Cloud rejected evaluation target discovery.",
              }),
            ),
          );
          return yield* CloudEvaluationTargetRejectedError.make({
            status: response.status,
            code: rejection.error.code,
            message: rejection.error.message.slice(0, 500),
          });
        }
        return yield* discoveryPayload(payload, response.status, query);
      }).pipe(
        Effect.timeout(`${CLOUD_REQUEST_TIMEOUT_MS} millis`),
        Effect.catchTag("TimeoutError", () =>
          CloudEvaluationTargetTransportError.make({
            message: "Cloud evaluation target discovery timed out.",
          }),
        ),
      ),
  });
}
