import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import * as Schema from "effect/Schema";

const RuntimeManifest = Schema.Struct({
  version: Schema.Literal(2),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      signing_mutable: Schema.Boolean,
      sha256: Schema.String,
      size: Schema.Number,
    }),
  ),
});

const PRIMARY_RUNTIME_EXECUTABLE_PATHS: ReadonlySet<string> = new Set(["selftune", "selftune.exe"]);
const RUNTIME_EXECUTABLE_PATHS: ReadonlySet<string> = new Set([
  "selftune",
  "selftune.exe",
  "selftune-report-worker",
  "selftune-report-worker.exe",
]);
const SIGNING_MUTABLE_RUNTIME_PATHS: ReadonlySet<string> = new Set([
  "selftune",
  "selftune.exe",
  "selftune-report-worker",
  "selftune-report-worker.exe",
  "node_modules/@duckdb/node-api/node_modules/@duckdb/node-bindings/native/duckdb.node",
  "node_modules/@duckdb/node-api/node_modules/@duckdb/node-bindings/native/libduckdb.dylib",
]);

export interface RuntimeIntegrityOptions {
  readonly allowPlatformSigningMutation?: boolean;
}

export interface DeveloperIdSigningIdentity {
  readonly authority: string;
  readonly teamIdentifier: string;
}

export function isSigningMutableRuntimePath(path: string): boolean {
  return SIGNING_MUTABLE_RUNTIME_PATHS.has(path);
}

export function parseDeveloperIdSigningIdentity(
  details: string,
): DeveloperIdSigningIdentity | null {
  const authority = details.match(/^Authority=(Developer ID Application:[^\r\n]+)$/mu)?.[1];
  const teamIdentifier = details.match(/^TeamIdentifier=([A-Z0-9]+)$/mu)?.[1];
  if (!authority || !teamIdentifier) return null;
  return { authority, teamIdentifier };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readRuntimeManifest(root: string): typeof RuntimeManifest.Type {
  const value: unknown = JSON.parse(readFileSync(join(root, "runtime-manifest.json"), "utf8"));
  return Schema.decodeUnknownSync(RuntimeManifest)(value);
}

export function verifyRuntimeDirectory(
  root: string,
  options: RuntimeIntegrityOptions = {},
): boolean {
  try {
    const manifest = readRuntimeManifest(root);
    if (manifest.files.length === 0) return false;
    const signingMutable = manifest.files.filter((entry) => entry.signing_mutable);
    const signingMutableExecutables = signingMutable.filter((entry) =>
      PRIMARY_RUNTIME_EXECUTABLE_PATHS.has(entry.path),
    );
    if (
      signingMutableExecutables.length !== 1 ||
      signingMutable.some((entry) => !isSigningMutableRuntimePath(entry.path))
    ) {
      return false;
    }
    for (const entry of manifest.files) {
      if (
        !entry.path ||
        entry.path.startsWith("/") ||
        entry.path.split(/[\\/]/).includes("..") ||
        !/^[0-9a-f]{64}$/.test(entry.sha256)
      ) {
        return false;
      }
      const path = join(root, entry.path);
      if (!existsSync(path)) return false;
      const info = statSync(path);
      if (!info.isFile()) return false;
      if (
        RUNTIME_EXECUTABLE_PATHS.has(entry.path) &&
        process.platform !== "win32" &&
        (info.mode & 0o111) === 0
      ) {
        return false;
      }
      const matchesBuildHash = info.size === entry.size && sha256(path) === entry.sha256;
      if (
        !matchesBuildHash &&
        !(entry.signing_mutable && options.allowPlatformSigningMutation === true)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function runtimeMatchesSignedSource(
  source: string,
  candidate: string,
  options: RuntimeIntegrityOptions = {},
): boolean {
  if (!verifyRuntimeDirectory(source, options) || !verifyRuntimeDirectory(candidate, options)) {
    return false;
  }
  try {
    if (
      sha256(join(source, "runtime-manifest.json")) !==
      sha256(join(candidate, "runtime-manifest.json"))
    ) {
      return false;
    }
    const manifest = readRuntimeManifest(source);
    return manifest.files.every((entry) => {
      const sourcePath = join(source, entry.path);
      const candidatePath = join(candidate, entry.path);
      return (
        statSync(sourcePath).size === statSync(candidatePath).size &&
        sha256(sourcePath) === sha256(candidatePath)
      );
    });
  } catch {
    return false;
  }
}
