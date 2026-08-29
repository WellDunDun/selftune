import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BACKUP_PACKAGE_BUNDLE_PROFILE,
  decodePortablePackageBundle,
  encodePortablePackageBundle,
  type PortablePackageBundleError,
  type PortablePackageFile,
  PortablePackageBundleError as PortablePackageBundleErrorClass,
  type PortablePackageBundleProfile,
  PortablePackagePath,
  PortablePackageReleaseAuthority,
  sha256,
} from "@selftune/control-plane";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { sanitizeSecrets } from "../contribute/sanitize.js";
import { CLIError } from "../utils/cli-error.js";
import { INTERNAL_PACKAGE_COLLECTOR_COMMAND } from "./package-bundle-collector-command.js";
import { assertSafeRelativePath } from "./package-identity.js";

declare const SELFTUNE_DESKTOP_SIDECAR_BUILD: boolean;

export const ReleaseAuthority = PortablePackageReleaseAuthority;
export const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

const COLLECTOR_PROTOCOL_MAGIC = Buffer.from("STPKG01\0", "ascii");
const COLLECTOR_HEADER_BYTES = COLLECTOR_PROTOCOL_MAGIC.byteLength + 4;
const COLLECTOR_FILE_OVERHEAD_BYTES = 8;
const MAXIMUM_COLLECTOR_PATH_BYTES = 2_048;
const MAXIMUM_COLLECTOR_TOTAL_PATH_BYTES = 8 * 1024 * 1024;
const MAXIMUM_COLLECTOR_STDERR_BYTES = 4_096;
const COLLECTOR_BUFFER_HEADROOM_BYTES = 64 * 1024;
const COLLECTOR_TIMEOUT_MILLISECONDS = 120_000;
const COLLECTOR_IGNORE_RULES = {
  exact: [".git", "node_modules", ".env"],
  prefixes: [".env."],
} as const;
type CollectorFailureReason =
  | "invalid_package"
  | "decoded_file_too_large"
  | "decoded_package_too_large";
const COLLECTOR_EXIT_REASONS = new Map<number, CollectorFailureReason>([
  [2, "invalid_package"],
  [3, "decoded_file_too_large"],
  [4, "decoded_package_too_large"],
]);
const SELFTUNE_HASH_FIELDS = new Set([
  "candidate_revision_hash",
  "content_hash",
  "evidenceSnapshotId",
  "evidence_snapshot_id",
  "objectHash",
  "revision_hash",
  "revision_hashes",
  "sourceSessionIds",
  "source_session_ids",
  "supporting_session_ids",
  "held_out_session_ids",
]);
const SELFTUNE_HASH = /^[a-f0-9]{64}$/i;

type CollectorSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: Parameters<typeof spawnSync>[2],
) => SpawnSyncReturns<Buffer>;

export interface PackageBundleCollectorProcess {
  readonly helperPath?: string;
  readonly spawn?: CollectorSpawn;
}

interface CollectorProtocolFile {
  readonly path: string;
  readonly contentOffset: number;
  readonly contentLength: number;
}

function preflightFailure(reason: CollectorFailureReason, message: string, path: string): CLIError {
  return packageCodecFailure(
    PortablePackageBundleErrorClass.make({
      reason,
      message: message.slice(0, 320),
      path: path.slice(0, 160),
    }),
  );
}

function validateCollectorProfile(profile: PortablePackageBundleProfile): void {
  const limits = [
    profile.maximumEncodedPackageBytes,
    profile.maximumFileCount,
    profile.maximumDecodedFileBytes,
    profile.maximumDecodedPackageBytes,
  ];
  if (
    (profile.name !== "backup" && profile.name !== "distribution") ||
    limits.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    profile.maximumFileCount > BACKUP_PACKAGE_BUNDLE_PROFILE.maximumFileCount ||
    profile.maximumDecodedFileBytes > BACKUP_PACKAGE_BUNDLE_PROFILE.maximumDecodedFileBytes ||
    profile.maximumDecodedPackageBytes > BACKUP_PACKAGE_BUNDLE_PROFILE.maximumDecodedPackageBytes ||
    profile.maximumEncodedPackageBytes > BACKUP_PACKAGE_BUNDLE_PROFILE.maximumEncodedPackageBytes ||
    profile.maximumDecodedFileBytes > profile.maximumDecodedPackageBytes
  ) {
    throw preflightFailure("invalid_package", "Package collector profile is invalid", ".");
  }
}

