import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";

import {
  RemoteCapabilities,
  RemoteConflict,
  RemoteDiagnostics,
  RemoteIntegrityFailure,
  RemoteLibraryUnavailable,
  RemoteObjectMissing,
  type RemoteArtifact,
  type RemoteArtifactType,
  RemoteSnapshot,
} from "../domain";
import { sha256 } from "../programs";
import { RemoteLibrary } from "../services";

export interface RemoteLibraryHttpOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

const WireArtifactType = Schema.Literals([
  "skill_revision",
  "draft_revision",
  "skill_set",
  "decision_history",
  "evidence_summary",
]);

const WireMetadataValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);

const WireArtifact = Schema.Struct({
  artifact_id: Schema.String,
  artifact_type: WireArtifactType,
  object_sha256: Schema.String,
  revision: Schema.String,
  metadata: Schema.Record(Schema.String, WireMetadataValue),
});

const WireSnapshot = Schema.Struct({
  id: Schema.String,
  parent_snapshot_id: Schema.NullOr(Schema.String),
  schema_version: Schema.Literal("selftune.remote-library.snapshot.v1"),
  artifacts: Schema.Array(WireArtifact),
  created_at: Schema.String,
});

const WireSnapshotEnvelope = Schema.Struct({ snapshot: WireSnapshot });
const WireHeadEnvelope = Schema.Struct({ snapshot: Schema.NullOr(WireSnapshot) });

const WireCapabilities = Schema.Struct({
  protocol: Schema.Literal("selftune.remote-library.v1"),
  snapshot_schema: Schema.Literal("selftune.remote-library.snapshot.v1"),
  immutable_objects: Schema.Literal(true),
  compare_and_swap_heads: Schema.Literal(true),
  raw_transcripts_synced: Schema.Literal(false),
  max_object_bytes: Schema.Number,
});

const WireConflictBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal("RemoteLibraryHeadConflict"),
    expected_parent_id: Schema.NullOr(Schema.String),
    current_head_id: Schema.NullOr(Schema.String),
  }),
});

const WireMissingObjectBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal("RemoteLibraryObjectMissing"),
    object_sha256: Schema.String,
  }),
});

const WireDiagnostics = Schema.Struct({
  status: Schema.Literals(["ok", "degraded"]),
  object_count: Schema.Number,
  snapshot_count: Schema.Number,
  referenced_object_count: Schema.Number,
  total_bytes: Schema.Number,
  missing_objects: Schema.Array(Schema.String),
  orphaned_objects: Schema.Array(Schema.String),
});

