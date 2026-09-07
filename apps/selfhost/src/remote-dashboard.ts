import type { LibrarySnapshot } from "@selftune/control-plane";
import {
  LibraryLocation,
  LibraryOrigin,
  LibraryRevision,
  LibrarySkill,
  LibrarySnapshot as LibrarySnapshotSchema,
} from "@selftune/control-plane";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import type { SkillSetManifest, SkillSetsResponse } from "@selftune/runtime/dashboard-contract";
import type { SelfHostConfig } from "./config.js";
import { RemoteArtifact, type RemoteSnapshot } from "./contract.js";
import type { RemoteApiHandle } from "./remote-api.js";

const EPOCH = "1970-01-01T00:00:00.000Z";

const SnapshotEnvelope = Schema.Struct({
  snapshot: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      parent_snapshot_id: Schema.NullOr(Schema.String),
      schema_version: Schema.Literal("selftune.remote-library.snapshot.v1"),
      artifacts: Schema.Array(RemoteArtifact),
      created_at: Schema.String,
    }),
  ),
});

const SkillSetHarness = Schema.Literals(["codex", "claude_code", "opencode", "openclaw", "pi"]);
const StoredSkillSet = Schema.Struct({
  schema_version: Schema.Literal(1),
  set_id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  harnesses: Schema.Array(SkillSetHarness),
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      content_hash: Schema.String,
    }),
  ),
  revision: Schema.Number,
  revision_hash: Schema.String,
  parent_revision_hash: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
});

class RemoteDashboardFailure extends Schema.TaggedErrorClass<RemoteDashboardFailure>()(
  "RemoteDashboardFailure",
  {
    operation: Schema.String,
    message: Schema.String,
    status: Schema.Number,
  },
) {}

interface RemoteDashboardLoaders {
  readonly libraryLoader: () => Promise<LibrarySnapshot>;
  readonly skillSetsLoader: () => Promise<SkillSetsResponse>;
}

interface RemoteSkillArtifact {
  readonly artifact: typeof RemoteArtifact.Type;
  readonly name: string;
  readonly source: "draft" | "released";
  readonly updatedAt: string;
}

function failure(operation: string, status: number, message: string): RemoteDashboardFailure {
  return RemoteDashboardFailure.make({ operation, status, message });
}

function metadataString(
  metadata: Readonly<Record<string, string | number | boolean | null>>,
  key: string,
): string | null {
  return Schema.decodeUnknownOption(Schema.String)(metadata[key]).pipe(
    Option.filter((value) => value.trim().length > 0),
    Option.getOrNull,
  );
}

function nameFromArtifactId(artifactId: string, type: "skill_revision" | "draft_revision"): string {
  const slashPrefix = type === "skill_revision" ? "skill/" : "draft/";
  if (artifactId.startsWith(slashPrefix)) {
    const withoutPrefix = artifactId.slice(slashPrefix.length);
    const finalSlash = withoutPrefix.lastIndexOf("/");
    const name = (finalSlash > 0 ? withoutPrefix.slice(0, finalSlash) : withoutPrefix).trim();
    if (name) return name;
  }

  const colonPrefixes = type === "skill_revision" ? ["skill:", "skill/"] : ["draft:", "draft/"];
  for (const prefix of colonPrefixes) {
    if (!artifactId.startsWith(prefix)) continue;
    const name = artifactId.slice(prefix.length).trim();
    if (name) return name;
  }

  return `remote-skill-${artifactId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48)}`;
}