function maximumCollectorProtocolBytes(profile: PortablePackageBundleProfile): number {
  const pathBytes = Math.min(
    MAXIMUM_COLLECTOR_TOTAL_PATH_BYTES,
    profile.maximumFileCount * MAXIMUM_COLLECTOR_PATH_BYTES,
  );
  return (
    COLLECTOR_HEADER_BYTES +
    profile.maximumDecodedPackageBytes +
    pathBytes +
    profile.maximumFileCount * COLLECTOR_FILE_OVERHEAD_BYTES
  );
}

function collectorIgnoreRulesArgument(): string {
  const entries = [...COLLECTOR_IGNORE_RULES.exact, ...COLLECTOR_IGNORE_RULES.prefixes];
  if (entries.some((entry) => entry.length === 0 || entry.includes("/"))) {
    throw preflightFailure("invalid_package", "Package collector ignore rules are invalid", ".");
  }
  return JSON.stringify(COLLECTOR_IGNORE_RULES);
}

export function resolvePackageBundleCollectorHelper(): string {
  return fileURLToPath(new URL("./package-bundle-collector.cjs", import.meta.url));
}

function isCompiledDesktopSidecar(): boolean {
  return (
    typeof SELFTUNE_DESKTOP_SIDECAR_BUILD !== "undefined" && SELFTUNE_DESKTOP_SIDECAR_BUILD === true
  );
}

function collectorEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP"] as const) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function validateCollectorHelper(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
  } catch {
    throw preflightFailure(
      "invalid_package",
      "Package collector helper is unavailable or unsafe",
      ".",
    );
  }
}

function snapshotCollectorRoot(path: string): { readonly dev: bigint; readonly ino: bigint } {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev < 0n || stat.ino <= 0n) {
      throw new Error("root identity is not reliable");
    }
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    throw preflightFailure(
      "invalid_package",
      "Package root is unavailable or cannot be identified safely",
      ".",
    );
  }
}

function readUInt32(buffer: Buffer, offset: number, label: string): number {
  if (offset < 0 || offset + 4 > buffer.byteLength) {
    throw preflightFailure("invalid_package", `Collector protocol truncated at ${label}`, ".");
  }
  return buffer.readUInt32BE(offset);
}

function validateProtocolPath(path: string): void {
  try {
    Schema.decodeUnknownSync(PortablePackagePath)(path);
  } catch {
    throw preflightFailure("invalid_package", "Collector returned a non-portable path", path);
  }
}

