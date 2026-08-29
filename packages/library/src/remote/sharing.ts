import { LibraryError as CLIError } from "../errors.js";
import type { SkillSetPackManagementList } from "@selftune/control-plane";
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
  const isSkillSet = "skillSetId" in input;
  if (isSkillSet && input.delivery !== "copy_link") {
    throw new CLIError(
      "Email Skill Set sharing uses the account-to-account private share flow.",
      "INVALID_FLAG",
    );
  }
  const response = await fetch(
    `${config.url}${isSkillSet ? "/api/v1/skill-set-packs" : "/api/v1/share-grants"}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(isSkillSet ? { skillSetId: input.skillSetId, mode: input.mode } : input),
    },
  );
  const payload = (await response.json().catch(() => null)) as
    | (SkillShareGrantReceipt &
        ErrorEnvelope & {
          packId?: string;
          packUrl?: string;
        })
    | null;
  if (!response.ok || !payload) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : (payload?.error?.message ?? `Skill sharing failed (${response.status}).`);
    throw new CLIError(message, response.status === 403 ? "GUARD_BLOCKED" : "OPERATION_FAILED");
  }
  if (isSkillSet) {
    if (
      typeof payload.packId !== "string" ||
      typeof payload.packUrl !== "string" ||
      typeof payload.expiresAt !== "string"
    ) {
      throw new CLIError("Skill Set Pack response was invalid.", "OPERATION_FAILED");
    }
    return {
      shareId: payload.packId,
      mode: input.mode,
      delivery: "copy_link",
      shareUrl: payload.packUrl,
      expiresAt: payload.expiresAt,
    };
  }
  return payload;
}

export async function createSelfHostedSkillSetPack(
  config: RemoteLibraryConnection,
  input: {
    snapshot_id: string;
    artifact_id: string;
    mode: "reusable_unlisted" | "private_single_claim";
  },
): Promise<SkillShareGrantReceipt> {
  const result = await request<{
    packId: string;
    mode: "reusable_unlisted" | "private_single_claim";
    packUrl: string;
    expiresAt: string;
  }>(config, "/packs", { method: "POST", body: JSON.stringify(input) });
  return {
    shareId: result.packId,
    mode: result.mode,
    delivery: "copy_link",
    shareUrl: result.packUrl,
    expiresAt: result.expiresAt,
  };
}

function isCloudConnection(config: RemoteLibraryConnection): boolean {
  const hostname = new URL(config.url).hostname.toLowerCase();
  return hostname === "cloud.selftune.dev" || hostname === "api.selftune.dev";
}

export async function listSkillSetPacks(
  config: RemoteLibraryConnection,
): Promise<SkillSetPackManagementList> {
  if (isCloudConnection(config)) {
    const response = await fetch(`${config.url}/api/v1/skill-set-packs`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    const payload = (await response.json().catch(() => null)) as
      | (SkillSetPackManagementList & ErrorEnvelope)
      | null;
    if (!response.ok || !payload) {
      const message =
        typeof payload?.error === "string"
          ? payload.error
          : (payload?.error?.message ?? `Pack listing failed (${response.status}).`);
      throw new CLIError(message, response.status === 403 ? "GUARD_BLOCKED" : "OPERATION_FAILED");
    }
    return payload;
  }
  return request<SkillSetPackManagementList>(config, "/packs");
}

export async function revokeSkillSetPack(
  config: RemoteLibraryConnection,
  packId: string,
): Promise<void> {
  const path = isCloudConnection(config)
    ? `${config.url}/api/v1/skill-set-packs/${encodeURIComponent(packId)}`
    : `${config.url}/api/v1/remote-library/packs/${encodeURIComponent(packId)}`;
  const response = await fetch(path, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (response.ok) return;
  const payload = (await response.json().catch(() => null)) as ErrorEnvelope | null;
  const message =
    typeof payload?.error === "string"
      ? payload.error
      : (payload?.error?.message ?? `Pack revocation failed (${response.status}).`);
  throw new CLIError(message, response.status === 403 ? "GUARD_BLOCKED" : "OPERATION_FAILED");
}
