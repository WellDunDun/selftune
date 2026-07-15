import type {
  CreateRemoteLibraryShareRequest,
  RemoteLibraryShare,
  RemoteLibrarySharesResponse,
} from "./dashboard-contract.js";
import type { RemoteLibraryConfig } from "./remote-library-config.js";
import { CLIError } from "./utils/cli-error.js";

interface ErrorEnvelope {
  error?: { message?: string } | string;
}

async function request<T>(
  config: RemoteLibraryConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${config.url}/api/v1/remote-library${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as (T & ErrorEnvelope) | null;
  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : (payload?.error?.message ?? `Remote Library sharing failed (${response.status}).`);
    throw new CLIError(message, response.status === 403 ? "GUARD_BLOCKED" : "OPERATION_FAILED");
  }
  if (!payload)
    throw new CLIError("Remote Library returned an empty response.", "OPERATION_FAILED");
  return payload;
}

export function listRemoteLibraryShares(
  config: RemoteLibraryConfig,
): Promise<RemoteLibrarySharesResponse> {
  return request(config, "/shares");
}

export async function createRemoteLibraryShare(
  config: RemoteLibraryConfig,
  input: CreateRemoteLibraryShareRequest,
): Promise<RemoteLibraryShare> {
  const result = await request<{ share: RemoteLibraryShare }>(config, "/shares", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.share;
}

export async function actOnRemoteLibraryShare(
  config: RemoteLibraryConfig,
  shareId: string,
  action: "accept" | "import" | "revoke",
): Promise<RemoteLibraryShare> {
  const result = await request<{ share: RemoteLibraryShare }>(
    config,
    `/shares/${encodeURIComponent(shareId)}/${action}`,
    { method: "POST", body: "{}" },
  );
  return result.share;
}
