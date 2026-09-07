import { Option, Schema } from "effect";
import { LibraryError } from "../errors.js";
import type { RemoteLibraryConnection } from "./types.js";

const ErrorText = Schema.fromJsonString(Schema.Struct({ error: Schema.String }));
const ErrorMessage = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
);

export interface RemoteRequestPolicy {
  readonly failureMessage: string;
  readonly invalidMessage: string;
  readonly blockedStatuses: readonly number[];
  readonly retryServerErrors?: boolean;
  readonly timeoutMs?: number;
}

export async function remoteResponseError(response: Response, policy: RemoteRequestPolicy) {
  const text = await response.text();
  const errorText = Schema.decodeUnknownOption(ErrorText)(text);
  const errorMessage = Schema.decodeUnknownOption(ErrorMessage)(text);
  const message = Option.isSome(errorText)
    ? errorText.value.error
    : Option.isSome(errorMessage)
      ? errorMessage.value.error.message
      : `${policy.failureMessage} (${response.status}).`;
  return new LibraryError(
    message,
    policy.blockedStatuses.includes(response.status) ? "GUARD_BLOCKED" : "OPERATION_FAILED",
    undefined,
    1,
    policy.retryServerErrors === true && response.status >= 500,
  );
}

export async function remoteRequest<A>(
  config: RemoteLibraryConnection,
  path: string,
  schema: Schema.Decoder<A>,
  policy: RemoteRequestPolicy,
  init?: RequestInit,
): Promise<A> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${config.apiKey}`);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${config.url}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? (policy.timeoutMs ? AbortSignal.timeout(policy.timeoutMs) : undefined),
  });
  if (!response.ok) throw await remoteResponseError(response, policy);
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(await response.text());
  if (Option.isNone(decoded)) throw new LibraryError(policy.invalidMessage, "OPERATION_FAILED");
  return decoded.value;
}

export const SuccessResponse = Schema.Struct({ success: Schema.Literal(true) });
