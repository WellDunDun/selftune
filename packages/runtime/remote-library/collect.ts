import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  RemoteArtifact,
  sha256,
  type LibrarySnapshot,
  type SyncPreferences,
} from "@selftune/control-plane";
import { listSkillSets } from "@selftune/library";
import type { RemoteSyncObject } from "@selftune/library/remote/sync";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { sanitizeConservative } from "../contribute/sanitize.js";
import {
  loadLibraryCatalog,
  loadLibraryCatalogEffect,
  type LibraryCatalogOptions,
} from "../library/catalog.js";
import { exportSkillIntelligenceLearnedState } from "../skill-intelligence/learned-state.js";
import { listSynthesisReleases, loadCandidateSnapshot } from "../synthesis.js";
import { CLIError } from "../utils/cli-error.js";
import { encodePackageBundle, ReleaseAuthority } from "./package-bundle.js";

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export interface CollectLocalObjectsOptions {
  configRoot: string;
  preferences: SyncPreferences;
  selectedSkillIds?: ReadonlyArray<string>;
  catalogOptions?: LibraryCatalogOptions;
  db?: Database;
}

function collectLocalObjectsFromSnapshot(
  options: CollectLocalObjectsOptions,
  snapshot: LibrarySnapshot,
): RemoteSyncObject[] {
  const objects: RemoteSyncObject[] = [];
  const skillRevisions = new Map<string, RemoteSyncObject>();

  const addSkillRevision = (input: {
    name: string;
    packagePath: string;
    revisionHash: string;
    updatedAt: string;
    releaseAuthority?: typeof ReleaseAuthority.Type;
    artifactPrefix?: "skill" | "backup-skill";
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
          "Create and evaluate a new release before enabling Sync & Backup.",
        );
      }
    }
    skillRevisions.set(identity, {
      bytes,
      artifact: RemoteArtifact.make({
        artifactId: `${input.artifactPrefix ?? "skill"}/${input.name}/${input.revisionHash}`,
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
      if (location.sourceKind !== "draft" || !options.preferences.drafts) continue;
      const bytes = encodePackageBundle(location.packagePath, true);
      objects.push({
        bytes,
        artifact: RemoteArtifact.make({
          artifactId: `draft/${skill.name}/${revisionHash}`,
          artifactType: "draft",
          objectHash: sha256(bytes),
          revisionHash,
          updatedAt: location.modifiedAt,
        }),
      });
    }
  }

  for (const skill of snapshot.skills) {
    if (!options.selectedSkillIds?.includes(skill.skillId)) continue;
    const activeLocations = [...skill.locations]
      .filter((candidate) => candidate.active)
      .toSorted((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    if (activeLocations.length === 0) {
      throw new CLIError(
        `Skill "${skill.name}" does not have an active local package to back up.`,
        "FILE_NOT_FOUND",
        "Choose a skill with an active local installation and retry.",
      );
    }
    const selection = activeLocations.flatMap((location) => {
      const revisionHash = skill.revisions.find((revision) =>
        revision.locations.some(
          (revisionLocation) => revisionLocation.packagePath === location.packagePath,
        ),
      )?.contentHash;
      return revisionHash ? [{ location, revisionHash }] : [];
    })[0];
    if (!selection) {
      throw new CLIError(
        `Skill "${skill.name}" does not have a verifiable local revision.`,
        "GUARD_BLOCKED",
        "Repair the skill package and retry the backup.",
      );
    }
    addSkillRevision({
      name: skill.name,
      packagePath: selection.location.packagePath,
      revisionHash: selection.revisionHash,
      updatedAt: selection.location.modifiedAt,
      artifactPrefix: "backup-skill",
    });
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
        source_kinds: [
          ...new Set(skill.locations.map((location) => location.sourceKind)),
        ].toSorted(),
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

  if (options.preferences.decisionHistory && options.db) {
    const learnedState = exportSkillIntelligenceLearnedState(options.db);
    const learnedRecords =
      learnedState.overrides.length +
      learnedState.corrections.length +
      learnedState.snapshots.length +
      learnedState.reviews.length +
      learnedState.outcomes.length;
    if (learnedRecords > 0) {
      const bytes = jsonBytes(learnedState);
      objects.push({
        bytes,
        artifact: RemoteArtifact.make({
          artifactId: `learned-state/v1/${sha256(bytes)}`,
          artifactType: "learned_state",
          objectHash: sha256(bytes),
          revisionHash: null,
          updatedAt: learnedState.exported_at,
        }),
      });
    }
  }
  return objects;
}

function collectLocalObjectsFailure(cause: unknown): CLIError {
  if (cause instanceof CLIError) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new CLIError(
    `Sync & Backup could not collect local Library objects: ${detail}`,
    "OPERATION_FAILED",
    "Review the local Library state and retry Sync & Backup.",
  );
}

function remoteCatalogOptions(options: CollectLocalObjectsOptions): LibraryCatalogOptions {
  return {
    ...options.catalogOptions,
    skillSetConfigRoot: options.configRoot,
    sourceMetadata: {
      updateCachePath: join(options.configRoot, "cache", "skill-updates-v1.json"),
      ...options.catalogOptions?.sourceMetadata,
    },
  };
}

export async function collectLocalObjects(
  options: CollectLocalObjectsOptions,
): Promise<RemoteSyncObject[]> {
  const snapshot = await loadLibraryCatalog(remoteCatalogOptions(options));
  return collectLocalObjectsFromSnapshot(options, snapshot);
}

export const collectLocalObjectsEffect = Effect.fn(
  "selftune.runtime.remoteLibrary.collectLocalObjects",
)(function* (options: CollectLocalObjectsOptions) {
  const snapshot = yield* loadLibraryCatalogEffect(remoteCatalogOptions(options));
  return yield* Effect.try({
    try: () => collectLocalObjectsFromSnapshot(options, snapshot),
    catch: collectLocalObjectsFailure,
  });
});
