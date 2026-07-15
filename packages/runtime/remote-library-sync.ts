import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  buildRemoteSnapshot,
  RemoteArtifact,
  sha256,
  type RemoteArtifact as RemoteArtifactType,
  type RemoteDiagnostics,
  type RemoteSnapshot,
  type SyncPreferences,
} from "@selftune/control-plane";
import * as Schema from "effect/Schema";

import { SELFTUNE_CONFIG_DIR } from "./constants.js";
import { sanitizeConservative, sanitizeSecrets } from "./contribute/sanitize.js";
import { loadLibraryCatalog, type LibraryCatalogOptions } from "./library-catalog.js";
import type { RemoteLibraryHandle } from "./remote-library-runtime.js";
import { listSkillSets } from "./skill-sets.js";
import { listSynthesisReleases, loadCandidateSnapshot } from "./synthesis.js";
import { CLIError } from "./utils/cli-error.js";
import { computeSkillVersionHash } from "./utils/skill-discovery.js";

const PackageFile = Schema.Struct({ path: Schema.String, contentBase64: Schema.String });
const ReleaseAuthority = Schema.Struct({
  schema_version: Schema.Literal(1),
  candidate_id: Schema.String,
  evidence_snapshot_id: Schema.String,
  candidate_revision_hash: Schema.String,
  skill_name: Schema.String,
  draft_path: Schema.String,
  revision_hash: Schema.String,
  evaluated_at: Schema.String,
  replay_exit_code: Schema.Number,
  baseline_exit_code: Schema.Number,
  held_out_eval_ids: Schema.Array(Schema.String),
  recommended: Schema.Boolean,
  blockers: Schema.Array(Schema.String),
  evaluation: Schema.Unknown,
});
type ReleaseAuthority = typeof ReleaseAuthority.Type;
const PackageBundle = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Array(PackageFile),
  releaseAuthority: Schema.optionalKey(ReleaseAuthority),
});
const BackupObject = Schema.Struct({ objectHash: Schema.String, contentBase64: Schema.String });
const RemoteLibraryBackup = Schema.Struct({
  version: Schema.Literal(1),
  exportedAt: Schema.String,
  headSnapshotId: Schema.NullOr(Schema.String),
  snapshots: Schema.Array(Schema.Unknown),
  objects: Schema.Array(BackupObject),
});

const IGNORED_PACKAGE_ENTRIES = new Set([".git", "node_modules", ".env"]);
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const SELFTUNE_HASH_FIELDS = new Set([
  "candidate_revision_hash",
  "content_hash",
  "evidenceSnapshotId",
  "evidence_snapshot_id",
  "objectHash",
  "revision_hash",
  "revision_hashes",
  "sourceSessionIds",
  "source_session_ids",
  "supporting_session_ids",
  "held_out_session_ids",
]);
const SELFTUNE_HASH = /^[a-f0-9]{64}$/i;

function safePackageEntry(name: string): boolean {
  return !IGNORED_PACKAGE_ENTRIES.has(name) && !name.startsWith(".env.");
}

