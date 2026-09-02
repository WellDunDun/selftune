/* oxlint-disable max-lines -- explicit local privacy and durable upload state are kept together */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  decodePortableSkillSetEnvelope,
  encodeCanonicalSkillSetSourceManifest,
  encodePortablePackageBundle,
  encodePortableSkillSetEnvelope,
} from "@selftune/control-plane";
import * as Effect from "effect/Effect";

const STATE_DIRECTORY = "team-contributions";
const STATE_FILE = "state-v1.json";
const PACKAGE_DIRECTORY = "packages";
const SECRET_NAMES =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\.json)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)(?:\.pub)?)$/i;
const PRIVATE_CONTENT =
  /(?:-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----|(?:^|\s)(?:\/Users|\/home)\/[A-Za-z0-9._-]+\/|(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_-]{12,})/im;

export class TeamSkillSetContributionError extends Error {
  readonly name = "TeamSkillSetContributionError";
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function fail(code: string, message: string, retryable = false): never {
  throw new TeamSkillSetContributionError(code, message, retryable);
}

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface TeamContributionInstalledCopy {
  readonly receiptId: string;
  readonly agent: "codex" | "claude_code" | "opencode" | "openclaw" | "pi";
  readonly skillName: string;
  readonly targetPath: string;
}

export interface TeamContributionAssignmentContext {
  readonly assignmentId: string;
  readonly assignmentRequestId: string;
  readonly skillSetId: string;
  readonly releaseId: string;
  /** Opaque local proof that this assignment belongs to the current member and linked device. */
  readonly memberDeviceBinding: string;
  readonly baseEnvelopeBytes: Uint8Array;
  readonly installedCopies: ReadonlyArray<TeamContributionInstalledCopy>;
}

export interface TeamContributionUploadRequest {
  readonly request_id: string;
  readonly skill_set_id: string;
  readonly base_release_id: string;
  readonly proposed_skill_set_revision_sha256: string;
  readonly proposed_envelope_sha256: string;
  readonly proposed_byte_length: number;
  readonly title: string;
  readonly message: string;
}

export interface TeamSkillSetContributionHostedClient {
  /** Performs authenticated upload intent, direct byte upload, then finalization. */
  readonly uploadContribution: (
    request: TeamContributionUploadRequest,
    bytes: Uint8Array,
  ) => Promise<{
    readonly contribution_id: string;
    readonly request_id: string;
  }>;
}

export interface TeamSkillSetContributionRuntimeOptions {
  readonly configRoot: string;
  readonly loadCurrentAssignment: (
    assignmentId: string,
  ) => Promise<TeamContributionAssignmentContext>;
  readonly hosted: TeamSkillSetContributionHostedClient;
  readonly now?: () => number;
}

export interface TeamContributionPreviewInput {
  readonly assignmentId: string;
  readonly title: string;
  readonly message: string;
  readonly sourceReceiptIds?: ReadonlyArray<string>;
}

export interface TeamContributionPreview {
  readonly ready: true;
  readonly readiness: {
    readonly status: "ready";
    readonly checkedComponents: number;
    readonly blockedComponents: 0;
    readonly summary: string;
  };
  readonly previewToken: string;
  readonly assignmentId: string;
  readonly baseReleaseId: string;
  readonly proposedSkillSetRevisionSha256: string;
  readonly proposedEnvelopeSha256: string;
  readonly byteLength: number;
  readonly sourceChoices: ReadonlyArray<{
    readonly receiptId: string;
    readonly agent: TeamContributionInstalledCopy["agent"];
    readonly skillName: string;
    readonly selected: boolean;
  }>;
  readonly changes: ReadonlyArray<{
    readonly componentName: string;
    readonly changeType: "added" | "modified" | "removed";
    readonly packagePaths: ReadonlyArray<string>;
  }>;
}

interface MemoryPreview {
  readonly output: TeamContributionPreview;
  readonly contextBinding: string;
  readonly assignmentRequestId: string;
  readonly skillSetId: string;
  readonly title: string;
  readonly message: string;
  readonly selected: ReadonlyArray<TeamContributionInstalledCopy>;
  readonly sourceFingerprints: ReadonlyArray<string>;
  readonly bytes: Uint8Array;
}

interface StoredUpload {
  readonly request: TeamContributionUploadRequest;
  readonly packageFile: string;
  readonly attempts: number;
  readonly lastAttemptAt: number | null;
  readonly deliveredAt: number | null;
  readonly contributionId: string | null;
}

interface StoredState {
  readonly version: 1;
  readonly outbox: Record<string, StoredUpload>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateState(value: unknown): StoredState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.outbox))
    return fail("CONTRIBUTION_STATE_CORRUPT", "The local contribution upload state is invalid.");
  return value as unknown as StoredState;
}

