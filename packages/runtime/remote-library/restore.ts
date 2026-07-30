import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { sha256 } from "@selftune/control-plane";
import type { RemoteLibraryHandle } from "@selftune/library/remote/transport";
import { openDb } from "@selftune/local-store";
import * as Schema from "effect/Schema";

import { mergeSkillIntelligenceLearnedState } from "../skill-intelligence/learned-state.js";
import { CLIError } from "../utils/cli-error.js";
import { computeSkillVersionHash } from "../utils/skill-discovery.js";
import { artifactPackageIdentity, assertSafeRelativePath } from "./package-identity.js";
import { restorePackage, UnknownRecord } from "./package-bundle.js";

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
    const learnedStates: unknown[] = [];
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
      } else if (artifact.artifactType === "learned_state") {
        const path = join(staging, "learned-state", `${artifact.objectHash}.json`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
        learnedStates.push(JSON.parse(new TextDecoder().decode(bytes)));
      } else {
        writeFileSync(join(staging, "remote-library-snapshot.json"), bytes);
      }
    }
    if (learnedStates.length > 0) {
      const restoredDb = openDb(join(staging, "selftune.db"));
      try {
        for (const learnedState of learnedStates) {
          mergeSkillIntelligenceLearnedState(restoredDb, learnedState);
        }
      } finally {
        restoredDb.close();
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
