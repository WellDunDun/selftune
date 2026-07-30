import { LibraryError as CLIError } from "../errors.js";
import type {
  CreateRemoteLibraryShareRequest,
  RemoteLibraryConnection,
  RemoteLibraryShare,
  RemoteLibrarySharesResponse,
  CreateSkillShareGrantRequest,
  SkillShareGrantReceipt,
} from "./types.js";

interface ErrorEnvelope {
  error?: { message?: string } | string;
}

async function request<T>(
  config: RemoteLibraryConnection,
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
        : (payload?.error?.message ?? `Sync & Backup sharing failed (${response.status}).`);
    throw new CLIError(message, response.status === 403 ? "GUARD_BLOCKED" : "OPERATION_FAILED");
  }
  if (!payload) throw new CLIError("Sync & Backup returned an empty response.", "OPERATION_FAILED");
  return payload;
}

export function listRemoteLibraryShares(
  config: RemoteLibraryConnection,
): Promise<RemoteLibrarySharesResponse> {
  return request(config, "/shares");
}

export async function createRemoteLibraryShare(
  config: RemoteLibraryConnection,
  input: CreateRemoteLibraryShareRequest,
): Promise<RemoteLibraryShare> {
  const result = await request<{ share: RemoteLibraryShare }>(config, "/shares", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.share;
}

export async function actOnRemoteLibraryShare(
  config: RemoteLibraryConnection,
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

export async function createSkillShareGrant(
  config: RemoteLibraryConnection,
  input: CreateSkillShareGrantRequest,
): Promise<SkillShareGrantReceipt> {
  const response = await fetch(`${config.url}/api/v1/share-grants`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload = (await response.json().catch(() => null)) as
    | (SkillShareGrantReceipt & ErrorEnvelope)
    | null;
  if (!response.ok || !payload) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : (payload?.error?.message ?? `Skill sharing failed (${response.status}).`);
    throw new CLIError(message, response.status === 403 ? "GUARD_BLOCKED" : "OPERATION_FAILED");
  }
  return payload;
}