function unavailable(operation: string, cause: unknown): RemoteLibraryUnavailable {
  return new RemoteLibraryUnavailable({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

function toWireArtifactType(type: RemoteArtifactType): typeof WireArtifactType.Type {
  switch (type) {
    case "skill_revision":
    case "released_skill":
      return "skill_revision";
    case "draft":
      return "draft_revision";
    case "skill_set":
      return "skill_set";
    case "decision_history":
      return "decision_history";
    case "metadata":
    case "learned_state":
      return "evidence_summary";
  }
}

function fromWireArtifactType(
  type: typeof WireArtifactType.Type,
  metadata: Readonly<Record<string, string | number | boolean | null>>,
): RemoteArtifactType {
  const controlPlaneType = metadata.control_plane_artifact_type;
  switch (controlPlaneType) {
    case "skill_revision":
    case "released_skill":
    case "draft":
    case "skill_set":
    case "decision_history":
    case "metadata":
    case "learned_state":
      return controlPlaneType;
  }
  switch (type) {
    case "skill_revision":
      return "skill_revision";
    case "draft_revision":
      return "draft";
    case "skill_set":
      return "skill_set";
    case "decision_history":
      return "decision_history";
    case "evidence_summary":
      return "metadata";
  }
}

function metadataString(
  metadata: Readonly<Record<string, string | number | boolean | null>>,
  key: string,
): string | null | undefined {
  const value = metadata[key];
  return value === null || typeof value === "string" ? value : undefined;
}

function toWireArtifact(artifact: RemoteArtifact): typeof WireArtifact.Type {
  return {
    artifact_id: artifact.artifactId,
    artifact_type: toWireArtifactType(artifact.artifactType),
    object_sha256: artifact.objectHash,
    revision: artifact.revisionHash ?? artifact.updatedAt,
    metadata: {
      control_plane_artifact_type: artifact.artifactType,
      revision_hash: artifact.revisionHash,
      updated_at: artifact.updatedAt,
    },
  };
}

function fromWireSnapshot(snapshot: typeof WireSnapshot.Type): RemoteSnapshot {
  return RemoteSnapshot.make({
    snapshotId: snapshot.id,
    parentSnapshotId: snapshot.parent_snapshot_id,
    createdAt: snapshot.created_at,
    artifacts: snapshot.artifacts.map((artifact) => {
      const metadataRevision = metadataString(artifact.metadata, "revision_hash");
      const metadataUpdatedAt = metadataString(artifact.metadata, "updated_at");
      return {
        artifactId: artifact.artifact_id,
        artifactType: fromWireArtifactType(artifact.artifact_type, artifact.metadata),
        objectHash: artifact.object_sha256,
        revisionHash: metadataRevision === null ? null : (metadataRevision ?? artifact.revision),
        updatedAt: metadataUpdatedAt ?? snapshot.created_at,
      };
    }),
  });
}

function toWireSnapshot(snapshot: RemoteSnapshot): {
  schema_version: "selftune.remote-library.snapshot.v1";
  expected_parent_id: string | null;
  artifacts: Array<typeof WireArtifact.Type>;
} {
  return {
    schema_version: "selftune.remote-library.snapshot.v1",
    expected_parent_id: snapshot.parentSnapshotId,
    artifacts: snapshot.artifacts.map(toWireArtifact),
  };
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

export function RemoteLibraryHttp(options: RemoteLibraryHttpOptions) {
  const baseUrl = trimTrailingSlashes(options.baseUrl);
  const fetchClient = options.fetch ?? globalThis.fetch;
  const headers = { Authorization: `Bearer ${options.apiKey}` };

  const request = (operation: string, path: string, init?: RequestInit) =>
    Effect.tryPromise({
      try: () =>
        fetchClient(`${baseUrl}/api/v1/remote-library${path}`, {
          ...init,
          headers: { ...headers, ...init?.headers },
        }),
      catch: (cause) => unavailable(operation, cause),
    });

  const readJson = (operation: string, response: Response) =>
    Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: (cause) => unavailable(operation, cause),
    });

  const decode = <S extends Schema.Top>(operation: string, schema: S, response: Response) =>
    readJson(operation, response).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError((cause) =>
        cause instanceof RemoteLibraryUnavailable ? cause : unavailable(operation, cause),
      ),
    );

  return Layer.succeed(RemoteLibrary)({
    capabilities: Effect.gen(function* () {
      const response = yield* request("capabilities", "/capabilities");
      if (!response.ok) return yield* unavailable("capabilities", `HTTP ${response.status}`);
      const capabilities = yield* decode("capabilities", WireCapabilities, response);
      return RemoteCapabilities.make({
        protocolVersion: 1,
        immutableObjects: capabilities.immutable_objects,
        compareAndSwapSnapshots: capabilities.compare_and_swap_heads,
        maxObjectBytes: capabilities.max_object_bytes,
      });
    }),
    putObject: Effect.fn("RemoteLibraryHttp.putObject")(function* ({ objectHash, bytes }) {
      const actualHash = sha256(bytes);
      if (actualHash !== objectHash) {
        return yield* new RemoteIntegrityFailure({ expectedHash: objectHash, actualHash });
      }
      const response = yield* request("putObject", `/objects/${objectHash}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob([Uint8Array.from(bytes)]),
      });
      if (!response.ok) return yield* unavailable("putObject", `HTTP ${response.status}`);
    }),
    hasObject: Effect.fn("RemoteLibraryHttp.hasObject")(function* (objectHash) {
      const response = yield* request("hasObject", `/objects/${objectHash}`, { method: "HEAD" });
      if (response.status === 404) return false;
      if (!response.ok) return yield* unavailable("hasObject", `HTTP ${response.status}`);
      return true;
    }),
    getObject: Effect.fn("RemoteLibraryHttp.getObject")(function* (objectHash) {
      const response = yield* request("getObject", `/objects/${objectHash}`);
      if (response.status === 404) return yield* new RemoteObjectMissing({ objectHash });
      if (!response.ok) return yield* unavailable("getObject", `HTTP ${response.status}`);
      const bytes = new Uint8Array(
        yield* Effect.tryPromise({
          try: () => response.arrayBuffer(),
          catch: (cause) => unavailable("getObject", cause),
        }),
      );
      const actualHash = sha256(bytes);
      if (actualHash !== objectHash) {
        return yield* new RemoteIntegrityFailure({ expectedHash: objectHash, actualHash });
      }
      return bytes;
    }),
    head: Effect.gen(function* () {
      const response = yield* request("head", "/snapshots/head");
      if (response.status === 404) return null;
      if (!response.ok) return yield* unavailable("head", `HTTP ${response.status}`);
      const envelope = yield* decode("head", WireHeadEnvelope, response);
      return envelope.snapshot === null ? null : fromWireSnapshot(envelope.snapshot);
    }),
    getSnapshot: Effect.fn("RemoteLibraryHttp.getSnapshot")(function* (snapshotId) {
      const response = yield* request("getSnapshot", `/snapshots/${snapshotId}`);
      if (response.status === 404) {
        return yield* new RemoteObjectMissing({ objectHash: snapshotId });
      }
      if (!response.ok) return yield* unavailable("getSnapshot", `HTTP ${response.status}`);
      const envelope = yield* decode("getSnapshot", WireSnapshotEnvelope, response);
      return fromWireSnapshot(envelope.snapshot);
    }),
    commitSnapshot: Effect.fn("RemoteLibraryHttp.commitSnapshot")(function* (snapshot) {
      const response = yield* request("commitSnapshot", "/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toWireSnapshot(snapshot)),
      });
      if (response.status === 409) {
        const conflict = yield* decode("commitSnapshot", WireConflictBody, response);
        return yield* new RemoteConflict({
          expectedParentId: conflict.error.expected_parent_id,
          actualParentId: conflict.error.current_head_id,
        });
      }
      if (response.status === 422) {
        const missing = yield* decode("commitSnapshot", WireMissingObjectBody, response);
        return yield* new RemoteObjectMissing({ objectHash: missing.error.object_sha256 });
      }
      if (!response.ok) return yield* unavailable("commitSnapshot", `HTTP ${response.status}`);
      const envelope = yield* decode("commitSnapshot", WireSnapshotEnvelope, response);
      return fromWireSnapshot(envelope.snapshot);
    }),
    diagnostics: Effect.gen(function* () {
      const response = yield* request("diagnostics", "/diagnostics");
      if (!response.ok) return yield* unavailable("diagnostics", `HTTP ${response.status}`);
      const diagnostics = yield* decode("diagnostics", WireDiagnostics, response);
      return RemoteDiagnostics.make({
        objectCount: diagnostics.object_count,
        snapshotCount: diagnostics.snapshot_count,
        totalBytes: diagnostics.total_bytes,
        missingObjects: diagnostics.missing_objects,
        orphanedObjects: diagnostics.orphaned_objects,
      });
    }),
  });
}

/** Promise boundary for hosts that should not need to load or provide an Effect runtime. */
export function makeRemoteLibraryHttpClient(options: RemoteLibraryHttpOptions) {
  const runtime = ManagedRuntime.make(RemoteLibraryHttp(options));
  const run = <A, E>(program: Effect.Effect<A, E, RemoteLibrary>): Promise<A> =>
    runtime.runPromise(program);

  return {
    capabilities: () =>
      run(
        Effect.gen(function* () {
          return yield* (yield* RemoteLibrary).capabilities;
        }),
      ),
    putObject: (objectHash: string, bytes: Uint8Array) =>
      run(
        Effect.gen(function* () {
          yield* (yield* RemoteLibrary).putObject({ objectHash, bytes });
        }),
      ),
    hasObject: (objectHash: string) =>
      run(
        Effect.gen(function* () {
          return yield* (yield* RemoteLibrary).hasObject(objectHash);
        }),
      ),
    getObject: (objectHash: string) =>
      run(
        Effect.gen(function* () {
          return yield* (yield* RemoteLibrary).getObject(objectHash);
        }),
      ),
    head: () =>
      run(
        Effect.gen(function* () {
          return yield* (yield* RemoteLibrary).head;
        }),
      ),
    getSnapshot: (snapshotId: string) =>
      run(
        Effect.gen(function* () {
          return yield* (yield* RemoteLibrary).getSnapshot(snapshotId);
        }),
      ),
    commitSnapshot: (snapshot: RemoteSnapshot) =>
      run(
        Effect.gen(function* () {
          return yield* (yield* RemoteLibrary).commitSnapshot(snapshot);
        }),
      ),
    diagnostics: () =>
      run(
        Effect.gen(function* () {
          return yield* (yield* RemoteLibrary).diagnostics;
        }),
      ),
    dispose: () => runtime.dispose(),
  };
}
