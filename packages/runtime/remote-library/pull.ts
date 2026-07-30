import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Database } from "bun:sqlite";

import {
  sha256,
  type RemoteArtifact,
  type RemoteSnapshot,
  type SyncPreferences,
} from "@selftune/control-plane";
import { importPortableSkillSet, type SkillSetSkillReference } from "@selftune/library";
import type { RemoteLibraryHandle } from "@selftune/library/remote/transport";
import * as Schema from "effect/Schema";

import { mergeSkillIntelligenceLearnedState } from "../skill-intelligence/learned-state.js";
import { CLIError } from "../utils/cli-error.js";
import { computeSkillVersionHash } from "../utils/skill-discovery.js";
import { fromRemote } from "./errors.js";
import { artifactPackageIdentity, assertSafeRelativePath } from "./package-identity.js";
import { restorePackage, UnknownRecord } from "./package-bundle.js";

export async function pullRemoteLibraryState(options: {
  handle: RemoteLibraryHandle;
  configRoot: string;
  snapshot: RemoteSnapshot;
  preferences: SyncPreferences;
  db?: Database;
}): Promise<void> {
  await pullRemoteSkillPackages({
    handle: options.handle,
    configRoot: options.configRoot,
    snapshot: options.snapshot,
  });
  if (options.preferences.skillSets) {
    await pullRemoteSkillSetManifests({
      handle: options.handle,
      configRoot: options.configRoot,
      snapshot: options.snapshot,
    });
  }
  if (!options.preferences.decisionHistory || !options.db) return;
  for (const artifact of options.snapshot.artifacts
    .filter((candidate) => candidate.artifactType === "learned_state")
    .toSorted((left, right) => left.updatedAt.localeCompare(right.updatedAt))) {
    const bytes = await options.handle.getObject(artifact.objectHash);
    if (sha256(bytes) !== artifact.objectHash) {
      throw new CLIError(
        `Remote learned state ${artifact.artifactId} failed object verification.`,
        "GUARD_BLOCKED",
      );
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    mergeSkillIntelligenceLearnedState(options.db, parsed);
  }
}

async function pullRemoteSkillPackages(options: {
  handle: RemoteLibraryHandle;
  configRoot: string;
  snapshot: RemoteSnapshot;
}): Promise<number> {
  let downloaded = 0;
  for (const artifact of options.snapshot.artifacts) {
    if (
      artifact.artifactType !== "skill_revision" ||
      !artifact.artifactId.startsWith("backup-skill/") ||
      !artifact.revisionHash
    )
      continue;
    const identity = artifactPackageIdentity(artifact);
    const destination = join(
      options.configRoot,
      "library",
      "packages",
      artifact.revisionHash,
      identity.skillName,
    );
    if (existsSync(destination)) continue;
    const bytes = await fromRemote(`downloading "${identity.skillName}"`, () =>
      options.handle.getObject(artifact.objectHash),
    );
    if (sha256(bytes) !== artifact.objectHash) {
      throw new CLIError(
        `Downloaded revision for "${identity.skillName}" failed object verification.`,
        "OPERATION_FAILED",
        "Do not install this skill until the remote copy has been repaired.",
      );
    }
    const staging = join(options.configRoot, "library", `.skill-download-${randomUUID()}`);
    try {
      restorePackage(bytes, staging);
      if (computeSkillVersionHash(join(staging, "SKILL.md")) !== artifact.revisionHash) {
        throw new CLIError(
          `Downloaded revision for "${identity.skillName}" failed package verification.`,
          "OPERATION_FAILED",
          "Back up the skill again from a trusted machine before retrying.",
        );
      }
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      renameSync(staging, destination);
      downloaded += 1;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return downloaded;
}

async function pullRemoteSkillSetManifests(options: {
  handle: RemoteLibraryHandle;
  configRoot: string;
  snapshot: RemoteSnapshot;
}): Promise<number> {
  const newestBySet = new Map<string, RemoteArtifact>();
  for (const artifact of [...options.snapshot.artifacts]
    .filter((candidate) => candidate.artifactType === "skill_set")
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    const parts = artifact.artifactId.split("/");
    const setId = parts.length >= 3 ? (parts.at(-2) ?? "") : "";
    assertSafeRelativePath(`${setId}.json`);
    if (!newestBySet.has(setId)) newestBySet.set(setId, artifact);
  }

  const results = await Promise.allSettled(
    [...newestBySet].map(([setId, artifact]) =>
      pullRemoteSkillSetManifest({
        handle: options.handle,
        configRoot: options.configRoot,
        setId,
        artifact,
      }),
    ),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results
    .filter((result): result is PromiseFulfilledResult<boolean> => result.status === "fulfilled")
    .filter((result) => result.value).length;
}

async function pullRemoteSkillSetManifest(options: {
  handle: RemoteLibraryHandle;
  configRoot: string;
  setId: string;
  artifact: RemoteArtifact;
}): Promise<boolean> {
  const localPath = join(options.configRoot, "skill-sets", `${options.setId}.json`);
  if (existsSync(localPath)) return false;
  const bytes = await fromRemote(`downloading Skill Set "${options.setId}"`, () =>
    options.handle.getObject(options.artifact.objectHash),
  );
  if (sha256(bytes) !== options.artifact.objectHash) {
    throw new CLIError(
      `Downloaded Skill Set "${options.setId}" failed object verification.`,
      "OPERATION_FAILED",
      "Do not use this Skill Set until the remote copy has been repaired.",
    );
  }
  let decoded: typeof UnknownRecord.Type;
  try {
    decoded = Schema.decodeUnknownSync(UnknownRecord)(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new CLIError(
      `Downloaded Skill Set "${options.setId}" has an invalid manifest.`,
      "OPERATION_FAILED",
      "Do not use this Skill Set until the remote snapshot has been repaired.",
    );
  }
  if (decoded.set_id !== options.setId || decoded.revision_hash !== options.artifact.revisionHash) {
    throw new CLIError(
      `Downloaded Skill Set "${options.setId}" does not match its remote identity.`,
      "OPERATION_FAILED",
      "Do not use this Skill Set until the remote snapshot has been repaired.",
    );
  }
  mkdirSync(options.configRoot, { recursive: true, mode: 0o700 });
  const temporaryPath = join(options.configRoot, `.remote-skill-set-${randomUUID()}.json`);
  try {
    writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    const manifest = importPortableSkillSet(temporaryPath, {
      configRoot: options.configRoot,
      allowMissingDependencies: true,
      preserveExisting: true,
    });
    return (
      manifest.set_id === options.setId && manifest.revision_hash === options.artifact.revisionHash
    );
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export async function materializeSkillSetDependencies(options: {
  handle: RemoteLibraryHandle;
  configRoot: string;
  dependencies: SkillSetSkillReference[];
}): Promise<{ downloaded: number }> {
  if (options.dependencies.length === 0) return { downloaded: 0 };
  const head = await fromRemote("reading the remote Skill Set", () => options.handle.head());
  if (!head) {
    throw new CLIError(
      "Sync & Backup does not contain any Skill Set revisions yet.",
      "FILE_NOT_FOUND",
      "Sync the Skill Set from a machine that has all of its pinned skills.",
    );
  }

  const stagingRoot = join(
    resolve(options.configRoot),
    "library",
    `.skill-set-download-${randomUUID()}`,
  );
  const staged: Array<{ source: string; destination: string }> = [];
  const committed: string[] = [];
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  try {
    const downloads = await Promise.allSettled(
      options.dependencies.map((dependency) =>
        stageSkillSetDependency({
          handle: options.handle,
          head,
          stagingRoot,
          dependency,
        }),
      ),
    );
    const failedDownload = downloads.find((result) => result.status === "rejected");
    if (failedDownload?.status === "rejected") throw failedDownload.reason;
    staged.push(
      ...downloads.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    );

    for (const entry of staged) {
      if (existsSync(entry.destination)) {
        const existingHash = computeSkillVersionHash(join(entry.destination, "SKILL.md"));
        if (existingHash !== basename(dirname(entry.destination))) {
          throw new CLIError(
            `A different Library package appeared while downloading ${basename(entry.destination)}.`,
            "GUARD_BLOCKED",
            "Review the local Library and retry the Skill Set apply.",
          );
        }
        continue;
      }
      mkdirSync(dirname(entry.destination), { recursive: true });
      renameSync(entry.source, entry.destination);
      committed.push(entry.destination);
    }
  } catch (cause) {
    for (const destination of committed.toReversed()) {
      rmSync(destination, { recursive: true, force: true });
    }
    throw cause;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
  return { downloaded: staged.length };
}

async function stageSkillSetDependency(options: {
  handle: RemoteLibraryHandle;
  head: RemoteSnapshot;
  stagingRoot: string;
  dependency: SkillSetSkillReference;
}): Promise<{ source: string; destination: string }> {
  const artifact = options.head.artifacts.find((candidate) => {
    if (
      candidate.artifactType !== "skill_revision" &&
      candidate.artifactType !== "released_skill"
    ) {
      return false;
    }
    if (candidate.revisionHash !== options.dependency.content_hash) return false;
    return artifactPackageIdentity(candidate).skillName === options.dependency.name;
  });
  if (!artifact) {
    throw new CLIError(
      `Pinned revision for "${options.dependency.name}" is not available from Sync & Backup.`,
      "FILE_NOT_FOUND",
      "Sync the Skill Set again from a machine that still has this revision.",
    );
  }
  const bytes = await fromRemote(`downloading "${options.dependency.name}"`, () =>
    options.handle.getObject(artifact.objectHash),
  );
  if (sha256(bytes) !== artifact.objectHash) {
    throw new CLIError(
      `Downloaded revision for "${options.dependency.name}" failed object verification.`,
      "OPERATION_FAILED",
      "Do not apply this Skill Set until the remote copy has been repaired.",
    );
  }
  const stagedPath = join(
    options.stagingRoot,
    options.dependency.content_hash,
    options.dependency.name,
  );
  restorePackage(bytes, stagedPath);
  if (computeSkillVersionHash(join(stagedPath, "SKILL.md")) !== options.dependency.content_hash) {
    throw new CLIError(
      `Downloaded revision for "${options.dependency.name}" failed package verification.`,
      "OPERATION_FAILED",
      "Sync the Skill Set again from a trusted machine before retrying.",
    );
  }
  return { source: stagedPath, destination: options.dependency.library_package_path };
}