export function decodePackageCollectorProtocol(
  stdout: Buffer,
  profile: PortablePackageBundleProfile,
  copyContent: (source: Uint8Array) => Uint8Array = (source) => Uint8Array.from(source),
): PortablePackageFile[] {
  validateCollectorProfile(profile);
  if (stdout.byteLength > maximumCollectorProtocolBytes(profile)) {
    throw preflightFailure(
      "decoded_package_too_large",
      "Collector protocol exceeds its bound",
      ".",
    );
  }
  if (
    stdout.byteLength < COLLECTOR_HEADER_BYTES ||
    !stdout.subarray(0, COLLECTOR_PROTOCOL_MAGIC.byteLength).equals(COLLECTOR_PROTOCOL_MAGIC)
  ) {
    throw preflightFailure("invalid_package", "Collector protocol header is invalid", ".");
  }

  const count = readUInt32(stdout, COLLECTOR_PROTOCOL_MAGIC.byteLength, "file count");
  if (count > profile.maximumFileCount) {
    throw preflightFailure(
      "invalid_package",
      "Collector protocol contains too many files",
      "files",
    );
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const metadata: CollectorProtocolFile[] = [];
  const pathIdentities = new Set<string>();
  let cursor = COLLECTOR_HEADER_BYTES;
  let totalContentBytes = 0;
  let totalPathBytes = 0;

  for (let index = 0; index < count; index += 1) {
    const pathLength = readUInt32(stdout, cursor, `files.${index}.pathLength`);
    cursor += 4;
    if (pathLength === 0 || pathLength > MAXIMUM_COLLECTOR_PATH_BYTES) {
      throw preflightFailure(
        "invalid_package",
        "Collector protocol path length is invalid",
        `files.${index}.path`,
      );
    }
    totalPathBytes += pathLength;
    if (
      totalPathBytes > MAXIMUM_COLLECTOR_TOTAL_PATH_BYTES ||
      cursor + pathLength > stdout.length
    ) {
      throw preflightFailure(
        "invalid_package",
        "Collector protocol path data exceeds its bound",
        `files.${index}.path`,
      );
    }
    let path: string;
    try {
      path = decoder.decode(stdout.subarray(cursor, cursor + pathLength));
    } catch {
      throw preflightFailure(
        "invalid_package",
        "Collector protocol path is not valid UTF-8",
        `files.${index}.path`,
      );
    }
    cursor += pathLength;
    validateProtocolPath(path);
    const identity = path.toLowerCase();
    if (pathIdentities.has(identity)) {
      throw preflightFailure("invalid_package", "Collector returned a duplicate path", path);
    }
    pathIdentities.add(identity);

    const contentLength = readUInt32(stdout, cursor, `files.${index}.contentLength`);
    cursor += 4;
    if (contentLength > profile.maximumDecodedFileBytes) {
      throw preflightFailure(
        "decoded_file_too_large",
        "Collector protocol file exceeds the selected profile limit",
        path,
      );
    }
    totalContentBytes += contentLength;
    if (
      totalContentBytes > profile.maximumDecodedPackageBytes ||
      cursor + contentLength > stdout.byteLength
    ) {
      throw preflightFailure(
        "decoded_package_too_large",
        "Collector protocol content exceeds the selected profile limit",
        path,
      );
    }
    metadata.push({ path, contentOffset: cursor, contentLength });
    cursor += contentLength;
  }
  if (cursor !== stdout.byteLength) {
    throw preflightFailure("invalid_package", "Collector protocol has trailing bytes", ".");
  }

  return metadata.map(({ path, contentOffset, contentLength }) => ({
    path,
    content: copyContent(stdout.subarray(contentOffset, contentOffset + contentLength)),
  }));
}

function collectorFailureFromProcess(result: SpawnSyncReturns<Buffer>): CLIError {
  const expectedReason =
    result.status === null ? undefined : COLLECTOR_EXIT_REASONS.get(result.status);
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr.subarray(0, MAXIMUM_COLLECTOR_STDERR_BYTES).toString("utf8")
    : "";
  if (expectedReason) {
    try {
      const decoded: unknown = JSON.parse(stderr);
      const record = Schema.decodeUnknownSync(UnknownRecord)(decoded);
      if (
        record.reason === expectedReason &&
        typeof record.message === "string" &&
        typeof record.path === "string"
      ) {
        return preflightFailure(expectedReason, record.message, record.path);
      }
    } catch {
      // Fall through to a bounded generic diagnostic.
    }
  }
  const detail =
    result.error?.message ?? (result.signal ? `signal ${result.signal}` : stderr.trim());
  return preflightFailure(
    "invalid_package",
    detail
      ? `Package collector process failed: ${detail.slice(0, 240)}`
      : "Package collector process failed without a valid diagnostic",
    ".",
  );
}

function collectPackageFiles(
  root: string,
  profile: PortablePackageBundleProfile,
  collector: PackageBundleCollectorProcess = {},
): PortablePackageFile[] {
  validateCollectorProfile(profile);
  let absoluteRoot: string;
  try {
    absoluteRoot = realpathSync(resolve(root));
  } catch {
    throw preflightFailure(
      "invalid_package",
      "Package root is unavailable or cannot be identified safely",
      ".",
    );
  }
  const rootIdentity = snapshotCollectorRoot(absoluteRoot);
  const spawn = collector.spawn ?? (spawnSync as CollectorSpawn);
  const compiledSidecar = isCompiledDesktopSidecar() && collector.helperPath === undefined;
  const helperPath = compiledSidecar
    ? process.execPath
    : resolve(collector.helperPath ?? resolvePackageBundleCollectorHelper());
  validateCollectorHelper(helperPath);
  const collectorArguments = [
    absoluteRoot,
    String(rootIdentity.dev),
    String(rootIdentity.ino),
    String(profile.maximumFileCount),
    String(profile.maximumDecodedFileBytes),
    String(profile.maximumDecodedPackageBytes),
    String(MAXIMUM_COLLECTOR_PATH_BYTES),
    String(MAXIMUM_COLLECTOR_TOTAL_PATH_BYTES),
    collectorIgnoreRulesArgument(),
  ];
  const result = spawn(
    process.execPath,
    compiledSidecar
      ? [INTERNAL_PACKAGE_COLLECTOR_COMMAND, ...collectorArguments]
      : [helperPath, ...collectorArguments],
    {
      cwd: dirname(helperPath),
      encoding: null,
      env: collectorEnvironment(),
      maxBuffer: maximumCollectorProtocolBytes(profile) + COLLECTOR_BUFFER_HEADROOM_BYTES,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: COLLECTOR_TIMEOUT_MILLISECONDS,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || result.signal) {
    throw collectorFailureFromProcess(result);
  }
  if (!Buffer.isBuffer(result.stdout)) {
    throw preflightFailure("invalid_package", "Package collector returned no binary output", ".");
  }
  return decodePackageCollectorProtocol(result.stdout, profile);
}

function maskOwnedHashes(value: unknown, field = ""): unknown {
  if (typeof value === "string") {
    return SELFTUNE_HASH_FIELDS.has(field) && SELFTUNE_HASH.test(value) ? "[SELFTUNE_HASH]" : value;
  }
  if (Array.isArray(value)) return value.map((item) => maskOwnedHashes(item, field));
  if (value === null || typeof value !== "object") return value;
  const record = Schema.decodeUnknownSync(UnknownRecord)(value);
  return Object.fromEntries(
    Object.entries(record).map(([key, nested]) => [key, maskOwnedHashes(nested, key)]),
  );
}

function contentForSecretScan(path: string, content: string): string {
  if (
    path !== "evals/generated.json" &&
    path !== "evals/release.json" &&
    path !== "selftune.synthesis.json"
  ) {
    return content;
  }
  try {
    const decoded: unknown = JSON.parse(content);
    return JSON.stringify(maskOwnedHashes(decoded));
  } catch {
    return content;
  }
}

function remoteSafePackageFiles(
  packagePath: string,
  profile: PortablePackageBundleProfile,
  collector: PackageBundleCollectorProcess,
) {
  return collectPackageFiles(packagePath, profile, collector).map((file) => {
    if (/(^|\/)(?:id_rsa|id_ed25519|credentials)(?:\.|$)|\.(?:pem|key|p12)$/i.test(file.path)) {
      throw new CLIError(
        `Sync & Backup blocked a credential-like package file: ${file.path}`,
        "GUARD_BLOCKED",
        "Remove the credential file or disable backup for this artifact.",
      );
    }
    const decodedContent = Buffer.from(file.content).toString("utf8");
    const scanContent = contentForSecretScan(file.path, decodedContent);
    if (!decodedContent.includes("\u0000") && sanitizeSecrets(scanContent) !== scanContent) {
      throw new CLIError(
        `Sync & Backup found a secret in package file ${file.path}.`,
        "GUARD_BLOCKED",
        "Remove or redact the secret before syncing this artifact.",
      );
    }
    if (file.path !== "selftune.synthesis.json") return file;
    try {
      const provenance = Schema.decodeUnknownSync(UnknownRecord)(
        JSON.parse(Buffer.from(file.content).toString("utf8")),
      );
      const pseudonymize = (value: unknown) =>
        Array.isArray(value)
          ? value
              .filter((item): item is string => typeof item === "string")
              .map((item) =>
                SELFTUNE_HASH.test(item) ? item : sha256(new TextEncoder().encode(item)),
              )
          : [];
      return {
        ...file,
        content: new TextEncoder().encode(
          `${JSON.stringify(
            {
              ...provenance,
              supporting_session_ids: pseudonymize(provenance.supporting_session_ids),
              held_out_session_ids: pseudonymize(provenance.held_out_session_ids),
            },
            null,
            2,
          )}\n`,
        ),
      };
    } catch (error) {
      throw new CLIError(
        `Draft provenance cannot be prepared for Sync & Backup: ${error instanceof Error ? error.message : String(error)}`,
        "GUARD_BLOCKED",
        "Repair selftune.synthesis.json or disable draft backup.",
      );
    }
  });
}

function packageCodecFailure(error: PortablePackageBundleError): CLIError {
  const path = error.path ? ` at ${error.path}` : "";
  const detail = error.detail ? `: ${error.detail}` : "";
  return new CLIError(
    `Package bundle rejected (${error.reason})${path}: ${error.message}${detail}`,
    "OPERATION_FAILED",
    `Resolve ${error.reason}${path} before retrying Sync & Backup.`,
  );
}

function runPackageCodec<A>(operation: Effect.Effect<A, PortablePackageBundleError>): A {
  const result = Effect.runSync(Effect.result(operation));
  if (Result.isFailure(result)) throw packageCodecFailure(result.failure);
  return result.success;
}

export function encodePackageBundle(
  packagePath: string,
  remoteSafe = false,
  releaseAuthority?: typeof ReleaseAuthority.Type,
): Uint8Array {
  return encodePackageBundleWithOptions(packagePath, {
    remoteSafe,
    ...(releaseAuthority ? { releaseAuthority } : {}),
  });
}

export interface EncodePackageBundleOptions {
  readonly remoteSafe?: boolean;
  readonly releaseAuthority?: typeof ReleaseAuthority.Type;
  readonly profile?: PortablePackageBundleProfile;
  readonly collector?: PackageBundleCollectorProcess;
}

export function encodePackageBundleWithOptions(
  packagePath: string,
  options: EncodePackageBundleOptions = {},
): Uint8Array {
  const profile = options.profile ?? BACKUP_PACKAGE_BUNDLE_PROFILE;
  const collector = options.collector ?? {};
  const files = options.remoteSafe
    ? remoteSafePackageFiles(packagePath, profile, collector)
    : collectPackageFiles(packagePath, profile, collector);
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new CLIError(`Package has no SKILL.md: ${packagePath}`, "FILE_NOT_FOUND");
  }
  return runPackageCodec(
    encodePortablePackageBundle(
      {
        files,
        ...(options.releaseAuthority ? { releaseAuthority: options.releaseAuthority } : {}),
      },
      profile,
    ),
  );
}

export function restorePackage(
  bytes: Uint8Array,
  destination: string,
): typeof ReleaseAuthority.Type | undefined {
  const bundle = runPackageCodec(decodePortablePackageBundle(bytes, BACKUP_PACKAGE_BUNDLE_PROFILE));
  for (const file of bundle.files) assertSafeRelativePath(file.path);
  for (const file of bundle.files) {
    const target = resolve(destination, file.path);
    const relativeTarget = relative(resolve(destination), target);
    if (relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
      throw new CLIError(
        `Remote package escaped its destination: ${file.path}`,
        "OPERATION_FAILED",
      );
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, { flag: "wx" });
  }
  return bundle.releaseAuthority;
}
