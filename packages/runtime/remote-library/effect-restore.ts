import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  type RemoteArtifact,
  type RemoteIntegrityFailure,
  RemoteLibrary,
  type RemoteLibraryUnavailable,
  type RemoteObjectMissing,
  type RemoteSnapshot,
  sha256,
} from "@selftune/control-plane";
import { openDb } from "@selftune/local-store";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  mergeSkillIntelligenceLearnedState,
  SkillIntelligenceLearnedState,
} from "../skill-intelligence/learned-state.js";
import { CLIError } from "../utils/cli-error.js";
import { computeSkillVersionHash } from "../utils/skill-discovery.js";
import { artifactPackageIdentity, assertSafeRelativePath } from "./package-identity.js";
import { restorePackage, UnknownRecord } from "./package-bundle.js";

export interface RestoreRemoteLibraryResult {
  readonly targetRoot: string;
  readonly restored: number;
  readonly snapshotId: string | null;
}

export type RestoreRemoteLibraryError =
  | CLIError
  | RemoteIntegrityFailure
  | RemoteLibraryUnavailable
  | RemoteObjectMissing;

interface RestoreArtifactOptions {
  readonly artifact: RemoteArtifact;
  readonly bytes: Uint8Array;
  readonly staging: string;
  readonly targetRoot: string;
  readonly snapshotCreatedAt: string;
}

interface RestoredArtifact {
  readonly learnedState?: SkillIntelligenceLearnedState;
}

function localFailure(cause: unknown): CLIError {
  if (cause instanceof CLIError) return cause;
  return new CLIError(cause instanceof Error ? cause.message : String(cause), "OPERATION_FAILED");
}

function localEffect<A>(operation: () => A): Effect.Effect<A, CLIError> {
  return Effect.try({ try: operation, catch: localFailure });
}

function verifyObject(bytes: Uint8Array, expectedHash: string): Effect.Effect<void, CLIError> {
  return localEffect(() => {
    if (sha256(bytes) !== expectedHash) {
      throw new CLIError(`Remote object failed verification: ${expectedHash}`, "OPERATION_FAILED");
    }
  });
}

function restoreReleasedSkill(options: RestoreArtifactOptions): void {
  const { artifact, bytes, staging, targetRoot, snapshotCreatedAt } = options;
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
  if (!authority) return;

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
        released_at: snapshotCreatedAt,
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

function restoreDraft(options: RestoreArtifactOptions): void {
  const identity = artifactPackageIdentity(options.artifact);
  restorePackage(
    options.bytes,
    join(options.staging, "library", "drafts", identity.revisionHash, identity.skillName),
  );
}

function restoreSkillSet(options: RestoreArtifactOptions): void {
  const { artifact, bytes, staging } = options;
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
}

function restoreDecisionHistory(options: RestoreArtifactOptions): void {
  const path = options.artifact.artifactId.startsWith("decision-history/synthesis-candidates")
    ? join(options.staging, "synthesis", "remote-decisions.json")
    : join(options.staging, "memory", "decisions.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, options.bytes);
}

function restoreLearnedState(options: RestoreArtifactOptions): SkillIntelligenceLearnedState {
  const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(SkillIntelligenceLearnedState))(
    new TextDecoder().decode(options.bytes),
  );
  const path = join(options.staging, "learned-state", `${options.artifact.objectHash}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, options.bytes);
  return parsed;
}

function restoreArtifactLocal(options: RestoreArtifactOptions): RestoredArtifact {
  switch (options.artifact.artifactType) {
    case "skill_revision":
    case "released_skill":
      restoreReleasedSkill(options);
      return {};
    case "draft":
      restoreDraft(options);
      return {};
    case "skill_set":
      restoreSkillSet(options);
      return {};
    case "decision_history":
      restoreDecisionHistory(options);
      return {};
    case "learned_state":
      return { learnedState: restoreLearnedState(options) };
    case "metadata":
      writeFileSync(join(options.staging, "remote-library-snapshot.json"), options.bytes);
      return {};
  }
}

const restoreArtifact = Effect.fn("selftune.runtime.remoteLibrary.restoreArtifact")(function* (
  options: RestoreArtifactOptions,
) {
  yield* verifyObject(options.bytes, options.artifact.objectHash);
  return yield* localEffect(() => restoreArtifactLocal(options));
});

const mergeLearnedStates = Effect.fn("selftune.runtime.remoteLibrary.mergeLearnedStates")(
  function* (staging: string, learnedStates: ReadonlyArray<SkillIntelligenceLearnedState>) {
    if (learnedStates.length === 0) return;

    yield* Effect.acquireUseRelease(
      localEffect(() => openDb(join(staging, "selftune.db"))),
      (restoredDb) =>
        localEffect(() => {
          for (const learnedState of learnedStates) {
            mergeSkillIntelligenceLearnedState(restoredDb, learnedState);
          }
        }),
      (restoredDb) => localEffect(() => restoredDb.close()),
    );
  },
);

function acquireStaging(targetRoot: string): Effect.Effect<string, CLIError> {
  const staging = `${targetRoot}.restoring-${process.pid}`;
  return localEffect(() => {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    return staging;
  });
}

function releaseStaging(staging: string): Effect.Effect<void, CLIError> {
  return localEffect(() => rmSync(staging, { recursive: true, force: true }));
}

const restoreSnapshot = Effect.fn("selftune.runtime.remoteLibrary.restoreSnapshot")(function* (
  targetRoot: string,
  snapshot: RemoteSnapshot,
) {
  const remote = yield* RemoteLibrary;
  yield* Effect.acquireUseRelease(
    acquireStaging(targetRoot),
    (staging) =>
      Effect.gen(function* () {
        const learnedStates: SkillIntelligenceLearnedState[] = [];
        const artifacts = [...snapshot.artifacts].toSorted((left, right) =>
          left.updatedAt.localeCompare(right.updatedAt),
        );
        for (const artifact of artifacts) {
          const bytes = yield* remote.getObject(artifact.objectHash);
          const restored = yield* restoreArtifact({
            artifact,
            bytes,
            staging,
            targetRoot,
            snapshotCreatedAt: snapshot.createdAt,
          });
          if (restored.learnedState !== undefined) learnedStates.push(restored.learnedState);
        }
        yield* mergeLearnedStates(staging, learnedStates);
        yield* localEffect(() => {
          if (existsSync(targetRoot)) rmSync(targetRoot, { recursive: true });
          renameSync(staging, targetRoot);
        });
      }),
    releaseStaging,
  );
});

export const restoreRemoteLibraryEffect = Effect.fn("selftune.runtime.remoteLibrary.restore")(
  function* (options: { readonly targetRoot: string }) {
    const targetRoot = resolve(options.targetRoot);
    yield* localEffect(() => {
      if (existsSync(targetRoot) && readdirSync(targetRoot).length > 0) {
        throw new CLIError("Restore target must be empty.", "GUARD_BLOCKED");
      }
    });

    const remote = yield* RemoteLibrary;
    const head = yield* remote.head;
    if (!head) return { targetRoot, restored: 0, snapshotId: null };

    yield* restoreSnapshot(targetRoot, head);
    return {
      targetRoot,
      restored: head.artifacts.length,
      snapshotId: head.snapshotId,
    };
  },
);
