import * as Schema from "effect/Schema";

export const RemoteArtifactType = Schema.Literals([
  "skill_revision",
  "released_skill",
  "draft",
  "skill_set",
  "metadata",
  "decision_history",
  "learned_state",
]);
export type RemoteArtifactType = typeof RemoteArtifactType.Type;

export const RemoteArtifact = Schema.Struct({
  artifactId: Schema.String,
  artifactType: RemoteArtifactType,
  objectHash: Schema.String,
  revisionHash: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type RemoteArtifact = typeof RemoteArtifact.Type;

export const RemoteSnapshot = Schema.Struct({
  snapshotId: Schema.String,
  parentSnapshotId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  artifacts: Schema.Array(RemoteArtifact),
});
export type RemoteSnapshot = typeof RemoteSnapshot.Type;

export const RemoteCapabilities = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  immutableObjects: Schema.Literal(true),
  compareAndSwapSnapshots: Schema.Literal(true),
  maxObjectBytes: Schema.Number,
});
export type RemoteCapabilities = typeof RemoteCapabilities.Type;

export const RemoteDiagnostics = Schema.Struct({
  objectCount: Schema.Number,
  snapshotCount: Schema.Number,
  totalBytes: Schema.Number,
  missingObjects: Schema.Array(Schema.String),
  orphanedObjects: Schema.Array(Schema.String),
});
export type RemoteDiagnostics = typeof RemoteDiagnostics.Type;

export const SyncPreferences = Schema.Struct({
  releasedSkills: Schema.Boolean,
  drafts: Schema.Boolean,
  skillSets: Schema.Boolean,
  metadata: Schema.Boolean,
  decisionHistory: Schema.Boolean,
});
export type SyncPreferences = typeof SyncPreferences.Type;

export const defaultSyncPreferences = SyncPreferences.make({
  releasedSkills: true,
  drafts: false,
  skillSets: true,
  metadata: true,
  decisionHistory: true,
});
