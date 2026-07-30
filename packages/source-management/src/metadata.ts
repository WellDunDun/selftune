import type { LibraryOrigin, SkillUpdateStatus } from "@selftune/control-plane";
import * as Schema from "effect/Schema";

export const SkillLockEntry = Schema.Struct({
  source: Schema.String,
  sourceType: Schema.String,
  sourceUrl: Schema.optional(Schema.String),
  skillPath: Schema.optional(Schema.String),
  skillFolderHash: Schema.optional(Schema.String),
  computedHash: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
});
export type SkillLockEntry = typeof SkillLockEntry.Type;

export const SkillLock = Schema.Struct({
  version: Schema.Number,
  skills: Schema.Record(Schema.String, SkillLockEntry),
});
export type SkillLock = typeof SkillLock.Type;

export const GitHubTree = Schema.Struct({
  sha: Schema.String,
  tree: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      type: Schema.String,
      sha: Schema.String,
    }),
  ),
});
export type GitHubTree = typeof GitHubTree.Type;

export interface TrackedSkillSource {
  lockPath: string;
  lockKey: string;
  entry: SkillLockEntry;
}

export interface InstalledSkillMetadata {
  origin: LibraryOrigin;
  updateStatus: SkillUpdateStatus;
}

export interface SkillSourceMetadataOptions {
  homeDir?: string;
  xdgStateHome?: string;
  githubTreeLoader?: (source: string, ref: string | null) => Promise<GitHubTree | null>;
  githubToken?: string | null;
  githubTokenLoader?: () => string | null;
  updateCachePath?: string;
  updateCacheTtlMs?: number;
  now?: number;
  updateMode?: "blocking" | "cache-first";
}

export function normalizeGitHubRepository(source: string): string | null {
  const trimmed = source.trim().replace(/\.git$/, "");
  const ssh = trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (ssh?.[1]) return ssh[1];
  const https = trimmed.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  if (https?.[1]) return https[1];
  return /^[^/\s]+\/[^/\s]+$/.test(trimmed) ? trimmed : null;
}

export function sourceFolderPath(skillPath: string): string {
  const normalized = skillPath.replaceAll("\\", "/");
  if (normalized.toLowerCase().endsWith("/skill.md")) return normalized.slice(0, -9);
  if (normalized.toLowerCase() === "skill.md") return "";
  return normalized.replace(/\/$/, "");
}

export function sourceSubtreeHash(tree: GitHubTree, skillPath: string): string | null {
  const folder = sourceFolderPath(skillPath);
  if (!folder) return tree.sha;
  return tree.tree.find((entry) => entry.type === "tree" && entry.path === folder)?.sha ?? null;
}

export function sourceOrigin(entry: SkillLockEntry): LibraryOrigin {
  const repository = normalizeGitHubRepository(entry.source);
  const kind =
    entry.sourceType === "github"
      ? "github"
      : entry.sourceType === "well-known"
        ? "well_known"
        : entry.sourceType === "local"
          ? "local"
          : "unknown";
  return {
    kind,
    label: repository ?? entry.source,
    url: entry.sourceUrl ?? (repository ? `https://github.com/${repository}` : null),
  };
}
