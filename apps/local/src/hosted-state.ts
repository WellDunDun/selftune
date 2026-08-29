import { createHash } from "node:crypto";
import { hostname, platform } from "node:os";
import * as Schema from "effect/Schema";

import type { LibrarySnapshot } from "@selftune/runtime/dashboard-contract";
import { exportPortableSkillSetPackBytes } from "@selftune/library";
import type {
  CreateSkillShareGrantRequest,
  SkillShareGrantReceipt,
} from "@selftune/library/remote/types";
import { HostedManifestReceipt } from "@selftune/control-plane";
import { loadRemoteLibraryConfig } from "@selftune/runtime/remote-library-config";
import { collectLocalObjects } from "@selftune/runtime/remote-library/collect";
import { CLIError } from "@selftune/runtime/utils/cli-error";

type ManifestReceipt = typeof HostedManifestReceipt.Type;

const UploadRequest = Schema.Struct({ upload_url: Schema.String });
const UploadReceipt = Schema.Struct({ storageId: Schema.String });
const ShareReceipt = Schema.Struct({
  share_id: Schema.String,
  share_url: Schema.String,
  expires_at: Schema.Number,
});

function cloudRequestError(operation: string, response: Response) {
  return new CLIError(
    `${operation} failed (${response.status}).`,
    "API_ERROR",
    "Your local library is unchanged. Reconnect Cloud and retry when online.",
    1,
    response.status >= 500,
  );
}

function manifestSkills(library: LibrarySnapshot) {
  const staleBefore = Date.now() - 30 * 24 * 60 * 60 * 1_000;
  return library.skills.map((skill) => ({
    identity: skill.skillId,
    revision_hash: skill.revisions[0]?.contentHash ?? "",
    scope: [...new Set(skill.locations.map((location) => location.scope))].join(","),
    connections: [
      ...new Set(
        skill.locations.flatMap((location) =>
          location.harness === null ? [] : [location.harness],
        ),
      ),
    ],
    update_status: skill.updateStatus === "untracked" ? ("unknown" as const) : skill.updateStatus,
    usage_status:
      skill.lastUsedAt === null
        ? ("none" as const)
        : Date.parse(skill.lastUsedAt) < staleBefore
          ? ("stale" as const)
          : ("recent" as const),
  }));
}

function manifestRevision(skills: ReturnType<typeof manifestSkills>) {
  return createHash("sha256").update(JSON.stringify(skills)).digest("hex");
}

export interface HostedStateOptions {
  readonly fetch?: typeof fetch;
  readonly deviceName?: () => string;
  readonly platform?: () => string;
  readonly loadConfig?: typeof loadRemoteLibraryConfig;
  readonly packageForShare?: (
    input: CreateSkillShareGrantRequest,
  ) => Promise<{ readonly bytes: Uint8Array; readonly label: string }>;
}

export function isSelfTuneCloudUrl(input: string): boolean {
  try {
    const hostname = new URL(input).hostname.toLowerCase();
    return hostname === "cloud.selftune.dev" || hostname === "api.selftune.dev";
  } catch {
    return false;
  }
}

/** The only Desktop boundary allowed to report local state to SelfTune Cloud. */
export function makeHostedStateOperations(
  configRoot: string,
  loadLibrary: () => LibrarySnapshot | Promise<LibrarySnapshot>,
  options: HostedStateOptions = {},
) {
  const requestFetch = options.fetch ?? fetch;
  const connection = () =>
    Promise.resolve((options.loadConfig ?? loadRemoteLibraryConfig)(configRoot));
  const isCloudConnection = async () => isSelfTuneCloudUrl((await connection()).url);
  const sync = async (): Promise<ManifestReceipt> => {
    const [config, library] = await Promise.all([connection(), Promise.resolve(loadLibrary())]);
    const skills = manifestSkills(library);
    const response = await requestFetch(new URL("/api/v1/desktop/manifest", config.url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        revision: manifestRevision(skills),
        device_name: (options.deviceName ?? hostname)(),
        platform: (options.platform ?? platform)(),
        skills,
      }),
    });
    if (!response.ok) throw cloudRequestError("Hosted-state sync", response);
    return Schema.decodeUnknownSync(HostedManifestReceipt)(await response.json());
  };

  const share = async (input: CreateSkillShareGrantRequest): Promise<SkillShareGrantReceipt> => {
    if (input.delivery === "email")
      throw new CLIError(
        "Email delivery is not available for local-first sharing.",
        "UNSUPPORTED_TYPE",
        "Create a secure link and send it using your preferred channel.",
      );
    const config = await connection();
    const packageForShare =
      options.packageForShare ??
      (async () => {
        if ("skillSetId" in input)
          return {
            bytes: exportPortableSkillSetPackBytes(input.skillSetId, {
              configRoot,
            }),
            label: input.skillSetId,
          };
        const objects = await collectLocalObjects({
          configRoot,
          preferences: {
            releasedSkills: false,
            drafts: false,
            skillSets: false,
            metadata: false,
            decisionHistory: false,
          },
          selectedSkillIds: [input.skillId],
        });
        const selected = objects[0];
        if (!selected)
          throw new CLIError(
            "Skill package not found.",
            "NOT_FOUND",
            "Refresh the Library and retry.",
          );
        return { bytes: selected.bytes, label: input.skillId };
      });
    const { bytes, label } = await packageForShare(input);
    const authorization = { authorization: `Bearer ${config.apiKey}` };
    const uploadRequest = await requestFetch(new URL("/api/v1/desktop/share/upload", config.url), {
      method: "POST",
      headers: authorization,
    });
    if (!uploadRequest.ok) throw cloudRequestError("Share upload request", uploadRequest);
    const { upload_url: uploadUrl } = Schema.decodeUnknownSync(UploadRequest)(
      await uploadRequest.json(),
    );
    const upload = await requestFetch(uploadUrl, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Blob([Uint8Array.from(bytes)]),
    });
    if (!upload.ok) throw cloudRequestError("Package upload", upload);
    const { storageId } = Schema.decodeUnknownSync(UploadReceipt)(await upload.json());
    const issue = await requestFetch(new URL("/api/v1/desktop/share/issue", config.url), {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        storage_id: storageId,
        content_hash: createHash("sha256").update(bytes).digest("hex"),
        label,
        expires_in_hours: input.mode === "private_single_claim" ? 24 : 168,
      }),
    });
    if (!issue.ok) throw cloudRequestError("Share link creation", issue);
    const receipt = Schema.decodeUnknownSync(ShareReceipt)(await issue.json());
    return {
      shareId: receipt.share_id,
      mode: input.mode,
      delivery: "copy_link",
      shareUrl: receipt.share_url,
      expiresAt: new Date(receipt.expires_at).toISOString(),
    };
  };
  return { isCloudConnection, sync, share } as const;
}
