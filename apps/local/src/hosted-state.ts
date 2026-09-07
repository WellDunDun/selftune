import { createHash } from "node:crypto";
import { hostname, platform } from "node:os";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { DashboardLibraryService } from "./library-report.js";

import type { LibrarySnapshot } from "@selftune/runtime/dashboard-contract";
import { exportPortableSkillSetPackBytes } from "@selftune/library";
import type {
  CreateSkillShareGrantRequest,
  SkillShareGrantReceipt,
} from "@selftune/library/remote/types";
import {
  decodePortableSkillSetEnvelope,
  HostedManifestReceipt,
  HostedSkillSetAssignmentListReceipt,
  HostedSkillSetAssignmentListRequest,
  HostedSkillSetAssignmentPackageMetadata,
  HostedSkillSetAssignmentPackageRequest,
  HostedSkillSetInstallationReceiptRequest,
  HostedSkillSetInstallationReceiptResponse,
  HostedSkillSetContributionSubmitReceipt,
  HostedSkillSetContributionSubmitRequest,
  HostedSkillSetPublishFinalizeRequest,
  HostedSkillSetPublishIntentReceipt,
  HostedSkillSetPublishIntentRequest,
  HostedSkillSetPublishUploadReceipt,
  HostedSkillSetRevalidationSummaryReceipt,
  HostedSkillSetRevalidationSummaryRequest,
  HostedSkillSetReleaseReceipt,
  resolveSkillSetDependencies,
} from "@selftune/control-plane";
import type {
  SkillSetDependencyResolution,
  SkillSetDependencyEnvelope,
  SkillSetDependencyResolutionInput,
} from "@selftune/control-plane";
import type { TeamContributionUploadRequest } from "@selftune/runtime/team-contribution";
import { loadRemoteLibraryConfig } from "@selftune/runtime/remote-library-config";
import { collectLocalObjects } from "@selftune/runtime/remote-library/collect";
import { CLIError } from "@selftune/runtime/utils/cli-error";

type ManifestReceipt = typeof HostedManifestReceipt.Type;
type SkillSetReleaseReceipt = typeof HostedSkillSetReleaseReceipt.Type;

export interface HostedSkillSetPublishPreview {
  readonly skillSetId: string;
  readonly name: string;
  readonly description: string;
  readonly harnesses: readonly string[];
  readonly skillSetRevisionSha256: string;
  readonly envelopeSha256: string;
  readonly byteLength: number;
  readonly contents: ReadonlyArray<{
    readonly name: string;
    readonly revisionSha256: string;
    readonly license: string;
  }>;
  readonly dependencies: SkillSetDependencyResolution;
  readonly dependencyInput: SkillSetDependencyResolutionInput;
  readonly checks: ReadonlyArray<{
    readonly id: "portable_envelope" | "pinned_revisions" | "distribution_terms";
    readonly status: "passed";
    readonly title: string;
    readonly detail: string;
  }>;
  readonly confirmation: {
    readonly required: true;
    readonly title: string;
    readonly detail: string;
  };
}

export interface PublishHostedSkillSetInput {
  readonly setId: string;
  readonly expectedSkillSetRevisionSha256: string;
  readonly expectedEnvelopeSha256: string;
  readonly dependencyResolution: SkillSetDependencyResolutionInput;
  readonly expectedDependencyLock: SkillSetDependencyResolution["lock"];
  readonly confirmPublish: boolean;
}

const UploadRequest = Schema.Struct({ upload_url: Schema.String });
const UploadReceipt = Schema.Struct({ storageId: Schema.String });
const ContributionUploadIntentReceipt = Schema.Struct({
  request_id: Schema.String,
  upload_url: Schema.String,
  expires_at: Schema.Number,
});
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
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
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
export class HostedStateService extends Context.Service<
  HostedStateService,
  ReturnType<typeof makeHostedStateOperations>
>()("SelfTune/HostedState") {}

export function makeHostedStateLayer(configRoot: string) {
  return Layer.effect(HostedStateService)(
    Effect.gen(function* () {
      const library = yield* DashboardLibraryService;
      return makeHostedStateOperations(configRoot, library.load);
    }),
  );
}

