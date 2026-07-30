import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import { Effect } from "effect";
import * as Schema from "effect/Schema";
import {
  SkillSourceUpdateFailure,
  type PreparedSkillSourceMergeAudit,
  type SkillSourceMergePreview,
  type SkillSourceMergeTargetPreview,
  type SkillSourceUpdateApplyStrategy,
  type SkillSourceUpdateLocation,
  type SkillSourceUpdatePreview,
  type SkillSourceUpdateReceipt,
} from "@selftune/source-management/contracts";

import {
  loadGitHubArchive,
  loadGitHubBlob,
  loadGitHubTree,
  resolveTrackedSkillSources,
  sourceFolderPath,
  sourceSubtreeHash,
  type SkillSourceMetadataOptions,
  type TrackedSkillSource,
} from "./metadata-adapter.js";
import {
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
  type InstalledSkillPackage,
} from "../utils/skill-discovery.js";
import {
  callViaAgent,
  isLlmBackedAgent,
  stripMarkdownFences,
  type LlmBackedAgent,
} from "../utils/llm-call.js";
import {
  comparePackageToTree,
  diffDirectories,
  directoryFingerprint,
  directorySnapshot,
  extractSkillPackage,
  isText,
  sameBytes,
  snapshotFingerprint,
  type FileTreeComparison,
} from "./package-tree.js";

const WritableSkillLock = Schema.Struct({
  version: Schema.Number,
  skills: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
});

export { SkillSourceUpdateFailure };
export type {
  PreparedSkillSourceMergeAudit,
  SkillSourceMergePreview,
  SkillSourceMergeTargetPreview,
  SkillSourceUpdateApplyStrategy,
  SkillSourceUpdateLocalState,
  SkillSourceUpdateLocation,
  SkillSourceUpdatePreview,
  SkillSourceUpdateReceipt,
  SkillSourceUpdateReceiptOperation,
  SkillSourceUpdateStrategy,
} from "@selftune/source-management/contracts";

export interface SkillSourceUpdateOptions extends SkillSourceMetadataOptions {
  searchDirs?: string[];
  configRoot?: string;
  archiveLoader?: (source: string, ref: string | null) => Promise<Buffer | null>;
  agentCaller?: (
    systemPrompt: string,
    userPrompt: string,
    agent: LlmBackedAgent,
    model?: string,
  ) => Promise<string>;
  githubBlobLoader?: (source: string, sha: string) => Promise<Buffer | null>;
}

interface CandidateInstall {
  installed: InstalledSkillPackage;
  tracked: TrackedSkillSource;
}

interface MergeMetadata extends SkillSourceMergePreview {
  schema_version: 1;
  targets: Array<
    SkillSourceMergeTargetPreview & {
      local_fingerprint: string;
      candidate_fingerprint: string;
      candidate_dir: string;
    }
  >;
}

const AgentMergeResponse = Schema.Struct({
  summary: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      content: Schema.NullOr(Schema.String),
      reason: Schema.String,
    }),
  ),
});

const MergeMetadataSchema = Schema.Struct({
  schema_version: Schema.Literal(1),
  merge_id: Schema.String,
  skill_name: Schema.String,
  source: Schema.String,
  installed_hash: Schema.String,
  latest_hash: Schema.String,
  agent: Schema.Literals(["claude", "codex", "opencode", "pi"]),
  model: Schema.NullOr(Schema.String),
  upstream_diff: Schema.String,
  created_at: Schema.String,
  targets: Schema.Array(
    Schema.Struct({
      target_path: Schema.String,
      observed_paths: Schema.Array(Schema.String),
      local_diff: Schema.NullOr(Schema.String),
      merged_diff: Schema.String,
      conflict_files: Schema.Array(Schema.String),
      summary: Schema.String,
      local_fingerprint: Schema.String,
      candidate_fingerprint: Schema.String,
      candidate_dir: Schema.String,
    }),
  ),
});

function failure(code: string, message: string): SkillSourceUpdateFailure {
  return SkillSourceUpdateFailure.make({ code, message });
}

function toFailure(error: unknown): SkillSourceUpdateFailure {
  return error instanceof SkillSourceUpdateFailure
    ? error
    : failure("UPDATE_FAILED", error instanceof Error ? error.message : "Skill update failed.");
}

