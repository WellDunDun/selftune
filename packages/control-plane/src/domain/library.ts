import * as Schema from "effect/Schema";

export const SkillSourceKind = Schema.Literals([
  "installed",
  "cached",
  "draft",
  "archived",
  "remote",
]);
export type SkillSourceKind = typeof SkillSourceKind.Type;

export const HarnessId = Schema.Literals(["claude_code", "codex", "opencode", "openclaw", "pi"]);
export type HarnessId = typeof HarnessId.Type;

export const InstallScope = Schema.Literals([
  "global",
  "project",
  "admin",
  "system",
  "library",
  "unknown",
]);
export type InstallScope = typeof InstallScope.Type;

export const SkillLifecycle = Schema.Literals(["active", "library", "draft", "archived"]);
export type SkillLifecycle = typeof SkillLifecycle.Type;

export const SkillUpdateStatus = Schema.Literals(["available", "current", "unknown", "untracked"]);
export type SkillUpdateStatus = typeof SkillUpdateStatus.Type;

export const LibraryOrigin = Schema.Struct({
  kind: Schema.Literals(["github", "well_known", "registry", "local", "generated", "unknown"]),
  label: Schema.String,
  url: Schema.NullOr(Schema.String),
});
export type LibraryOrigin = typeof LibraryOrigin.Type;

export const LibraryObservation = Schema.Struct({
  skillName: Schema.String,
  sourceKind: SkillSourceKind,
  contentHash: Schema.NullOr(Schema.String),
  packagePath: Schema.String,
  skillPath: Schema.String,
  harness: Schema.NullOr(HarnessId),
  scope: InstallScope,
  projectRoot: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
  modifiedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(LibraryOrigin),
  updateStatus: SkillUpdateStatus,
});
export type LibraryObservation = typeof LibraryObservation.Type;

export const LibraryLocation = Schema.Struct({
  sourceKind: SkillSourceKind,
  packagePath: Schema.String,
  skillPath: Schema.String,
  harness: Schema.NullOr(HarnessId),
  scope: InstallScope,
  projectRoot: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
  modifiedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(LibraryOrigin),
  updateStatus: SkillUpdateStatus,
});
export type LibraryLocation = typeof LibraryLocation.Type;

export const LibraryRevision = Schema.Struct({
  contentHash: Schema.String,
  locations: Schema.Array(LibraryLocation),
});
export type LibraryRevision = typeof LibraryRevision.Type;

export const LibrarySkill = Schema.Struct({
  skillId: Schema.String,
  name: Schema.String,
  lifecycle: SkillLifecycle,
  revisions: Schema.Array(LibraryRevision),
  locations: Schema.Array(LibraryLocation),
  lastUsedAt: Schema.NullOr(Schema.String),
  lastModifiedAt: Schema.String,
  origins: Schema.Array(LibraryOrigin),
  updateStatus: SkillUpdateStatus,
});
export type LibrarySkill = typeof LibrarySkill.Type;

export const LibraryCounts = Schema.Struct({
  total: Schema.Number,
  active: Schema.Number,
  library: Schema.Number,
  draft: Schema.Number,
  archived: Schema.Number,
});
export type LibraryCounts = typeof LibraryCounts.Type;

export const LibrarySnapshot = Schema.Struct({
  generatedAt: Schema.String,
  skills: Schema.Array(LibrarySkill),
  counts: LibraryCounts,
});
export type LibrarySnapshot = typeof LibrarySnapshot.Type;

export const emptyLibrarySnapshot = LibrarySnapshot.make({
  generatedAt: "1970-01-01T00:00:00.000Z",
  skills: [],
  counts: {
    total: 0,
    active: 0,
    library: 0,
    draft: 0,
    archived: 0,
  },
});