export function makeHostedStateOperations(
  configRoot: string,
  loadLibrary: () => LibrarySnapshot | Promise<LibrarySnapshot>,
  options: HostedStateOptions = {},
) {
  const requestFetch = options.fetch ?? fetch;
  const connection = () =>
    Promise.resolve((options.loadConfig ?? loadRemoteLibraryConfig)(configRoot));
  const isCloudConnection = async () => isSelfTuneCloudUrl((await connection()).url);

  const packageSkillSetRelease = (
    setId: string,
    dependencyResolution?: SkillSetDependencyEnvelope,
  ) => {
    const bytes = exportPortableSkillSetPackBytes(setId, { configRoot }, dependencyResolution);
    const decoded = Effect.runSync(decodePortableSkillSetEnvelope(bytes));
    return { bytes, decoded } as const;
  };

  const resolveReleaseDependencies = async (
    decoded: ReturnType<typeof packageSkillSetRelease>["decoded"],
    input: SkillSetDependencyResolutionInput,
  ): Promise<SkillSetDependencyResolution> => {
    const resolution = await Effect.runPromise(resolveSkillSetDependencies(input));
    const componentsById = new Map(
      decoded.envelope.components.map((component) => [component.logicalSkillId, component]),
    );
    for (const entry of resolution.lock.entries) {
      const component = componentsById.get(entry.package_id);
      if (!component)
        throw new CLIError(
          `Resolved package ${entry.package_id} is not included in this Skill Set release.`,
          "GUARD_BLOCKED",
          "Add the required component to the Skill Set or remove the dependency before publishing.",
        );
      if (component.sourceRevisionSha256 !== entry.revision_sha256)
        throw new CLIError(
          `Resolved package ${entry.package_id} does not match the component revision in this Skill Set release.`,
          "GUARD_BLOCKED",
          "Refresh the package metadata from the exact local component and preview again.",
        );
    }
    const resolvedIds = new Set(resolution.lock.entries.map((entry) => entry.package_id));
    const omitted = decoded.envelope.components.find(
      (component) => !resolvedIds.has(component.logicalSkillId),
    );
    if (omitted)
      throw new CLIError(
        `Component ${omitted.logicalSkillId} has no resolved package metadata.`,
        "GUARD_BLOCKED",
        "Provide explicit package metadata for every component before publishing.",
      );
    return resolution;
  };

  const assignmentAuthorization = async () => {
    const config = await connection();
    return {
      config,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
    } as const;
  };

  const listSkillSetAssignments = async (input: { readonly limit?: number } = {}) => {
    const { config, headers } = await assignmentAuthorization();
    const body = Schema.decodeUnknownSync(HostedSkillSetAssignmentListRequest)(input);
    const response = await requestFetch(new URL("/api/v1/desktop/assignments/list", config.url), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw cloudRequestError("Assignment list", response);
    return Schema.decodeUnknownSync(HostedSkillSetAssignmentListReceipt)(await response.json());
  };

  const downloadSkillSetAssignmentPackage = async (assignmentId: string) => {
    const { config, headers } = await assignmentAuthorization();
    const body = Schema.decodeUnknownSync(HostedSkillSetAssignmentPackageRequest)({
      assignment_id: assignmentId,
    });
    const response = await requestFetch(
      new URL("/api/v1/desktop/assignments/package", config.url),
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    if (!response.ok) throw cloudRequestError("Assignment package", response);
    const rawByteLength = response.headers.get("x-selftune-byte-length");
    const metadata = Schema.decodeUnknownSync(HostedSkillSetAssignmentPackageMetadata)({
      assignment_id: response.headers.get("x-selftune-assignment-id"),
      release_id: response.headers.get("x-selftune-release-id"),
      envelope_sha256: response.headers.get("x-selftune-envelope-sha256"),
      byte_length: rawByteLength === null ? Number.NaN : Number(rawByteLength),
    });
    if (
      response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
        "application/octet-stream" ||
      !response.headers
        .get("cache-control")
        ?.split(",")
        .map((value) => value.trim().toLowerCase())
        .includes("no-store")
    )
      throw new CLIError(
        "Cloud returned an unsafe assignment package response.",
        "GUARD_BLOCKED",
        "Nothing was installed. Reconnect Cloud and retry.",
      );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentLength = Number(response.headers.get("content-length"));
    if (
      bytes.byteLength !== metadata.byte_length ||
      !Number.isSafeInteger(contentLength) ||
      contentLength !== metadata.byte_length
    )
      throw new CLIError(
        "Cloud returned an incomplete assignment package.",
        "GUARD_BLOCKED",
        "Nothing was installed. Retry the download when your connection is stable.",
      );
    return { bytes, metadata } as const;
  };

  const submitSkillSetInstallationReceipt = async (
    input: typeof HostedSkillSetInstallationReceiptRequest.Type,
  ) => {
    const { config, headers } = await assignmentAuthorization();
    const body = Schema.decodeUnknownSync(HostedSkillSetInstallationReceiptRequest)(input);
    const response = await requestFetch(
      new URL("/api/v1/desktop/assignments/receipt", config.url),
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    if (!response.ok) throw cloudRequestError("Assignment receipt", response);
    return Schema.decodeUnknownSync(HostedSkillSetInstallationReceiptResponse)(
      await response.json(),
    );
  };

  const publishRevalidationSummary = async (
    input: typeof HostedSkillSetRevalidationSummaryRequest.Type,
  ) => {
    const { config, headers } = await assignmentAuthorization();
    const body = Schema.decodeUnknownSync(HostedSkillSetRevalidationSummaryRequest)(input);
    const response = await requestFetch(
      new URL("/api/v1/desktop/assignments/revalidation", config.url),
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    if (!response.ok) throw cloudRequestError("Revalidation lifecycle summary", response);
    return Schema.decodeUnknownSync(HostedSkillSetRevalidationSummaryReceipt)(
      await response.json(),
    );
  };

  const uploadContribution = async (input: TeamContributionUploadRequest, bytes: Uint8Array) => {
    const { config, headers } = await assignmentAuthorization();
    const intentResponse = await requestFetch(
      new URL("/api/v1/desktop/contributions/upload-intent", config.url),
      { method: "POST", headers, body: JSON.stringify(input) },
    );
    if (!intentResponse.ok) throw cloudRequestError("Contribution upload intent", intentResponse);
    const intent = Schema.decodeUnknownSync(ContributionUploadIntentReceipt)(
      await intentResponse.json(),
    );
    if (intent.request_id !== input.request_id)
      throw new CLIError(
        "Cloud returned an upload intent for a different contribution request.",
        "GUARD_BLOCKED",
        "Keep the local candidate unchanged and retry.",
      );
    const uploadResponse = await requestFetch(intent.upload_url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Blob([Uint8Array.from(bytes)]),
    });
    if (!uploadResponse.ok) throw cloudRequestError("Contribution upload", uploadResponse);
    const upload = Schema.decodeUnknownSync(UploadReceipt)(await uploadResponse.json());
    const finalize = Schema.decodeUnknownSync(HostedSkillSetContributionSubmitRequest)({
      ...input,
      package_storage_id: upload.storageId,
    });
    const finalizeResponse = await requestFetch(
      new URL("/api/v1/desktop/contributions/finalize", config.url),
      { method: "POST", headers, body: JSON.stringify(finalize) },
    );
    if (!finalizeResponse.ok)
      throw cloudRequestError("Contribution finalization", finalizeResponse);
    const receipt = Schema.decodeUnknownSync(HostedSkillSetContributionSubmitReceipt)(
      await finalizeResponse.json(),
    );
    if (
      receipt.proposal.request_id !== input.request_id ||
      receipt.proposal.skill_set_id !== input.skill_set_id ||
      receipt.proposal.base_release_id !== input.base_release_id ||
      receipt.proposal.proposed_envelope_sha256 !== input.proposed_envelope_sha256
    )
      throw new CLIError(
        "Cloud returned a proposal that does not match the reviewed contribution.",
        "GUARD_BLOCKED",
        "Keep the local candidate unchanged and contact support before retrying.",
      );
    return {
      contribution_id: receipt.proposal.contribution_id,
      request_id: receipt.proposal.request_id,
    };
  };

  const previewSkillSetPublish = async (
    setId: string,
    dependencyResolution: SkillSetDependencyResolutionInput,
  ): Promise<HostedSkillSetPublishPreview> => {
    const initial = packageSkillSetRelease(setId);
    const dependencies = await resolveReleaseDependencies(initial.decoded, dependencyResolution);
    const { bytes, decoded } = packageSkillSetRelease(setId, {
      roots: dependencyResolution.roots,
      available_packages: dependencyResolution.available_packages,
      environment: dependencyResolution.environment,
      lock: dependencies.lock,
    });
    const { envelope } = decoded;
    const componentCount = envelope.components.length;
    return {
      skillSetId: envelope.sourceManifest.skillSetId,
      name: envelope.sourceManifest.name,
      description: envelope.sourceManifest.description,
      harnesses: [...envelope.sourceManifest.harnesses],
      skillSetRevisionSha256: envelope.skillSetRevisionSha256,
      envelopeSha256: decoded.portableSkillSetEnvelopeSha256,
      byteLength: bytes.byteLength,
      contents: envelope.components.map((component) => ({
        name: component.logicalSkillId,
        revisionSha256: component.sourceRevisionSha256,
        license: component.terms.licenseExpression,
      })),
      dependencies,
      dependencyInput: dependencyResolution,
      checks: [
        {
          id: "portable_envelope",
          status: "passed",
          title: "Portable release is valid",
          detail: "SelfTune can verify this exact release before installation.",
        },
        {
          id: "pinned_revisions",
          status: "passed",
          title: `${componentCount} skill revision${componentCount === 1 ? " is" : "s are"} pinned`,
          detail: "The published release will keep these exact skill revisions.",
        },
        {
          id: "distribution_terms",
          status: "passed",
          title: "Distribution terms are included",
          detail: "Every skill in this release includes license information.",
        },
      ],
      confirmation: {
        required: true,
        title: `Publish ${envelope.sourceManifest.name} to your team?`,
        detail: "This uploads only the reviewed portable release shown above.",
      },
    };
  };

  const publishSkillSet = async (
    input: PublishHostedSkillSetInput,
  ): Promise<SkillSetReleaseReceipt> => {
    if (!input.confirmPublish)
      throw new CLIError(
        "Confirm publishing this exact Skill Set release before continuing.",
        "MISSING_FLAG",
        "Preview the release, review its contents and checks, then confirm Publish to team.",
      );
    const initial = packageSkillSetRelease(input.setId);
    const dependencies = await resolveReleaseDependencies(
      initial.decoded,
      input.dependencyResolution,
    );
    const { bytes, decoded } = packageSkillSetRelease(input.setId, {
      roots: input.dependencyResolution.roots,
      available_packages: input.dependencyResolution.available_packages,
      environment: input.dependencyResolution.environment,
      lock: dependencies.lock,
    });
    if (
      decoded.envelope.skillSetRevisionSha256 !== input.expectedSkillSetRevisionSha256 ||
      decoded.portableSkillSetEnvelopeSha256 !== input.expectedEnvelopeSha256
    )
      throw new CLIError(
        "The Skill Set release changed after it was reviewed.",
        "GUARD_BLOCKED",
        "Preview the current release, review its contents and checks, then publish again.",
      );
    if (JSON.stringify(dependencies.lock) !== JSON.stringify(input.expectedDependencyLock))
      throw new CLIError(
        "The Skill Set dependency lock changed after it was reviewed.",
        "GUARD_BLOCKED",
        "Preview the current dependency impact, then publish again.",
      );
    const config = await connection();
    const authorization = { authorization: `Bearer ${config.apiKey}` };
    const intentBody = Schema.decodeUnknownSync(HostedSkillSetPublishIntentRequest)({
      skill_set_id: decoded.envelope.sourceManifest.skillSetId,
      skill_set_revision_sha256: decoded.envelope.skillSetRevisionSha256,
      envelope_sha256: decoded.portableSkillSetEnvelopeSha256,
      byte_length: bytes.byteLength,
    });
    const intentResponse = await requestFetch(
      new URL("/api/v1/desktop/releases/publish-intent", config.url),
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify(intentBody),
      },
    );
    if (!intentResponse.ok) throw cloudRequestError("Release publish intent", intentResponse);
    const intent = Schema.decodeUnknownSync(HostedSkillSetPublishIntentReceipt)(
      await intentResponse.json(),
    );
    const uploadResponse = await requestFetch(intent.upload_url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Blob([Uint8Array.from(bytes)]),
    });
    if (!uploadResponse.ok) throw cloudRequestError("Release upload", uploadResponse);
    const upload = Schema.decodeUnknownSync(HostedSkillSetPublishUploadReceipt)(
      await uploadResponse.json(),
    );
    const finalizeBody = Schema.decodeUnknownSync(HostedSkillSetPublishFinalizeRequest)({
      publish_intent_id: intent.publish_intent_id,
      storage_id: upload.storageId,
    });
    const finalizeResponse = await requestFetch(
      new URL("/api/v1/desktop/releases/finalize", config.url),
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify(finalizeBody),
      },
    );
    if (!finalizeResponse.ok) throw cloudRequestError("Release finalization", finalizeResponse);
    const release = Schema.decodeUnknownSync(HostedSkillSetReleaseReceipt)(
      await finalizeResponse.json(),
    );
    if (
      release.skill_set_id !== decoded.envelope.sourceManifest.skillSetId ||
      release.skill_set_revision_sha256 !== decoded.envelope.skillSetRevisionSha256 ||
      release.envelope_sha256 !== decoded.portableSkillSetEnvelopeSha256
    )
      throw new CLIError(
        "Cloud returned a release that does not match the reviewed Skill Set.",
        "GUARD_BLOCKED",
        "Keep the local release unchanged and contact support before retrying.",
      );
    return release;
  };

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
  return {
    isCloudConnection,
    listSkillSetAssignments,
    downloadSkillSetAssignmentPackage,
    submitSkillSetInstallationReceipt,
    publishRevalidationSummary,
    uploadContribution,
    previewSkillSetPublish,
    publishSkillSet,
    sync,
    share,
  } as const;
}