function stateStore(configRoot: string) {
  const directory = join(configRoot, STATE_DIRECTORY);
  const path = join(directory, STATE_FILE);
  let queue: Promise<unknown> = Promise.resolve();
  const load = async (): Promise<StoredState> => {
    try {
      return validateState(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch (cause) {
      if (cause instanceof TeamSkillSetContributionError) throw cause;
      if (isRecord(cause) && cause.code === "ENOENT") return { version: 1, outbox: {} };
      return fail(
        "CONTRIBUTION_STATE_CORRUPT",
        "The local contribution upload state could not be read.",
      );
    }
  };
  const save = async (state: StoredState) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.state-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(state)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  };
  const exclusive = <A>(run: (state: StoredState) => Promise<A>) => {
    const next = queue.then(() => load()).then(run);
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    read: () => exclusive(async (state) => state),
    update: (change: (state: StoredState) => StoredState | Promise<StoredState>) =>
      exclusive(async (state) => {
        const next = await change(state);
        await save(next);
        return next;
      }),
    directory,
  } as const;
}

async function collectFiles(root: string) {
  const canonicalRoot = await realpath(root).catch(() =>
    fail("CONTRIBUTION_SOURCE_UNAVAILABLE", "An installed contribution source is unavailable."),
  );
  const files: Array<{ readonly path: string; readonly content: Uint8Array }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (SECRET_NAMES.test(entry.name))
        return fail(
          "CONTRIBUTION_SECRET_FILE",
          `Remove the secret-like file “${entry.name}” before contributing.`,
        );
      const absolute = join(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink())
        return fail(
          "CONTRIBUTION_UNSAFE_SOURCE",
          "Contribution sources cannot contain symbolic links.",
        );
      if (stat.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!stat.isFile())
        return fail(
          "CONTRIBUTION_UNSAFE_SOURCE",
          "Contribution sources can contain only regular files.",
        );
      const canonical = await realpath(absolute);
      if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`))
        return fail(
          "CONTRIBUTION_UNSAFE_SOURCE",
          "A contribution file resolves outside its installed skill.",
        );
      const packagePath = relative(canonicalRoot, canonical).split(sep).join("/");
      const content = new Uint8Array(await readFile(canonical));
      if (PRIVATE_CONTENT.test(new TextDecoder().decode(content)))
        return fail(
          "CONTRIBUTION_PRIVATE_CONTENT",
          `Remove local paths or secret-like content from “${packagePath}” before contributing.`,
        );
      files.push({ path: packagePath, content });
    }
  };
  await visit(canonicalRoot);
  if (!files.some((file) => file.path === "SKILL.md"))
    return fail("CONTRIBUTION_INVALID_SKILL", "Every contributed skill must contain SKILL.md.");
  return files;
}

function assertPrivacySafeText(value: string): string {
  if (
    /(?:^|\s)(?:\/Users|\/home)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._ -]+)+/.test(value) ||
    /(?:^|\s)[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/.test(value)
  )
    return fail(
      "CONTRIBUTION_LOCAL_PATH",
      "Remove local file paths from the contribution title and message before submitting.",
    );
  return value;
}

async function sourceFingerprint(source: TeamContributionInstalledCopy): Promise<string> {
  const files = await collectFiles(source.targetPath);
  const sealed = await Effect.runPromise(encodePortablePackageBundle({ files }));
  return digest(sealed);
}

export function makeTeamSkillSetContributionRuntime(
  options: TeamSkillSetContributionRuntimeOptions,
) {
  const store = stateStore(options.configRoot);
  const now = options.now ?? Date.now;
  const previews = new Map<string, MemoryPreview>();

  const preview = async (input: TeamContributionPreviewInput): Promise<TeamContributionPreview> => {
    const context = await options.loadCurrentAssignment(input.assignmentId);
    if (!context.memberDeviceBinding)
      return fail(
        "CONTRIBUTION_ASSIGNMENT_UNBOUND",
        "Only the assigned member and linked device can contribute this install.",
      );
    const base = await Effect.runPromise(
      decodePortableSkillSetEnvelope(context.baseEnvelopeBytes),
    ).catch(() =>
      fail(
        "CONTRIBUTION_BASE_INVALID",
        "The cached verified base release is unavailable or invalid.",
      ),
    );
    if (
      base.envelope.sourceManifest.skillSetId !== context.skillSetId ||
      context.installedCopies.length === 0
    )
      return fail(
        "CONTRIBUTION_BASE_INVALID",
        "The installed assignment does not match its cached base release.",
      );

    const candidates = await Promise.all(
      context.installedCopies.map(async (copy) => ({
        copy,
        fingerprint: await sourceFingerprint(copy),
      })),
    );
    const requested = new Set(input.sourceReceiptIds ?? []);
    const selected: TeamContributionInstalledCopy[] = [];
    for (const component of base.envelope.components) {
      const choices = candidates.filter(({ copy }) => copy.skillName === component.logicalSkillId);
      const distinct = new Set(choices.map(({ fingerprint }) => fingerprint));
      const explicitlySelected = choices.filter(({ copy }) => requested.has(copy.receiptId));
      if (explicitlySelected.length > 1 || (distinct.size > 1 && explicitlySelected.length !== 1))
        return fail(
          "CONTRIBUTION_SOURCE_REQUIRED",
          `Choose the exact installed copy of “${component.logicalSkillId}” to contribute.`,
        );
      const choice = explicitlySelected[0]?.copy ?? choices[0]?.copy;
      if (!choice)
        return fail(
          "CONTRIBUTION_SOURCE_UNAVAILABLE",
          `No current installed copy exists for “${component.logicalSkillId}”.`,
        );
      selected.push(choice);
    }
    if (requested.size !== selected.filter((copy) => requested.has(copy.receiptId)).length)
      return fail(
        "CONTRIBUTION_SOURCE_INVALID",
        "A selected contribution source is not part of the current assignment install.",
      );

    const packaged = await Promise.all(
      selected.map(async (copy, ordinal) => {
        const files = await collectFiles(copy.targetPath);
        const sealedPackageBytes = await Effect.runPromise(encodePortablePackageBundle({ files }));
        const sourceRevisionSha256 = digest(sealedPackageBytes);
        return {
          copy,
          ordinal,
          files,
          sealedPackageBytes,
          sourceRevisionSha256,
        };
      }),
    );
    const source = await Effect.runPromise(
      encodeCanonicalSkillSetSourceManifest({
        skillSetId: base.envelope.sourceManifest.skillSetId,
        name: base.envelope.sourceManifest.name,
        description: base.envelope.sourceManifest.description,
        harnesses: base.envelope.sourceManifest.harnesses,
        components: packaged.map((item) => ({
          ordinal: item.ordinal,
          logicalSkillId: item.copy.skillName,
          sourceRevisionSha256: item.sourceRevisionSha256,
          sourcePackageObjectSha256: digest(item.sealedPackageBytes),
        })),
      }),
    );
    const encoded = await Effect.runPromise(
      encodePortableSkillSetEnvelope({
        sourceManifestBytes: source.bytes,
        components: packaged.map((item, index) => {
          const original = base.envelope.components[index];
          if (!original || original.logicalSkillId !== item.copy.skillName)
            return fail(
              "CONTRIBUTION_BASE_INVALID",
              "The installed component order differs from the base release.",
            );
          return {
            ordinal: item.ordinal,
            logicalSkillId: item.copy.skillName,
            sourceRevisionSha256: item.sourceRevisionSha256,
            sourcePackageObjectSha256: digest(item.sealedPackageBytes),
            sealedPackageBytes: item.sealedPackageBytes,
            terms: {
              licenseExpression: original.terms.licenseExpression,
              ...(original.terms.licenseFile
                ? { licenseFilePath: original.terms.licenseFile.path }
                : {}),
              noticePaths: original.terms.notices.map((notice) => notice.path),
            },
          };
        }),
      }),
    );
    const fingerprints = await Promise.all(selected.map(sourceFingerprint));
    const previewToken = `contribution_preview_v1_${digest(
      JSON.stringify({
        assignmentId: context.assignmentId,
        assignmentRequestId: context.assignmentRequestId,
        binding: context.memberDeviceBinding,
        fingerprints,
        envelope: encoded.portableSkillSetEnvelopeSha256,
        title: input.title,
        message: input.message,
      }),
    ).slice(0, 40)}`;
    const changes = packaged.flatMap((item, index) => {
      const original = base.envelope.components[index];
      if (original?.sealedPackageObjectSha256 === digest(item.sealedPackageBytes)) return [];
      return [
        {
          componentName: item.copy.skillName,
          changeType: "modified" as const,
          packagePaths: item.files.map((file) => file.path),
        },
      ];
    });
    if (changes.length === 0)
      return fail(
        "CONTRIBUTION_NO_CHANGES",
        "The selected installed copy is identical to the base release.",
      );
    const output: TeamContributionPreview = {
      ready: true,
      readiness: {
        status: "ready",
        checkedComponents: packaged.length,
        blockedComponents: 0,
        summary: `${packaged.length} candidate component${packaged.length === 1 ? " is" : "s are"} valid and ready for team review.`,
      },
      previewToken,
      assignmentId: context.assignmentId,
      baseReleaseId: context.releaseId,
      proposedSkillSetRevisionSha256: encoded.envelope.skillSetRevisionSha256,
      proposedEnvelopeSha256: encoded.portableSkillSetEnvelopeSha256,
      byteLength: encoded.bytes.byteLength,
      sourceChoices: context.installedCopies.map((copy) => ({
        receiptId: copy.receiptId,
        agent: copy.agent,
        skillName: copy.skillName,
        selected: selected.some((choice) => choice.receiptId === copy.receiptId),
      })),
      changes,
    };
    previews.set(previewToken, {
      output,
      contextBinding: context.memberDeviceBinding,
      assignmentRequestId: context.assignmentRequestId,
      skillSetId: context.skillSetId,
      title: assertPrivacySafeText(input.title),
      message: assertPrivacySafeText(input.message),
      selected,
      sourceFingerprints: fingerprints,
      bytes: encoded.bytes,
    });
    return output;
  };

  const flush = async () => {
    const state = await store.read();
    let sent = 0;
    for (const item of Object.values(state.outbox).filter(
      (candidate) => candidate.deliveredAt === null,
    )) {
      try {
        const bytes = new Uint8Array(
          await readFile(join(store.directory, PACKAGE_DIRECTORY, item.packageFile)),
        );
        if (
          digest(bytes) !== item.request.proposed_envelope_sha256 ||
          bytes.byteLength !== item.request.proposed_byte_length
        )
          return fail(
            "CONTRIBUTION_PACKAGE_CORRUPT",
            "A pending contribution package failed local integrity checks.",
          );
        const receipt = await options.hosted.uploadContribution(item.request, bytes);
        if (receipt.request_id !== item.request.request_id)
          return fail(
            "CONTRIBUTION_RECEIPT_MISMATCH",
            "Cloud returned a contribution for a different request.",
          );
        await store.update(async (latest) => ({
          ...latest,
          outbox: {
            ...latest.outbox,
            [item.request.request_id]: {
              ...(latest.outbox[item.request.request_id] ?? item),
              attempts: item.attempts + 1,
              lastAttemptAt: now(),
              deliveredAt: now(),
              contributionId: receipt.contribution_id,
            },
          },
        }));
        sent += 1;
      } catch (cause) {
        if (cause instanceof TeamSkillSetContributionError) throw cause;
        await store.update(async (latest) => ({
          ...latest,
          outbox: {
            ...latest.outbox,
            [item.request.request_id]: {
              ...(latest.outbox[item.request.request_id] ?? item),
              attempts: item.attempts + 1,
              lastAttemptAt: now(),
            },
          },
        }));
      }
    }
    const latest = await store.read();
    return {
      sent,
      pending: Object.values(latest.outbox).filter((item) => item.deliveredAt === null).length,
    };
  };

  const submit = async (input: {
    readonly previewToken: string;
    readonly confirmSubmit: boolean;
  }) => {
    if (!input.confirmSubmit)
      return fail(
        "CONTRIBUTION_CONFIRMATION_REQUIRED",
        "Confirm the reviewed contribution before submitting it.",
      );
    const reviewed = previews.get(input.previewToken);
    if (!reviewed)
      return fail(
        "STALE_CONTRIBUTION_PREVIEW",
        "Preview this contribution again before submitting it.",
      );
    const context = await options.loadCurrentAssignment(reviewed.output.assignmentId);
    const currentFingerprints = await Promise.all(reviewed.selected.map(sourceFingerprint));
    if (
      context.assignmentRequestId !== reviewed.assignmentRequestId ||
      context.memberDeviceBinding !== reviewed.contextBinding ||
      currentFingerprints.some((value, index) => value !== reviewed.sourceFingerprints[index])
    )
      return fail(
        "STALE_CONTRIBUTION_PREVIEW",
        "The assignment or selected local bytes changed after preview.",
      );
    const requestId = `contribution_v1_${digest(`${input.previewToken}:${reviewed.output.proposedEnvelopeSha256}`).slice(0, 40)}`;
    const request: TeamContributionUploadRequest = {
      request_id: requestId,
      skill_set_id: reviewed.skillSetId,
      base_release_id: reviewed.output.baseReleaseId,
      proposed_skill_set_revision_sha256: reviewed.output.proposedSkillSetRevisionSha256,
      proposed_envelope_sha256: reviewed.output.proposedEnvelopeSha256,
      proposed_byte_length: reviewed.bytes.byteLength,
      title: reviewed.title,
      message: reviewed.message,
    };
    const packageFile = `${requestId}.json`;
    await mkdir(join(store.directory, PACKAGE_DIRECTORY), {
      recursive: true,
      mode: 0o700,
    });
    const packagePath = join(store.directory, PACKAGE_DIRECTORY, packageFile);
    const temporary = join(store.directory, PACKAGE_DIRECTORY, `.${randomUUID()}.tmp`);
    await writeFile(temporary, reviewed.bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, packagePath);
    await store.update(async (state) => ({
      ...state,
      outbox: {
        ...state.outbox,
        [requestId]: state.outbox[requestId] ?? {
          request,
          packageFile,
          attempts: 0,
          lastAttemptAt: null,
          deliveredAt: null,
          contributionId: null,
        },
      },
    }));
    previews.delete(input.previewToken);
    await flush();
    const state = await store.read();
    const stored = state.outbox[requestId]!;
    return {
      requestId,
      contributionId: stored.contributionId,
      syncStatus: stored.deliveredAt === null ? ("pending" as const) : ("synced" as const),
    };
  };

  return { preview, submit, flush } as const;
}
