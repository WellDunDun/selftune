import * as Schema from "effect/Schema";

export const SkillIdentity = Schema.Struct({
  skillId: Schema.String,
  name: Schema.String,
});
export type SkillIdentity = typeof SkillIdentity.Type;

export const SkillSource = Schema.Struct({
  sourceId: Schema.String,
  skillId: Schema.String,
  editablePath: Schema.String,
  updatedAt: Schema.String,
});
export type SkillSource = typeof SkillSource.Type;

export const SkillRevision = Schema.Struct({
  revisionHash: Schema.String,
  skillId: Schema.String,
  sourceId: Schema.String,
  createdAt: Schema.String,
});
export type SkillRevision = typeof SkillRevision.Type;

export const SkillRelease = Schema.Struct({
  releaseId: Schema.String,
  skillId: Schema.String,
  revisionHash: Schema.String,
  channel: Schema.String,
  approvedAt: Schema.String,
});
export type SkillRelease = typeof SkillRelease.Type;

export const SkillBundle = Schema.Struct({
  bundleHash: Schema.String,
  releaseId: Schema.String,
  objectHash: Schema.String,
  byteLength: Schema.Number,
});
export type SkillBundle = typeof SkillBundle.Type;

export const SkillInstall = Schema.Struct({
  installId: Schema.String,
  bundleHash: Schema.String,
  harness: Schema.String,
  scope: Schema.String,
  materializedPath: Schema.String,
  active: Schema.Boolean,
});
export type SkillInstall = typeof SkillInstall.Type;

export const PackageLineage = Schema.Struct({
  skill: SkillIdentity,
  sources: Schema.Array(SkillSource),
  revisions: Schema.Array(SkillRevision),
  releases: Schema.Array(SkillRelease),
  bundles: Schema.Array(SkillBundle),
  installs: Schema.Array(SkillInstall),
});
export type PackageLineage = typeof PackageLineage.Type;