function remotePackagePath(objectSha256: string, skillName: string): string {
  return `selftune-remote://objects/${objectSha256}/packages/${encodeURIComponent(skillName)}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function remoteSkillArtifacts(snapshot: RemoteSnapshot): ReadonlyArray<RemoteSkillArtifact> {
  return snapshot.artifacts.flatMap((artifact) => {
    if (
      artifact.artifact_type !== "skill_revision" &&
      artifact.artifact_type !== "draft_revision"
    ) {
      return [];
    }
    const metadataName = metadataString(artifact.metadata, "skill_name");
    return [
      {
        artifact,
        name: metadataName ?? nameFromArtifactId(artifact.artifact_id, artifact.artifact_type),
        source: artifact.artifact_type === "draft_revision" ? "draft" : "released",
        updatedAt: metadataString(artifact.metadata, "updated_at") ?? snapshot.created_at,
      },
    ];
  });
}

function buildRemoteLibrarySnapshot(
  snapshot: RemoteSnapshot | null,
  originUrl: string,
): LibrarySnapshot {
  if (!snapshot) {
    return LibrarySnapshotSchema.make({
      generatedAt: EPOCH,
      skills: [],
      counts: { total: 0, active: 0, library: 0, draft: 0, archived: 0 },
    });
  }

  const origin = LibraryOrigin.make({
    kind: "registry",
    label: "SelfTune Remote Library",
    url: originUrl,
  });
  const grouped = new Map<string, RemoteSkillArtifact[]>();
  for (const remoteArtifact of remoteSkillArtifacts(snapshot)) {
    const skillId = remoteArtifact.name.trim().toLocaleLowerCase("en-US");
    if (!skillId) continue;
    const artifacts = grouped.get(skillId) ?? [];
    artifacts.push(remoteArtifact);
    grouped.set(skillId, artifacts);
  }

  const skills = [...grouped.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([skillId, artifacts]) => {
      const locationsByRevision = new Map<string, Map<string, typeof LibraryLocation.Type>>();
      for (const remoteArtifact of artifacts) {
        const packagePath = remotePackagePath(
          remoteArtifact.artifact.object_sha256,
          remoteArtifact.name,
        );
        const location = LibraryLocation.make({
          sourceKind: "remote",
          packagePath,
          skillPath: `${packagePath}/SKILL.md`,
          harness: null,
          scope: "library",
          projectRoot: null,
          active: false,
          modifiedAt: remoteArtifact.updatedAt,
          lastUsedAt: null,
          origin,
          updateStatus: "untracked",
        });
        const locations = locationsByRevision.get(remoteArtifact.artifact.revision) ?? new Map();
        locations.set(packagePath, location);
        locationsByRevision.set(remoteArtifact.artifact.revision, locations);
      }
      const revisions = [...locationsByRevision.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([contentHash, locations]) =>
          LibraryRevision.make({ contentHash, locations: [...locations.values()] }),
        );
      const locations = revisions.flatMap((revision) => revision.locations);
      const lastModifiedAt =
        artifacts
          .map((artifact) => artifact.updatedAt)
          .sort((left, right) => compareText(right, left))[0] ?? snapshot.created_at;
      return LibrarySkill.make({
        skillId,
        name: [...artifacts].map((artifact) => artifact.name).sort(compareText)[0] ?? skillId,
        lifecycle: artifacts.some((artifact) => artifact.source === "released")
          ? "library"
          : "draft",
        revisions,
        locations,
        lastUsedAt: null,
        lastModifiedAt,
        origins: [origin],
        updateStatus: "untracked",
      });
    });

  return LibrarySnapshotSchema.make({
    generatedAt: snapshot.created_at,
    skills,
    counts: {
      total: skills.length,
      active: 0,
      library: skills.filter((skill) => skill.lifecycle === "library").length,
      draft: skills.filter((skill) => skill.lifecycle === "draft").length,
      archived: 0,
    },
  });
}

function skillSetManifest(
  stored: typeof StoredSkillSet.Type,
  artifact: typeof RemoteArtifact.Type,
  objectByRevision: ReadonlyMap<string, string>,
): SkillSetManifest {
  return {
    schema_version: stored.schema_version,
    set_id: stored.set_id,
    name: stored.name,
    description: stored.description,
    harnesses: [...stored.harnesses],
    skills: stored.skills.map((skill) => ({
      ...skill,
      library_package_path: remotePackagePath(
        objectByRevision.get(skill.content_hash) ?? skill.content_hash,
        skill.name,
      ),
    })),
    revision: stored.revision,
    revision_hash: stored.revision_hash || artifact.revision,
    parent_revision_hash: stored.parent_revision_hash,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
  };
}

export function makeRemoteDashboardLoaders(
  config: SelfHostConfig,
  remoteApi: RemoteApiHandle,
): RemoteDashboardLoaders {
  const request = Effect.fn("RemoteDashboard.request")(function* (path: string) {
    const response = yield* Effect.tryPromise({
      try: () =>
        remoteApi.handle(
          new Request(`http://selftune.internal${path}`, {
            headers: { Authorization: `Bearer ${config.adminToken}` },
          }),
        ),
      catch: (cause) =>
        failure("request", 503, cause instanceof Error ? cause.message : String(cause)),
    });
    if (!response) return yield* failure("request", 404, "Remote Library route was not handled.");
    if (!response.ok) {
      return yield* failure(
        "request",
        response.status,
        `Remote Library request failed with HTTP ${response.status}.`,
      );
    }
    return response;
  });

  const loadHead = Effect.fn("RemoteDashboard.loadHead")(function* () {
    const response = yield* request("/api/v1/remote-library/snapshots/head");
    const input = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        failure("decode_head", 502, cause instanceof Error ? cause.message : String(cause)),
    });
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SnapshotEnvelope))(input).pipe(
      Effect.mapError((cause) => failure("decode_head", 502, cause.message)),
    );
  });

  const loadObject = Effect.fn("RemoteDashboard.loadObject")(function* (objectSha256: string) {
    const response = yield* request(`/api/v1/remote-library/objects/${objectSha256}`);
    return new Uint8Array(
      yield* Effect.tryPromise({
        try: () => response.arrayBuffer(),
        catch: (cause) =>
          failure("read_object", 502, cause instanceof Error ? cause.message : String(cause)),
      }),
    );
  });

  const loadLibrary = loadHead().pipe(
    Effect.map((envelope) => buildRemoteLibrarySnapshot(envelope.snapshot, config.publicUrl)),
  );

  const loadSkillSets = loadHead().pipe(
    Effect.flatMap((envelope) => {
      const artifacts = envelope.snapshot?.artifacts ?? [];
      const objectByRevision = new Map(
        artifacts
          .filter(
            (artifact) =>
              artifact.artifact_type === "skill_revision" ||
              artifact.artifact_type === "draft_revision",
          )
          .map((artifact) => [artifact.revision, artifact.object_sha256]),
      );
      return Effect.forEach(
        artifacts.filter((artifact) => artifact.artifact_type === "skill_set"),
        (artifact) =>
          loadObject(artifact.object_sha256).pipe(
            Effect.map((bytes) => new TextDecoder().decode(bytes)),
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(StoredSkillSet))),
            Effect.mapError((cause) =>
              cause instanceof RemoteDashboardFailure
                ? cause
                : failure("decode_skill_set", 422, cause.message),
            ),
            Effect.map((stored) => ({
              artifact,
              manifest: skillSetManifest(stored, artifact, objectByRevision),
            })),
          ),
      );
    }),
    Effect.map((entries): SkillSetsResponse => {
      const currentBySetId = new Map<string, SkillSetManifest>();
      for (const entry of entries) {
        const current = currentBySetId.get(entry.manifest.set_id);
        if (
          !current ||
          entry.manifest.updated_at > current.updated_at ||
          (entry.manifest.updated_at === current.updated_at &&
            entry.manifest.revision > current.revision)
        ) {
          currentBySetId.set(entry.manifest.set_id, entry.manifest);
        }
      }
      return {
        sets: [...currentBySetId.values()].sort((left, right) =>
          compareText(left.name, right.name),
        ),
        receipts: [],
      };
    }),
  );

  return {
    libraryLoader: () => Effect.runPromise(loadLibrary),
    skillSetsLoader: () => Effect.runPromise(loadSkillSets),
  };
}