function collectPackageFiles(
  root: string,
  current = root,
): Array<{ path: string; contentBase64: string }> {
  const files: Array<{ path: string; contentBase64: string }> = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (!safePackageEntry(entry.name)) continue;
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...collectPackageFiles(root, absolute));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push({
      path: relative(root, absolute).split(sep).join("/"),
      contentBase64: readFileSync(absolute).toString("base64"),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function maskOwnedHashes(value: unknown, field = ""): unknown {
  if (typeof value === "string") {
    return SELFTUNE_HASH_FIELDS.has(field) && SELFTUNE_HASH.test(value) ? "[SELFTUNE_HASH]" : value;
  }
  if (Array.isArray(value)) return value.map((item) => maskOwnedHashes(item, field));
  if (value === null || typeof value !== "object") return value;
  const record = Schema.decodeUnknownSync(UnknownRecord)(value);
  return Object.fromEntries(
    Object.entries(record).map(([key, nested]) => [key, maskOwnedHashes(nested, key)]),
  );
}

function contentForSecretScan(path: string, content: string): string {
  if (
    path !== "evals/generated.json" &&
    path !== "evals/release.json" &&
    path !== "selftune.synthesis.json"
  ) {
    return content;
  }
  try {
    const decoded: unknown = JSON.parse(content);
    return JSON.stringify(maskOwnedHashes(decoded));
  } catch {
    return content;
  }
}

function remoteSafePackageFiles(packagePath: string) {
  return collectPackageFiles(resolve(packagePath)).map((file) => {
    if (/(^|\/)(?:id_rsa|id_ed25519|credentials)(?:\.|$)|\.(?:pem|key|p12)$/i.test(file.path)) {
      throw new CLIError(
        `Remote Library blocked a credential-like package file: ${file.path}`,
        "GUARD_BLOCKED",
        "Remove the credential file or disable backup for this artifact.",
      );
    }
    const decodedContent = Buffer.from(file.contentBase64, "base64").toString("utf8");
    const scanContent = contentForSecretScan(file.path, decodedContent);
    if (!decodedContent.includes("\u0000") && sanitizeSecrets(scanContent) !== scanContent) {
      throw new CLIError(
        `Remote Library found a secret in package file ${file.path}.`,
        "GUARD_BLOCKED",
        "Remove or redact the secret before syncing this artifact.",
      );
    }
    if (file.path !== "selftune.synthesis.json") return file;
    try {
      const provenance = Schema.decodeUnknownSync(UnknownRecord)(
        JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8")),
      );
      const pseudonymize = (value: unknown) =>
        Array.isArray(value)
          ? value
              .filter((item): item is string => typeof item === "string")
              .map((item) =>
                /^[a-f0-9]{64}$/i.test(item) ? item : sha256(new TextEncoder().encode(item)),
              )
          : [];
      return {
        ...file,
        contentBase64: Buffer.from(
          `${JSON.stringify(
            {
              ...provenance,
              supporting_session_ids: pseudonymize(provenance.supporting_session_ids),
              held_out_session_ids: pseudonymize(provenance.held_out_session_ids),
            },
            null,
            2,
          )}\n`,
        ).toString("base64"),
      };
    } catch (error) {
      throw new CLIError(
        `Draft provenance cannot be prepared for Remote Library sync: ${error instanceof Error ? error.message : String(error)}`,
        "GUARD_BLOCKED",
        "Repair selftune.synthesis.json or disable draft backup.",
      );
    }
  });
}

export function encodePackageBundle(
  packagePath: string,
  remoteSafe = false,
  releaseAuthority?: ReleaseAuthority,
): Uint8Array {
  const files = remoteSafe
    ? remoteSafePackageFiles(packagePath)
    : collectPackageFiles(resolve(packagePath));
  if (!files.some((file) => file.path.toUpperCase() === "SKILL.MD")) {
    throw new CLIError(`Package has no SKILL.md: ${packagePath}`, "FILE_NOT_FOUND");
  }
  return new TextEncoder().encode(
    JSON.stringify(
      PackageBundle.make({
        version: 1,
        files,
        ...(releaseAuthority ? { releaseAuthority } : {}),
      }),
    ),
  );
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

interface LocalObject {
  artifact: RemoteArtifactType;
  bytes: Uint8Array;
}

async function collectLocalObjects(options: {
  configRoot: string;
  preferences: SyncPreferences;
  catalogOptions?: LibraryCatalogOptions;
}): Promise<LocalObject[]> {
  const snapshot = await loadLibraryCatalog({
    ...options.catalogOptions,
    skillSetConfigRoot: options.configRoot,
  });
  const objects: LocalObject[] = [];
  const skillRevisions = new Map<string, LocalObject>();

  const addSkillRevision = (input: {
    name: string;
    packagePath: string;
    revisionHash: string;
    updatedAt: string;
    releaseAuthority?: ReleaseAuthority;
  }): void => {
    const identity = `${input.name}\u0000${input.revisionHash}`;
    if (skillRevisions.has(identity) && !input.releaseAuthority) return;
    const bytes = encodePackageBundle(input.packagePath, true, input.releaseAuthority);
    if (input.releaseAuthority) {
      const localBytes = encodePackageBundle(input.packagePath, false, input.releaseAuthority);
      if (sha256(bytes) !== sha256(localBytes)) {
        throw new CLIError(
          `Released package ${input.name} contains provenance that predates privacy-safe release hashing.`,
          "GUARD_BLOCKED",
          "Create and evaluate a new release before enabling Remote Library sync.",
        );
      }
    }
    skillRevisions.set(identity, {
      bytes,
      artifact: RemoteArtifact.make({
        artifactId: `skill/${input.name}/${input.revisionHash}`,
        artifactType: "skill_revision",
        objectHash: sha256(bytes),
        revisionHash: input.revisionHash,
        updatedAt: input.updatedAt,
      }),
    });
  };

  if (options.preferences.releasedSkills) {
    for (const release of listSynthesisReleases(options.configRoot)) {
      const authority = Schema.decodeUnknownSync(ReleaseAuthority)(
        JSON.parse(readFileSync(release.gate_path, "utf8")),
      );
      addSkillRevision({
        name: release.skill_name,
        packagePath: release.package_path,
        revisionHash: release.revision_hash,
        updatedAt: release.released_at,
        releaseAuthority: authority,
      });
    }
  }

  for (const skill of snapshot.skills) {
    for (const location of skill.locations) {
      const revisionHash = skill.revisions.find((revision) =>
        revision.locations.some(
          (revisionLocation) => revisionLocation.packagePath === location.packagePath,
        ),
      )?.contentHash;
      if (!revisionHash) continue;
      if (location.sourceKind !== "draft" && options.preferences.releasedSkills) {
        addSkillRevision({
          name: skill.name,
          packagePath: location.packagePath,
          revisionHash,
          updatedAt: location.modifiedAt,
        });
        continue;
      }
      if (location.sourceKind !== "draft" || !options.preferences.drafts) continue;
      const bytes = encodePackageBundle(location.packagePath, true);
      const objectHash = sha256(bytes);
      objects.push({
        bytes,
        artifact: RemoteArtifact.make({
          artifactId: `draft/${skill.name}/${revisionHash}`,
          artifactType: "draft",
          objectHash,
          revisionHash,
          updatedAt: location.modifiedAt,
        }),
      });
    }
  }

  if (options.preferences.skillSets) {
    for (const set of listSkillSets({ configRoot: options.configRoot })) {
      for (const skill of set.skills) {
        addSkillRevision({
          name: skill.name,
          packagePath: skill.library_package_path,
          revisionHash: skill.content_hash,
          updatedAt: set.updated_at,
        });
      }
      const bytes = jsonBytes({
        ...set,
        skills: set.skills.map(({ name, content_hash }) => ({ name, content_hash })),
      });
      objects.push({
        bytes,
        artifact: RemoteArtifact.make({
          artifactId: `skill-set/${set.set_id}/${set.revision_hash}`,
          artifactType: "skill_set",
          objectHash: sha256(bytes),
          revisionHash: set.revision_hash,
          updatedAt: set.updated_at,
        }),
      });
    }
  }

  objects.unshift(...skillRevisions.values());

  if (options.preferences.metadata) {
    const bytes = jsonBytes({
      version: 1,
      generated_at: snapshot.generatedAt,
      skills: snapshot.skills.map((skill) => ({
        skill_id: skill.skillId,
        name: skill.name,
        revision_hashes: skill.revisions.map((revision) => revision.contentHash),
        location_count: skill.locations.length,
        source_kinds: [...new Set(skill.locations.map((location) => location.sourceKind))].sort(),
        lifecycle: skill.lifecycle,
      })),
    });
    objects.push({
      bytes,
      artifact: RemoteArtifact.make({
        artifactId: `metadata/library/${sha256(bytes)}`,
        artifactType: "metadata",
        objectHash: sha256(bytes),
        revisionHash: null,
        updatedAt: snapshot.generatedAt,
      }),
    });
  }

  const candidatesPath = join(options.configRoot, "synthesis", "candidates.json");
  const legacyDecisionsPath = join(options.configRoot, "memory", "decisions.md");
  const decisionsPath = existsSync(candidatesPath) ? candidatesPath : legacyDecisionsPath;
  if (options.preferences.decisionHistory && existsSync(decisionsPath)) {
    const bytes = existsSync(candidatesPath)
      ? jsonBytes({
          version: 1,
          decisions: loadCandidateSnapshot(options.configRoot)
            .candidates.filter((candidate) => candidate.decisionHistory.length > 0)
            .map((candidate) => ({
              candidate_id: candidate.candidateId,
              kind: candidate.kind,
              status: candidate.status,
              evidence: candidate.evidence,
              decision_history: candidate.decisionHistory.map((decision) => ({
                ...decision,
                reason: sanitizeConservative(decision.reason),
              })),
            })),
        })
      : jsonBytes({
          version: 1,
          legacy_decisions: sanitizeConservative(readFileSync(decisionsPath, "utf8")),
        });
    objects.push({
      bytes,
      artifact: RemoteArtifact.make({
        artifactId: existsSync(candidatesPath)
          ? `decision-history/synthesis-candidates/${sha256(bytes)}`
          : `decision-history/legacy/${sha256(bytes)}`,
        artifactType: "decision_history",
        objectHash: sha256(bytes),
        revisionHash: null,
        updatedAt: statSync(decisionsPath).mtime.toISOString(),
      }),
    });
  }
  return objects;
}

export async function previewRemoteLibrarySync(options: {
  configRoot?: string;
  preferences: SyncPreferences;
  catalogOptions?: LibraryCatalogOptions;
}): Promise<{
  artifacts: Array<RemoteArtifactType & { bytes: number; preview: unknown }>;
  totalBytes: number;
}> {
  const objects = await collectLocalObjects({
    configRoot: resolve(options.configRoot ?? SELFTUNE_CONFIG_DIR),
    preferences: options.preferences,
    catalogOptions: options.catalogOptions,
  });
  return {
    artifacts: objects.map((object) => {
      let preview: unknown;
      try {
        const decoded = JSON.parse(new TextDecoder().decode(object.bytes)) as unknown;
        const files =
          decoded && typeof decoded === "object" && "files" in decoded
            ? (decoded as { files?: unknown }).files
            : null;
        preview = Array.isArray(files)
          ? {
              files: files.flatMap((file) => {
                if (
                  !file ||
                  typeof file !== "object" ||
                  !("path" in file) ||
                  typeof file.path !== "string" ||
                  !("contentBase64" in file) ||
                  typeof file.contentBase64 !== "string"
                ) {
                  return [];
                }
                const bytes = Buffer.from(file.contentBase64, "base64");
                const content = bytes.toString("utf8");
                return [
                  {
                    path: file.path,
                    bytes: bytes.length,
                    sha256: sha256(bytes),
                    text_preview: content.includes("\u0000") ? null : content.slice(0, 240),
                    truncated: !content.includes("\u0000") && content.length > 240,
                  },
                ];
              }),
            }
          : decoded;
      } catch {
        preview = { format: "binary" };
      }
      return { ...object.artifact, bytes: object.bytes.byteLength, preview };
    }),
    totalBytes: objects.reduce((total, object) => total + object.bytes.byteLength, 0),
  };
}

export async function syncRemoteLibrary(options: {
  handle: RemoteLibraryHandle;
  configRoot?: string;
  preferences: SyncPreferences;
  catalogOptions?: LibraryCatalogOptions;
  now?: Date;
}): Promise<{ snapshot: RemoteSnapshot; uploaded: number; unchanged: number }> {
  const configRoot = resolve(options.configRoot ?? SELFTUNE_CONFIG_DIR);
  const localObjects = await collectLocalObjects({
    configRoot,
    preferences: options.preferences,
    catalogOptions: options.catalogOptions,
  });
  let uploaded = 0;
  let unchanged = 0;
  for (const object of localObjects) {
    if (await options.handle.hasObject(object.artifact.objectHash)) {
      unchanged += 1;
      continue;
    }
    await options.handle.putObject(object.artifact.objectHash, object.bytes);
    uploaded += 1;
  }
  const localArtifacts = localObjects.map((object) => object.artifact);
  const artifactIdentity = (artifact: RemoteArtifactType) => ({
    artifactId: artifact.artifactId,
    artifactType: artifact.artifactType,
    objectHash: artifact.objectHash,
    revisionHash: artifact.revisionHash,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const head = await options.handle.head();
    const merged = new Map<string, RemoteArtifactType>();
    for (const artifact of head?.artifacts ?? []) merged.set(artifact.artifactId, artifact);
    for (const artifact of localArtifacts) {
      const existing = merged.get(artifact.artifactId);
      if (existing && existing.objectHash !== artifact.objectHash) {
        throw new CLIError(
          `Remote Library conflict for ${artifact.artifactId}.`,
          "GUARD_BLOCKED",
          "Review both immutable revisions before choosing an active pointer.",
        );
      }
      merged.set(artifact.artifactId, artifact);
    }
    const artifacts = [...merged.values()].toSorted((left, right) =>
      left.artifactId.localeCompare(right.artifactId),
    );
    if (
      head &&
      JSON.stringify(
        head.artifacts
          .map(artifactIdentity)
          .toSorted((left, right) => left.artifactId.localeCompare(right.artifactId)),
      ) === JSON.stringify(artifacts.map(artifactIdentity))
    ) {
      return { snapshot: head, uploaded, unchanged };
    }
    const snapshot = buildRemoteSnapshot({
      parentSnapshotId: head?.snapshotId ?? null,
      createdAt: (options.now ?? new Date()).toISOString(),
      artifacts,
    });
    try {
      return {
        snapshot: await options.handle.commitSnapshot(snapshot),
        uploaded,
        unchanged,
      };
    } catch (error) {
      const isConflict =
        error !== null &&
        typeof error === "object" &&
        "_tag" in error &&
        error._tag === "RemoteConflict";
      if (!isConflict || attempt === 2) throw error;
    }
  }
  throw new CLIError("Remote Library sync could not advance the head.", "OPERATION_FAILED");
}

async function snapshotHistory(handle: RemoteLibraryHandle): Promise<RemoteSnapshot[]> {
  const history: RemoteSnapshot[] = [];
  let current = await handle.head();
  while (current) {
    history.push(current);
    current = current.parentSnapshotId ? await handle.getSnapshot(current.parentSnapshotId) : null;
  }
  return history;
}

export async function exportRemoteLibrary(options: {
  handle: RemoteLibraryHandle;
  outputPath: string;
  now?: Date;
}): Promise<{ outputPath: string; snapshots: number; objects: number }> {
  const snapshots = await snapshotHistory(options.handle);
  const hashes = [
    ...new Set(
      snapshots.flatMap((snapshot) => snapshot.artifacts.map((artifact) => artifact.objectHash)),
    ),
  ].sort();
  const objects = await Promise.all(
    hashes.map(async (objectHash) => ({
      objectHash,
      contentBase64: Buffer.from(await options.handle.getObject(objectHash)).toString("base64"),
    })),
  );
  const backup = RemoteLibraryBackup.make({
    version: 1,
    exportedAt: (options.now ?? new Date()).toISOString(),
    headSnapshotId: snapshots[0]?.snapshotId ?? null,
    snapshots,
    objects,
  });
  const outputPath = resolve(options.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(backup, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { outputPath, snapshots: snapshots.length, objects: objects.length };
}

function assertSafeRelativePath(path: string): void {
  if (!path || isAbsolute(path) || path.split("/").some((part) => part === ".." || part === "")) {
    throw new CLIError(`Remote package contains an unsafe path: ${path}`, "OPERATION_FAILED");
  }
}

function restorePackage(bytes: Uint8Array, destination: string): ReleaseAuthority | undefined {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const bundle = Schema.decodeUnknownSync(PackageBundle)(parsed);
  for (const file of bundle.files) assertSafeRelativePath(file.path);
  for (const file of bundle.files) {
    const target = resolve(destination, file.path);
    const relativeTarget = relative(resolve(destination), target);
    if (relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
      throw new CLIError(
        `Remote package escaped its destination: ${file.path}`,
        "OPERATION_FAILED",
      );
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(file.contentBase64, "base64"), { flag: "wx" });
  }
  return bundle.releaseAuthority;
}

function artifactPackageIdentity(artifact: RemoteArtifactType): {
  skillName: string;
  revisionHash: string;
} {
  const parts = artifact.artifactId.split("/");
  const skillName = parts.at(-2) ?? "";
  const revisionHash = artifact.revisionHash ?? parts.at(-1) ?? "";
  assertSafeRelativePath(skillName);
  assertSafeRelativePath(revisionHash);
  return { skillName, revisionHash };
}

export async function restoreRemoteLibrary(options: {
  handle: RemoteLibraryHandle;
  targetRoot: string;
}): Promise<{ targetRoot: string; restored: number; snapshotId: string | null }> {
  const targetRoot = resolve(options.targetRoot);
  if (existsSync(targetRoot) && readdirSync(targetRoot).length > 0) {
    throw new CLIError("Restore target must be empty.", "GUARD_BLOCKED");
  }
  const head = await options.handle.head();
  if (!head) return { targetRoot, restored: 0, snapshotId: null };
  const staging = `${targetRoot}.restoring-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const artifacts = [...head.artifacts].toSorted((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt),
    );
    for (const artifact of artifacts) {
      const bytes = await options.handle.getObject(artifact.objectHash);
      if (sha256(bytes) !== artifact.objectHash) {
        throw new CLIError(
          `Remote object failed verification: ${artifact.objectHash}`,
          "OPERATION_FAILED",
        );
      }
      if (
        artifact.artifactType === "skill_revision" ||
        artifact.artifactType === "released_skill"
      ) {
        const identity = artifactPackageIdentity(artifact);
        const destination = join(
          staging,
          "library",
          "packages",
          identity.revisionHash,
          identity.skillName,
        );
        const authority = restorePackage(bytes, destination);
        if (computeSkillVersionHash(join(destination, "SKILL.md")) !== identity.revisionHash) {
          throw new CLIError("Restored release failed revision verification.", "OPERATION_FAILED");
        }
        if (!authority) continue;
        const releaseId = `remote-${identity.revisionHash}`;
        const gatePath = join(staging, "library", "release-gates", `${releaseId}.json`);
        const releasePath = join(staging, "library", "releases", `${releaseId}.json`);
        const finalPackagePath = join(
          targetRoot,
          "library",
          "packages",
          identity.revisionHash,
          identity.skillName,
        );
        const finalGatePath = join(targetRoot, "library", "release-gates", `${releaseId}.json`);
        if (
          !authority.recommended ||
          authority.revision_hash !== identity.revisionHash ||
          authority.skill_name !== identity.skillName ||
          authority.held_out_eval_ids.length === 0
        ) {
          throw new CLIError(
            "Remote release is missing its evaluated release authority.",
            "OPERATION_FAILED",
          );
        }
        const evaluation = Schema.decodeUnknownSync(UnknownRecord)(authority.evaluation);
        mkdirSync(dirname(gatePath), { recursive: true });
        mkdirSync(dirname(releasePath), { recursive: true });
        writeFileSync(
          gatePath,
          `${JSON.stringify(
            {
              ...authority,
              draft_path: finalPackagePath,
              evaluation: {
                ...evaluation,
                skill_path: join(finalPackagePath, "SKILL.md"),
              },
              restored_from_remote: true,
            },
            null,
            2,
          )}\n`,
          { flag: "wx", mode: 0o600 },
        );
        writeFileSync(
          releasePath,
          `${JSON.stringify(
            {
              schema_version: 1,
              candidate_id: authority.candidate_id,
              evidence_snapshot_id: authority.evidence_snapshot_id,
              candidate_revision_hash: authority.candidate_revision_hash,
              skill_name: identity.skillName,
              revision_hash: identity.revisionHash,
              package_path: finalPackagePath,
              gate_path: finalGatePath,
              released_at: head.createdAt,
            },
            null,
            2,
          )}\n`,
          { flag: "wx", mode: 0o600 },
        );
      } else if (artifact.artifactType === "draft") {
        const identity = artifactPackageIdentity(artifact);
        restorePackage(
          bytes,
          join(staging, "library", "drafts", identity.revisionHash, identity.skillName),
        );
      } else if (artifact.artifactType === "skill_set") {
        const artifactParts = artifact.artifactId.split("/");
        const setId =
          artifactParts.length >= 3 ? (artifactParts.at(-2) ?? "") : basename(artifact.artifactId);
        assertSafeRelativePath(`${setId}.json`);
        const path = join(staging, "skill-sets", `${setId}.json`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
        const revisionHash = artifact.revisionHash ?? artifact.objectHash;
        const historyPath = join(staging, "skill-set-history", setId, `${revisionHash}.json`);
        mkdirSync(dirname(historyPath), { recursive: true });
        if (!existsSync(historyPath)) writeFileSync(historyPath, bytes, { flag: "wx" });
      } else if (artifact.artifactType === "decision_history") {
        const path = artifact.artifactId.startsWith("decision-history/synthesis-candidates")
          ? join(staging, "synthesis", "remote-decisions.json")
          : join(staging, "memory", "decisions.md");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
      } else {
        const path = join(staging, "remote-library-snapshot.json");
        writeFileSync(path, bytes);
      }
    }
    if (existsSync(targetRoot)) rmSync(targetRoot, { recursive: true });
    renameSync(staging, targetRoot);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { targetRoot, restored: head.artifacts.length, snapshotId: head.snapshotId };
}

export async function diagnoseRemote(handle: RemoteLibraryHandle): Promise<RemoteDiagnostics> {
  return handle.diagnostics();
}
