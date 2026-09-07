import type * as Schema from "effect/Schema";

export function jsonRequest(
  url: string,
  method: "GET" | "POST" | "PATCH",
  body?: typeof Schema.Json.Type,
  origin?: string,
) {
  const headers = new Headers();
  if (origin !== undefined) headers.set("Origin", origin);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}
