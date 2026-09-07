import { Option, Schema } from "effect";

export class DashboardApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly suggestion: string | null,
    public readonly retryable: boolean,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DashboardApiError";
  }
}

const StructuredApiError = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  suggestion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  retryable: Schema.optionalKey(Schema.Boolean),
});
const decodeErrorEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ error: Schema.Union([Schema.String, StructuredApiError]) }),
  ),
);

export function responseError(response: Response, text: string): DashboardApiError {
  if (response.status === 404 && text.trim() === "Not Found") {
    return new DashboardApiError(
      "ROUTE_NOT_FOUND",
      "The Desktop service is out of date. Restart SelfTune Desktop and try again.",
      "Restart SelfTune Desktop to load the updated local service.",
      false,
      response.status,
    );
  }
  const envelope = decodeErrorEnvelope(text);
  if (Option.isSome(envelope)) {
    const error = envelope.value.error;
    if (Schema.is(StructuredApiError)(error)) {
      return new DashboardApiError(
        error.code ?? "API_ERROR",
        error.message ?? `API error: ${response.status}`,
        error.suggestion ?? null,
        error.retryable ?? response.status >= 500,
        response.status,
      );
    }
    return new DashboardApiError("API_ERROR", error, null, response.status >= 500, response.status);
  }
  return new DashboardApiError(
    "API_ERROR",
    `API error: ${response.status}`,
    null,
    response.status >= 500,
    response.status,
  );
}

export function decodeResponse<T>(response: Response, text: string, schema: Schema.Codec<T>): T {
  const result = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text);
  if (Option.isSome(result)) return result.value;
  throw new DashboardApiError(
    "INVALID_RESPONSE",
    "The local Desktop service returned an invalid response.",
    null,
    true,
    response.status,
  );
}

export async function schemaRequest<T>(
  path: string,
  schema: Schema.Codec<T>,
  body?: string,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw responseError(response, text);
  return decodeResponse(response, text, schema);
}

export async function portfolioRequest<T>(path: string, body?: string): Promise<T> {
  const res = await fetch(path, {
    method: body !== undefined ? "POST" : "GET",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body,
  });
  const responseText = await res.text();
  let data: T;
  try {
    data = JSON.parse(responseText);
  } catch {
    if (res.status === 404 && responseText.trim() === "Not Found") {
      throw new DashboardApiError(
        "ROUTE_NOT_FOUND",
        "The Desktop service is out of date. Restart SelfTune Desktop and try again.",
        "Restart SelfTune Desktop to load the updated local service.",
        false,
        res.status,
      );
    }
    throw new DashboardApiError(
      "INVALID_RESPONSE",
      res.ok
        ? "The local Desktop service returned an invalid response."
        : `API error: ${res.status} ${res.statusText}`.trim(),
      null,
      res.ok || res.status >= 500,
      res.status,
    );
  }
  if (!res.ok) throw responseError(res, responseText);
  return data;
}
