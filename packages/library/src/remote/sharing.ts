import { LibraryError as CLIError } from "../errors.js";
import { SkillSetPackManagementList } from "@selftune/control-plane";
import * as Schema from "effect/Schema";
import { remoteRequest, remoteResponseError } from "./http.js";
import {
  type CreateRemoteLibraryShareRequest,
  type RemoteLibraryConnection,
  RemoteLibraryShare,
  RemoteLibrarySharesResponse,
  type CreateSkillShareGrantRequest,
  SkillShareGrantReceipt,
} from "./types.js";

const policy = {
  failureMessage: "Sync & Backup sharing failed",
  invalidMessage: "Sync & Backup returned an invalid response.",
  blockedStatuses: [403],
};
const ShareResponse = Schema.Struct({ share: RemoteLibraryShare });
const PackResponse = Schema.Struct({
  packId: Schema.String,
  mode: SkillShareGrantReceipt.fields.mode,
  packUrl: Schema.String,
  expiresAt: Schema.String,
});

export function listRemoteLibraryShares(config: RemoteLibraryConnection) {
  return remoteRequest(
    config,
    "/api/v1/remote-library/shares",
    RemoteLibrarySharesResponse,
    policy,
  );
}

export async function createRemoteLibraryShare(
  config: RemoteLibraryConnection,
  input: CreateRemoteLibraryShareRequest,
): Promise<RemoteLibraryShare> {
  const result = await remoteRequest(
    config,
    "/api/v1/remote-library/shares",
    ShareResponse,
    policy,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return result.share;
}

export async function actOnRemoteLibraryShare(
  config: RemoteLibraryConnection,
  shareId: string,
  action: "accept" | "import" | "revoke",
): Promise<RemoteLibraryShare> {
  const result = await remoteRequest(
    config,
    `/api/v1/remote-library/shares/${encodeURIComponent(shareId)}/${action}`,
    ShareResponse,
    policy,
    { method: "POST", body: "{}" },
  );
  return result.share;
}

export async function createSkillShareGrant(
  config: RemoteLibraryConnection,
  input: CreateSkillShareGrantRequest,
): Promise<SkillShareGrantReceipt> {
  if ("skillSetId" in input) {
    if (input.delivery !== "copy_link") {
      throw new CLIError(
        "Email Skill Set sharing uses the account-to-account private share flow.",
        "INVALID_FLAG",
      );
    }
    const result = await remoteRequest(
      config,
      "/api/v1/skill-set-packs",
      Schema.Struct({ packId: Schema.String, packUrl: Schema.String, expiresAt: Schema.String }),
      {
        ...policy,
        failureMessage: "Skill sharing failed",
        invalidMessage: "Skill Set Pack response was invalid.",
      },
      { method: "POST", body: JSON.stringify({ skillSetId: input.skillSetId, mode: input.mode }) },
    );
    return {
      shareId: result.packId,
      mode: input.mode,
      delivery: "copy_link",
      shareUrl: result.packUrl,
      expiresAt: result.expiresAt,
    };
  }
  return remoteRequest(
    config,
    "/api/v1/share-grants",
    SkillShareGrantReceipt,
    { ...policy, failureMessage: "Skill sharing failed" },
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function createSelfHostedSkillSetPack(
  config: RemoteLibraryConnection,
  input: {
    snapshot_id: string;
    artifact_id: string;
    mode: "reusable_unlisted" | "private_single_claim";
  },
): Promise<SkillShareGrantReceipt> {
  const result = await remoteRequest(config, "/api/v1/remote-library/packs", PackResponse, policy, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return {
    shareId: result.packId,
    mode: result.mode,
    delivery: "copy_link",
    shareUrl: result.packUrl,
    expiresAt: result.expiresAt,
  };
}

function packPath(config: RemoteLibraryConnection): string {
  const hostname = new URL(config.url).hostname.toLowerCase();
  return hostname === "cloud.selftune.dev" || hostname === "api.selftune.dev"
    ? "/api/v1/skill-set-packs"
    : "/api/v1/remote-library/packs";
}

export function listSkillSetPacks(
  config: RemoteLibraryConnection,
): Promise<SkillSetPackManagementList> {
  return remoteRequest(config, packPath(config), SkillSetPackManagementList, {
    ...policy,
    failureMessage: "Pack listing failed",
  });
}

export async function revokeSkillSetPack(
  config: RemoteLibraryConnection,
  packId: string,
): Promise<void> {
  const response = await fetch(`${config.url}${packPath(config)}/${encodeURIComponent(packId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok)
    throw await remoteResponseError(response, {
      ...policy,
      failureMessage: "Pack revocation failed",
    });
}