function configRoot(options: SkillSourceUpdateOptions): string {
  const homeDir = resolve(options.homeDir ?? process.env.SELFTUNE_HOME ?? homedir());
  return resolve(options.configRoot ?? join(homeDir, ".selftune"));
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function archiveLoader(options: SkillSourceUpdateOptions) {
  return (
    options.archiveLoader ??
    ((source: string, ref: string | null) => loadGitHubArchive(source, ref, options))
  );
}

async function loadRevisionPackages(
  source: string,
  skillPath: string,
  installedHash: string,
  latestHash: string,
  latestRef: string | null,
  root: string,
  options: SkillSourceUpdateOptions,
): Promise<{ basePackage: string; upstreamPackage: string }> {
  const loader = archiveLoader(options);
  const [baseTree, latestTree, latestArchive] = await Promise.all([
    loadGitHubTree(source, installedHash, options),
    loadGitHubTree(source, latestHash, options),
    loader(source, latestRef),
  ]);
  if (!baseTree || !latestTree || !latestArchive) {
    throw failure(
      "SOURCE_UNAVAILABLE",
      "The recorded and latest upstream packages could not be downloaded.",
    );
  }
  const baseRoot = join(root, "base");
  const latestRoot = join(root, "latest");
  mkdirSync(baseRoot, { recursive: true });
  mkdirSync(latestRoot, { recursive: true });
  const basePackage = join(baseRoot, "package");
  mkdirSync(basePackage, { recursive: true });
  const blobEntries = baseTree.tree.filter((entry) => entry.type === "blob");
  const blobs = await Promise.all(
    blobEntries.map(async (entry) => ({
      entry,
      bytes: await (
        options.githubBlobLoader ?? ((repo, sha) => loadGitHubBlob(repo, sha, options))
      )(source, entry.sha),
    })),
  );
  for (const { entry, bytes } of blobs) {
    if (!bytes) {
      throw failure(
        "SOURCE_UNAVAILABLE",
        `The recorded upstream file could not be loaded: ${entry.path}`,
      );
    }
    const destination = resolve(basePackage, entry.path);
    if (!destination.startsWith(`${basePackage}/`)) {
      throw failure(
        "SOURCE_UNAVAILABLE",
        `The recorded upstream file has an unsafe path: ${entry.path}`,
      );
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  if (!existsSync(join(basePackage, "SKILL.md"))) {
    throw failure("SOURCE_UNAVAILABLE", "The recorded upstream package does not contain SKILL.md.");
  }
  const upstreamPackage = extractSkillPackage(latestArchive, skillPath, latestRoot);
  if (comparePackageToTree(upstreamPackage, latestTree).state !== "clean") {
    throw failure(
      "SOURCE_CHANGED",
      "The downloaded package did not match the previewed upstream revision. Preview again.",
    );
  }
  return { basePackage, upstreamPackage };
}

function sourceIdentity(candidate: CandidateInstall): string {
  const entry = candidate.tracked.entry;
  return JSON.stringify([
    entry.source,
    entry.ref ?? null,
    entry.skillPath ? sourceFolderPath(entry.skillPath) : null,
    entry.skillFolderHash ?? null,
  ]);
}

function findCandidates(skillName: string, options: SkillSourceUpdateOptions): CandidateInstall[] {
  const homeDir = options.homeDir ?? process.env.SELFTUNE_HOME ?? process.env.HOME ?? "";
  const installed = findInstalledSkillPackages(
    options.searchDirs ?? getDefaultSkillSearchDirs(process.cwd(), homeDir),
    homeDir,
  ).filter((skill) => skill.name.toLowerCase() === skillName.trim().toLowerCase());
  if (installed.length === 0) {
    throw failure("SKILL_NOT_FOUND", `No installed skill named ${skillName} was found.`);
  }
  const tracked = resolveTrackedSkillSources(installed, options);
  const candidates = installed.flatMap((skill) => {
    const source = tracked.get(skill.skill_path);
    return source ? [{ installed: skill, tracked: source }] : [];
  });
  if (candidates.length === 0) {
    throw failure("SOURCE_UNTRACKED", `${skillName} is not backed by a skills lockfile.`);
  }
  if (
    candidates.some(
      ({ tracked: { entry } }) =>
        entry.sourceType !== "github" || !entry.skillPath || !entry.skillFolderHash,
    )
  ) {
    throw failure(
      "SOURCE_UNSUPPORTED",
      "Only GitHub skills with a recorded folder revision can be updated.",
    );
  }
  if (new Set(candidates.map(sourceIdentity)).size !== 1) {
    throw failure(
      "SOURCE_AMBIGUOUS",
      "Installed locations point at different sources or revisions. Update them separately.",
    );
  }
  return candidates;
}

function canonicalTarget(packagePath: string): string {
  return lstatSync(packagePath).isSymbolicLink() ? realpathSync(packagePath) : resolve(packagePath);
}

async function previewUnsafe(
  skillName: string,
  options: SkillSourceUpdateOptions,
): Promise<SkillSourceUpdatePreview> {
  const candidates = findCandidates(skillName, options);
  const first = candidates[0];
  if (!first) throw failure("SKILL_NOT_FOUND", `No installed skill named ${skillName} was found.`);
  const entry = first.tracked.entry;
  const installedHash = entry.skillFolderHash;
  const skillPath = entry.skillPath;
  if (!installedHash || !skillPath) {
    throw failure("SOURCE_UNSUPPORTED", "The source lock does not contain a folder revision.");
  }
  const [latestTree, installedTree] = await Promise.all([
    loadGitHubTree(entry.source, entry.ref ?? null, options),
    loadGitHubTree(entry.source, installedHash, options),
  ]);
  const latestHash = latestTree ? sourceSubtreeHash(latestTree, skillPath) : null;
  if (!latestHash) {
    throw failure("SOURCE_UNAVAILABLE", "The latest upstream revision could not be loaded.");
  }

  const comparisons = new Map<string, FileTreeComparison>();
  let locations: SkillSourceUpdateLocation[] = candidates.map(({ installed }) => {
    const target = canonicalTarget(installed.package_path);
    let comparison = comparisons.get(target);
    if (!comparison) {
      comparison = comparePackageToTree(target, installedTree);
      comparisons.set(target, comparison);
    }
    return {
      package_path: installed.package_path,
      skill_path: installed.skill_path,
      scope: installed.skill_scope,
      project_root: installed.skill_project_root ?? null,
      canonical_target: target,
      local_state: comparison.state,
      reason: comparison.reason,
      local_diff: null,
    };
  });
  const conflicts = locations.filter((location) => location.local_state !== "clean").length;
  const status = installedHash === latestHash ? "current" : "available";
  let upstreamDiff: string | null = null;
  if (status === "available") {
    mkdirSync(configRoot(options), { recursive: true });
    const temporaryRoot = mkdtempSync(join(configRoot(options), "skill-update-preview-"));
    try {
      const revisions = await loadRevisionPackages(
        entry.source,
        skillPath,
        installedHash,
        latestHash,
        entry.ref ?? null,
        temporaryRoot,
        options,
      );
      upstreamDiff = diffDirectories(
        revisions.basePackage,
        revisions.upstreamPackage,
        temporaryRoot,
      );
      const diffs = new Map<string, string>();
      locations = locations.map((location) => {
        if (location.local_state === "unverifiable") return location;
        let localDiff = diffs.get(location.canonical_target);
        if (localDiff === undefined) {
          localDiff = diffDirectories(
            revisions.basePackage,
            location.canonical_target,
            temporaryRoot,
          );
          diffs.set(location.canonical_target, localDiff);
        }
        return { ...location, local_diff: localDiff || null };
      });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
  return {
    skill_name: first.installed.name,
    source: entry.source,
    source_url: entry.sourceUrl ?? null,
    installed_hash: installedHash,
    latest_hash: latestHash,
    status,
    locations,
    conflicts,
    can_apply: status === "available" && conflicts === 0,
    upstream_diff: upstreamDiff,
  };
}

function replaceFromStage(source: string, target: string): void {
  const stage = join(dirname(target), `.${basename(target)}.selftune-stage-${randomUUID()}`);
  const rollback = join(dirname(target), `.${basename(target)}.selftune-rollback-${randomUUID()}`);
  cpSync(source, stage, { recursive: true, errorOnExist: true, force: false });
  try {
    renameSync(target, rollback);
    try {
      renameSync(stage, target);
      rmSync(rollback, { recursive: true, force: true });
    } catch (error) {
      renameSync(rollback, target);
      throw error;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function updateLockFiles(
  candidates: CandidateInstall[],
  latestHash: string,
  updatedAt: string,
): void {
  const lockKeys = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const keys = lockKeys.get(candidate.tracked.lockPath) ?? new Set<string>();
    keys.add(candidate.tracked.lockKey);
    lockKeys.set(candidate.tracked.lockPath, keys);
  }
  for (const [lockPath, keys] of lockKeys) {
    let lock: typeof WritableSkillLock.Type;
    try {
      lock = Schema.decodeUnknownSync(WritableSkillLock)(
        JSON.parse(readFileSync(lockPath, "utf8")),
      );
    } catch {
      throw failure("LOCK_INVALID", `The source lock could not be read: ${lockPath}`);
    }
    const skills: Record<string, Record<string, unknown>> = { ...lock.skills };
    for (const key of keys) {
      const entry = skills[key];
      if (!entry) throw failure("LOCK_INVALID", `The source lock no longer contains ${key}.`);
      skills[key] = {
        ...entry,
        skillFolderHash: latestHash,
        updatedAt,
      };
    }
    atomicWriteJson(lockPath, { ...lock, skills });
  }
}

function groupedTargets(locations: SkillSourceUpdateLocation[]): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  for (const location of locations) {
    const paths = targets.get(location.canonical_target) ?? [];
    paths.push(location.package_path);
    targets.set(location.canonical_target, paths);
  }
  return targets;
}

function writeCandidateEntry(
  candidateRoot: string,
  path: string,
  content: Buffer | undefined,
): void {
  const destination = resolve(candidateRoot, path);
  if (destination !== candidateRoot && !destination.startsWith(`${candidateRoot}/`)) {
    throw failure("MERGE_INVALID", `The merge returned an unsafe path: ${path}`);
  }
  if (content === undefined) {
    rmSync(destination, { force: true });
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

async function prepareMergeUnsafe(
  skillName: string,
  agent: string,
  model: string | null,
  options: SkillSourceUpdateOptions,
): Promise<SkillSourceMergePreview> {
  if (!isLlmBackedAgent(agent)) {
    throw failure("AGENT_UNSUPPORTED", "Choose Claude Code, Codex, OpenCode, or Pi for the merge.");
  }
  const preview = await previewUnsafe(skillName, options);
  if (preview.status === "current") {
    throw failure("ALREADY_CURRENT", `${preview.skill_name} is already up to date.`);
  }
  if (preview.locations.some((location) => location.local_state === "unverifiable")) {
    throw failure(
      "MERGE_UNSAFE",
      "A local package could not be verified safely, so it cannot be merged.",
    );
  }
  const candidates = findCandidates(skillName, options);
  const first = candidates[0];
  const skillPath = first?.tracked.entry.skillPath;
  if (!first || !skillPath)
    throw failure("SOURCE_UNSUPPORTED", "The source package is incomplete.");

  const mergeId = randomUUID();
  const mergeRoot = join(configRoot(options), "skill-update-merges", mergeId);
  const workRoot = join(mergeRoot, "work");
  mkdirSync(workRoot, { recursive: true });
  try {
    const revisions = await loadRevisionPackages(
      preview.source,
      skillPath,
      preview.installed_hash,
      preview.latest_hash,
      first.tracked.entry.ref ?? null,
      workRoot,
      options,
    );
    const base = directorySnapshot(revisions.basePackage);
    const upstream = directorySnapshot(revisions.upstreamPackage);
    const targetPreviews: MergeMetadata["targets"] = [];
    let index = 0;
    for (const [targetPath, observedPaths] of groupedTargets(preview.locations)) {
      const local = directorySnapshot(targetPath);
      const candidateDir = join(mergeRoot, "candidates", String(index));
      cpSync(revisions.upstreamPackage, candidateDir, { recursive: true });
      const conflictFiles: string[] = [];
      const allPaths = new Set([...base.keys(), ...local.keys(), ...upstream.keys()]);
      for (const path of [...allPaths].toSorted()) {
        const baseBytes = base.get(path);
        const localBytes = local.get(path);
        const upstreamBytes = upstream.get(path);
        if (sameBytes(localBytes, baseBytes) || sameBytes(localBytes, upstreamBytes)) continue;
        if (sameBytes(upstreamBytes, baseBytes)) {
          writeCandidateEntry(candidateDir, path, localBytes);
          continue;
        }
        if (!isText(baseBytes) || !isText(localBytes) || !isText(upstreamBytes)) {
          throw failure(
            "BINARY_CONFLICT",
            `Both local and upstream changed binary file ${path}. Resolve it manually before merging.`,
          );
        }
        conflictFiles.push(path);
      }

      let summary = "Combined non-overlapping local and upstream changes.";
      if (conflictFiles.length > 0) {
        const systemPrompt = [
          "You are resolving a three-way merge for an Agent Skills package.",
          'Return JSON only, with this exact shape: {"summary":string,"files":[{"path":string,"content":string|null,"reason":string}]}',
          "Return exactly one entry for every requested conflict path and no other paths.",
          "Preserve compatible intent from both local and upstream. Do not add commentary or markdown fences.",
          "A null content value deletes the file. Never invent binary content.",
        ].join("\n");
        const userPrompt = JSON.stringify({
          skill: preview.skill_name,
          source: preview.source,
          conflicts: conflictFiles.map((path) => ({
            path,
            base: base.get(path)?.toString("utf8") ?? null,
            local: local.get(path)?.toString("utf8") ?? null,
            upstream: upstream.get(path)?.toString("utf8") ?? null,
          })),
        });
        // oxlint-disable-next-line no-await-in-loop -- each target produces an isolated staged candidate
        const raw = await (options.agentCaller ?? callViaAgent)(
          systemPrompt,
          userPrompt,
          agent,
          model?.trim() || undefined,
        );
        let decoded: typeof AgentMergeResponse.Type;
        try {
          decoded = Schema.decodeUnknownSync(AgentMergeResponse)(
            JSON.parse(stripMarkdownFences(raw)),
          );
        } catch {
          throw failure(
            "MERGE_RESPONSE_INVALID",
            "The agent did not return a valid merge response.",
          );
        }
        const returnedPaths = decoded.files.map((file) => file.path);
        if (
          new Set(returnedPaths).size !== returnedPaths.length ||
          returnedPaths.length !== conflictFiles.length ||
          conflictFiles.some((path) => !returnedPaths.includes(path))
        ) {
          throw failure(
            "MERGE_RESPONSE_INVALID",
            "The agent returned an incomplete or unexpected file set.",
          );
        }
        for (const file of decoded.files) {
          writeCandidateEntry(
            candidateDir,
            file.path,
            file.content === null ? undefined : Buffer.from(file.content, "utf8"),
          );
        }
        summary = decoded.summary.trim() || summary;
      }

      if (!existsSync(join(candidateDir, "SKILL.md"))) {
        throw failure("MERGE_INVALID", "The merged package does not contain SKILL.md.");
      }
      const candidateSnapshot = directorySnapshot(candidateDir);
      const localDiff = diffDirectories(revisions.basePackage, targetPath, workRoot) || null;
      const mergedDiff = diffDirectories(targetPath, candidateDir, workRoot);
      targetPreviews.push({
        target_path: targetPath,
        observed_paths: observedPaths,
        local_diff: localDiff,
        merged_diff: mergedDiff,
        conflict_files: conflictFiles,
        summary,
        local_fingerprint: snapshotFingerprint(local),
        candidate_fingerprint: snapshotFingerprint(candidateSnapshot),
        candidate_dir: relative(mergeRoot, candidateDir),
      });
      index += 1;
    }

    const metadata: MergeMetadata = {
      schema_version: 1,
      merge_id: mergeId,
      skill_name: preview.skill_name,
      source: preview.source,
      installed_hash: preview.installed_hash,
      latest_hash: preview.latest_hash,
      agent,
      model: model?.trim() || null,
      upstream_diff: preview.upstream_diff ?? "",
      targets: targetPreviews,
      created_at: new Date(options.now ?? Date.now()).toISOString(),
    };
    atomicWriteJson(join(mergeRoot, "metadata.json"), metadata);
    rmSync(workRoot, { recursive: true, force: true });
    return metadata;
  } catch (error) {
    rmSync(mergeRoot, { recursive: true, force: true });
    throw error;
  }
}

function readMergeMetadata(mergeId: string, options: SkillSourceUpdateOptions): MergeMetadata {
  if (!/^[0-9a-f-]{36}$/i.test(mergeId)) {
    throw failure("MERGE_NOT_FOUND", "The prepared merge could not be found.");
  }
  try {
    return Schema.decodeUnknownSync(MergeMetadataSchema)(
      JSON.parse(
        readFileSync(
          join(configRoot(options), "skill-update-merges", mergeId, "metadata.json"),
          "utf8",
        ),
      ),
    ) as MergeMetadata;
  } catch {
    throw failure("MERGE_NOT_FOUND", "The prepared merge could not be read. Prepare it again.");
  }
}

export function inspectPreparedSkillSourceMerge(
  mergeId: string,
  options: SkillSourceUpdateOptions = {},
): PreparedSkillSourceMergeAudit {
  const metadata = readMergeMetadata(mergeId, options);
  return {
    merge_id: metadata.merge_id,
    skill_name: metadata.skill_name,
    source: metadata.source,
    installed_hash: metadata.installed_hash,
    latest_hash: metadata.latest_hash,
    agent: metadata.agent,
    model: metadata.model,
    upstream_diff: metadata.upstream_diff,
    created_at: metadata.created_at,
    targets: metadata.targets.map(({ candidate_dir: _candidateDir, ...target }) => target),
  };
}

async function applyPreparedMergeUnsafe(
  mergeId: string,
  options: SkillSourceUpdateOptions,
): Promise<SkillSourceUpdateReceipt> {
  const metadata = readMergeMetadata(mergeId, options);
  const preview = await previewUnsafe(metadata.skill_name, options);
  if (
    preview.source !== metadata.source ||
    preview.installed_hash !== metadata.installed_hash ||
    preview.latest_hash !== metadata.latest_hash
  ) {
    throw failure(
      "MERGE_STALE",
      "The source changed after this merge was prepared. Prepare it again.",
    );
  }
  const currentTargets = groupedTargets(preview.locations);
  if (
    metadata.targets.length !== currentTargets.size ||
    metadata.targets.some((target) => !currentTargets.has(target.target_path))
  ) {
    throw failure("MERGE_STALE", "The installed skill locations changed. Prepare the merge again.");
  }
  const mergeRoot = join(configRoot(options), "skill-update-merges", mergeId);
  for (const target of metadata.targets) {
    if (directoryFingerprint(target.target_path) !== target.local_fingerprint) {
      throw failure("MERGE_STALE", `Local files changed after review: ${target.target_path}`);
    }
    const candidateDir = resolve(mergeRoot, target.candidate_dir);
    if (!candidateDir.startsWith(`${mergeRoot}/`) || !existsSync(join(candidateDir, "SKILL.md"))) {
      throw failure("MERGE_INVALID", "The staged merge candidate is invalid.");
    }
    if (directoryFingerprint(candidateDir) !== target.candidate_fingerprint) {
      throw failure("MERGE_INVALID", "The staged merge candidate changed after review.");
    }
  }

  const candidates = findCandidates(metadata.skill_name, options);
  const receiptId = randomUUID();
  const receiptRoot = join(configRoot(options), "skill-update-receipts", receiptId);
  const receiptPath = join(receiptRoot, "receipt.json");
  const operations = metadata.targets.map((target, index) => ({
    target_path: target.target_path,
    observed_paths: target.observed_paths,
    backup_path: join(receiptRoot, "backups", `${index}-${basename(target.target_path)}`),
  }));
  const receipt: SkillSourceUpdateReceipt = {
    schema_version: 1,
    receipt_id: receiptId,
    skill_name: metadata.skill_name,
    source: metadata.source,
    previous_hash: metadata.installed_hash,
    installed_hash: metadata.latest_hash,
    status: "applying",
    strategy: "agent_merge",
    operations,
    applied_at: new Date(options.now ?? Date.now()).toISOString(),
  };
  const originalLocks = new Map<string, string>();
  try {
    for (const candidate of candidates) {
      if (!originalLocks.has(candidate.tracked.lockPath)) {
        originalLocks.set(
          candidate.tracked.lockPath,
          readFileSync(candidate.tracked.lockPath, "utf8"),
        );
      }
    }
    for (const operation of operations) {
      mkdirSync(dirname(operation.backup_path), { recursive: true });
      cpSync(operation.target_path, operation.backup_path, { recursive: true });
    }
    atomicWriteJson(receiptPath, receipt);
    for (const target of metadata.targets) {
      replaceFromStage(resolve(mergeRoot, target.candidate_dir), target.target_path);
    }
    updateLockFiles(candidates, metadata.latest_hash, receipt.applied_at);
    rmSync(options.updateCachePath ?? join(configRoot(options), "cache", "skill-updates-v1.json"), {
      force: true,
    });
    const applied = { ...receipt, status: "applied" as const };
    atomicWriteJson(receiptPath, applied);
    return applied;
  } catch (error) {
    for (const operation of operations) {
      if (!existsSync(operation.backup_path)) continue;
      rmSync(operation.target_path, { recursive: true, force: true });
      cpSync(operation.backup_path, operation.target_path, { recursive: true });
    }
    for (const [lockPath, contents] of originalLocks) writeFileSync(lockPath, contents);
    if (existsSync(receiptPath)) atomicWriteJson(receiptPath, { ...receipt, status: "failed" });
    throw error;
  }
}

async function applyUnsafe(
  skillName: string,
  strategy: SkillSourceUpdateApplyStrategy,
  options: SkillSourceUpdateOptions,
): Promise<SkillSourceUpdateReceipt> {
  const preview = await previewUnsafe(skillName, options);
  if (preview.status === "current") {
    throw failure("ALREADY_CURRENT", `${preview.skill_name} is already up to date.`);
  }
  if (preview.conflicts > 0 && strategy === "abort") {
    throw failure(
      "LOCAL_CHANGES",
      "Local changes were detected. Keep the local version or explicitly replace it with upstream.",
    );
  }
  const candidates = findCandidates(skillName, options);
  const first = candidates[0];
  const skillPath = first?.tracked.entry.skillPath;
  if (!first || !skillPath)
    throw failure("SOURCE_UNSUPPORTED", "The source package is incomplete.");
  const archive = await archiveLoader(options)(
    first.tracked.entry.source,
    first.tracked.entry.ref ?? null,
  );
  if (!archive)
    throw failure("SOURCE_UNAVAILABLE", "The upstream archive could not be downloaded.");

  mkdirSync(configRoot(options), { recursive: true });
  const temporaryRoot = mkdtempSync(join(configRoot(options), "skill-update-stage-"));
  const receiptId = randomUUID();
  const receiptRoot = join(configRoot(options), "skill-update-receipts", receiptId);
  const receiptPath = join(receiptRoot, "receipt.json");
  const originalLocks = new Map<string, string>();
  const targets = groupedTargets(preview.locations);
  const operations = [...targets.entries()].map(([target, observedPaths], index) => ({
    target_path: target,
    observed_paths: observedPaths,
    backup_path: join(receiptRoot, "backups", `${index}-${basename(target)}`),
  }));
  const receipt: SkillSourceUpdateReceipt = {
    schema_version: 1,
    receipt_id: receiptId,
    skill_name: preview.skill_name,
    source: preview.source,
    previous_hash: preview.installed_hash,
    installed_hash: preview.latest_hash,
    status: "applying",
    strategy,
    operations,
    applied_at: new Date(options.now ?? Date.now()).toISOString(),
  };

  try {
    mkdirSync(receiptRoot, { recursive: true });
    const upstreamPackage = extractSkillPackage(archive, skillPath, temporaryRoot);
    const latestTree = await loadGitHubTree(
      first.tracked.entry.source,
      preview.latest_hash,
      options,
    );
    const stagedComparison = comparePackageToTree(upstreamPackage, latestTree);
    if (stagedComparison.state !== "clean") {
      throw failure(
        "SOURCE_CHANGED",
        "The downloaded package did not match the previewed upstream revision. Preview again.",
      );
    }
    for (const candidate of candidates) {
      const lockPath = candidate.tracked.lockPath;
      if (!originalLocks.has(lockPath)) originalLocks.set(lockPath, readFileSync(lockPath, "utf8"));
    }
    for (const operation of operations) {
      mkdirSync(dirname(operation.backup_path), { recursive: true });
      cpSync(operation.target_path, operation.backup_path, { recursive: true });
    }
    atomicWriteJson(receiptPath, receipt);
    for (const operation of operations) {
      replaceFromStage(upstreamPackage, operation.target_path);
    }
    updateLockFiles(candidates, preview.latest_hash, receipt.applied_at);
    rmSync(options.updateCachePath ?? join(configRoot(options), "cache", "skill-updates-v1.json"), {
      force: true,
    });
    const appliedReceipt = { ...receipt, status: "applied" as const };
    atomicWriteJson(receiptPath, appliedReceipt);
    return appliedReceipt;
  } catch (error) {
    for (const operation of operations) {
      if (!existsSync(operation.backup_path)) continue;
      rmSync(operation.target_path, { recursive: true, force: true });
      cpSync(operation.backup_path, operation.target_path, { recursive: true });
    }
    for (const [lockPath, contents] of originalLocks) writeFileSync(lockPath, contents);
    if (existsSync(receiptPath)) atomicWriteJson(receiptPath, { ...receipt, status: "failed" });
    throw error;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export const previewSkillSourceUpdateEffect = Effect.fn("SkillSourceUpdate.preview")(function* (
  skillName: string,
  options: SkillSourceUpdateOptions = {},
) {
  return yield* Effect.tryPromise({
    try: () => previewUnsafe(skillName, options),
    catch: toFailure,
  });
});

export const applySkillSourceUpdateEffect = Effect.fn("SkillSourceUpdate.apply")(function* (
  skillName: string,
  strategy: SkillSourceUpdateApplyStrategy,
  options: SkillSourceUpdateOptions = {},
) {
  return yield* Effect.tryPromise({
    try: () => applyUnsafe(skillName, strategy, options),
    catch: toFailure,
  });
});

export const prepareSkillSourceMergeEffect = Effect.fn("SkillSourceUpdate.prepareMerge")(function* (
  skillName: string,
  agent: string,
  model: string | null = null,
  options: SkillSourceUpdateOptions = {},
) {
  return yield* Effect.tryPromise({
    try: () => prepareMergeUnsafe(skillName, agent, model, options),
    catch: toFailure,
  });
});

export const applyPreparedSkillSourceMergeEffect = Effect.fn("SkillSourceUpdate.applyMerge")(
  function* (mergeId: string, options: SkillSourceUpdateOptions = {}) {
    return yield* Effect.tryPromise({
      try: () => applyPreparedMergeUnsafe(mergeId, options),
      catch: toFailure,
    });
  },
);

export function previewSkillSourceUpdate(
  skillName: string,
  options: SkillSourceUpdateOptions = {},
): Promise<SkillSourceUpdatePreview> {
  return Effect.runPromise(previewSkillSourceUpdateEffect(skillName, options));
}

export function applySkillSourceUpdate(
  skillName: string,
  strategy: SkillSourceUpdateApplyStrategy,
  options: SkillSourceUpdateOptions = {},
): Promise<SkillSourceUpdateReceipt> {
  return Effect.runPromise(applySkillSourceUpdateEffect(skillName, strategy, options));
}

export function prepareSkillSourceMerge(
  skillName: string,
  agent: string,
  model: string | null = null,
  options: SkillSourceUpdateOptions = {},
): Promise<SkillSourceMergePreview> {
  return Effect.runPromise(prepareSkillSourceMergeEffect(skillName, agent, model, options));
}

export function applyPreparedSkillSourceMerge(
  mergeId: string,
  options: SkillSourceUpdateOptions = {},
): Promise<SkillSourceUpdateReceipt> {
  return Effect.runPromise(applyPreparedSkillSourceMergeEffect(mergeId, options));
}
