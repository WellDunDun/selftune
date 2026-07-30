import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Duration, Effect, Schema } from "effect";

import { computeSkillVersionHash } from "./hash.js";
import { assertImmutablePackageTree, libraryPackagePath, libraryPackagesDir } from "./storage.js";
import type { SkillSetServiceOptions } from "./types.js";
import type { SkillsShCatalogEntry, SkillsShCatalogFetch } from "./skills-sh-catalog.js";

const REQUEST_TIMEOUT = Duration.seconds(10);
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_CONTENT_BYTES = 5 * 1024 * 1024;
const MAX_FILE_CONTENT_BYTES = 1024 * 1024;
const MAX_FILES = 128;
const MAX_PATH_BYTES = 1024;

const SkillsShWireFile = Schema.Struct({
  path: Schema.String,
  contents: Schema.String,
  type: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
});

const SkillsShWireDownload = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
  slug: Schema.optionalKey(Schema.String),
  hash: Schema.optionalKey(Schema.NullOr(Schema.String)),
  files: Schema.NullOr(Schema.Array(SkillsShWireFile)),
});

export class SkillsShCatalogFetchError extends Schema.TaggedErrorClass<SkillsShCatalogFetchError>()(
  "SkillsShCatalogFetchError",
  { message: Schema.String },
) {}

export class SkillsShCatalogDownloadHttpError extends Schema.TaggedErrorClass<SkillsShCatalogDownloadHttpError>()(
  "SkillsShCatalogDownloadHttpError",
  { status: Schema.Number, message: Schema.String },
) {}

export class SkillsShCatalogDownloadDecodeError extends Schema.TaggedErrorClass<SkillsShCatalogDownloadDecodeError>()(
  "SkillsShCatalogDownloadDecodeError",
  { message: Schema.String },
) {}

export class SkillsShCatalogIntegrityError extends Schema.TaggedErrorClass<SkillsShCatalogIntegrityError>()(
  "SkillsShCatalogIntegrityError",
  { message: Schema.String },
) {}

export class SkillsShCatalogPathError extends Schema.TaggedErrorClass<SkillsShCatalogPathError>()(
  "SkillsShCatalogPathError",
  { path: Schema.String, message: Schema.String },
) {}

export class SkillsShCatalogStorageError extends Schema.TaggedErrorClass<SkillsShCatalogStorageError>()(
  "SkillsShCatalogStorageError",
  { path: Schema.String, message: Schema.String },
) {}

export type SkillsShCatalogMaterializationError =
  | SkillsShCatalogFetchError
  | SkillsShCatalogDownloadHttpError
  | SkillsShCatalogDownloadDecodeError
  | SkillsShCatalogIntegrityError
  | SkillsShCatalogPathError
  | SkillsShCatalogStorageError;

export type SkillsShCatalogMaterializationProgress =
  | { readonly stage: "fetching"; readonly catalog_id: string }
  | { readonly stage: "validating"; readonly catalog_id: string }
  | {
      readonly stage: "staging";
      readonly catalog_id: string;
      readonly file_count: number;
      readonly total_bytes: number;
    }
  | {
      readonly stage: "complete";
      readonly catalog_id: string;
      readonly package_path: string;
      readonly reused: boolean;
    };

export interface SkillsShCatalogMaterializeInput {
  readonly name: string;
  readonly catalog_id: string;
  readonly source: string;
  readonly install_spec: string;
  readonly download_url: string;
}

export interface SkillsShCatalogMaterializeOptions extends SkillSetServiceOptions {
  readonly fetcher?: SkillsShCatalogFetch;
  readonly onProgress?: (progress: SkillsShCatalogMaterializationProgress) => void;
}

export interface SkillsShCatalogMaterialization {
  readonly name: string;
  readonly display_name: string;
  readonly package_path: string;
  readonly content_hash: string;
  readonly upstream_revision: string | null;
  readonly catalog_hash: string | null;
  readonly catalog_hash_verified: false;
  readonly file_count: number;
  readonly total_bytes: number;
  readonly reused: boolean;
}

interface ValidatedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function report(
  options: SkillsShCatalogMaterializeOptions,
  progress: SkillsShCatalogMaterializationProgress,
): void {
  options.onProgress?.(progress);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function validatedDownloadUrl(
  input: SkillsShCatalogMaterializeInput,
): Effect.Effect<URL, SkillsShCatalogPathError> {
  return Effect.try({
    try: () => {
      const url = new URL(input.download_url);
      const isPublicCatalog =
        url.protocol === "https:" && url.hostname === "skills.sh" && url.port === "";
      const isLocalFixture = url.protocol === "http:" && isLoopback(url.hostname);
      if (!isPublicCatalog && !isLocalFixture) {
        throw new Error(
          "Catalog downloads must use skills.sh HTTPS (HTTP is allowed only for loopback)",
        );
      }
      if (url.username || url.password || url.search || url.hash) {
        throw new Error("Catalog download URL cannot contain credentials, a query, or a fragment");
      }
      const source = input.source.split("/");
      const id = input.catalog_id.split("/");
      if (source.length !== 2 || id.length !== 3 || source[0] !== id[0] || source[1] !== id[1]) {
        throw new Error("Catalog ID must contain its exact source and one skill slug");
      }
      if (![...source, id[2] ?? ""].every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) {
        throw new Error("Catalog source and skill slug contain unsafe characters");
      }
      const expectedInstallSpec = `${input.source}@${id[2] ?? ""}`;
      if (input.install_spec !== expectedInstallSpec) {
        throw new Error("Catalog install spec does not match the requested catalog ID");
      }
      const expectedLegacyPath = `/api/download/${source.map(encodeURIComponent).join("/")}/${encodeURIComponent(id[2] ?? "")}`;
      if (url.pathname !== expectedLegacyPath) {
        throw new Error("Catalog download URL does not match the requested catalog ID");
      }
      return url;
    },
    catch: (cause) =>
      SkillsShCatalogPathError.make({ path: input.download_url, message: message(cause) }),
  });
}

const readBoundedResponse = Effect.fn("SkillsShCatalog.readBoundedDownload")(function* (
  response: Response,
) {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    return yield* SkillsShCatalogDownloadDecodeError.make({
      message: "Catalog download exceeds the 6 MiB response limit",
    });
  }
  return yield* Effect.tryPromise({
    try: async (signal) => {
      if (!response.body) return new Uint8Array();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      const abort = () => void reader.cancel("Catalog download interrupted");
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          // A stream reader must consume each chunk before requesting the next one.
          // eslint-disable-next-line no-await-in-loop
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            void reader.cancel("Catalog download exceeded response limit");
            throw new Error("Catalog download exceeds the 6 MiB response limit");
          }
          chunks.push(next.value);
        }
      } finally {
        signal.removeEventListener("abort", abort);
      }
      const output = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return output;
    },
    catch: (cause) => SkillsShCatalogDownloadDecodeError.make({ message: message(cause) }),
  });
});

function safePackageName(slug: string): Effect.Effect<string, SkillsShCatalogPathError> {
  const value = slug.trim();
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    return Effect.fail(
      SkillsShCatalogPathError.make({
        path: slug,
        message: "Catalog skill slug is not a safe local package name",
      }),
    );
  }
  return Effect.succeed(value);
}

function safeRelativePath(path: string): Effect.Effect<string, SkillsShCatalogPathError> {
  const normalized = path.normalize("NFC");
  const byteLength = new TextEncoder().encode(normalized).byteLength;
  const segments = normalized.split("/");
  const hasWindowsAlias = segments.some((segment) => {
    const base = segment.split(".")[0]?.toUpperCase() ?? "";
    return (
      /[:<>"|?*]/.test(segment) ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)
    );
  });
  const invalid =
    !normalized ||
    byteLength > MAX_PATH_BYTES ||
    normalized.includes("\0") ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    hasWindowsAlias ||
    segments.some((segment) => !segment || segment === "." || segment === "..");
  if (invalid) {
    return Effect.fail(
      SkillsShCatalogPathError.make({
        path,
        message: "Catalog file path must be a normalized, relative POSIX path",
      }),
    );
  }
  return Effect.succeed(normalized);
}

function isSymlinkLike(file: typeof SkillsShWireFile.Type): boolean {
  const type = file.type?.toLowerCase();
  const mode = typeof file.mode === "number" ? file.mode.toString(8) : file.mode;
  return (type !== undefined && type !== "file") || file.mode === 120000 || mode === "120000";
}

const validateFiles = Effect.fn("SkillsShCatalog.validateFiles")(function* (
  files: ReadonlyArray<typeof SkillsShWireFile.Type>,
) {
  if (files.length === 0 || files.length > MAX_FILES) {
    return yield* SkillsShCatalogDownloadDecodeError.make({
      message: `Catalog skill must contain between 1 and ${MAX_FILES} files`,
    });
  }
  const validated: ValidatedFile[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    const path = yield* safeRelativePath(file.path);
    if (isSymlinkLike(file)) {
      return yield* SkillsShCatalogPathError.make({
        path,
        message: "Catalog packages cannot contain symbolic links or non-file entries",
      });
    }
    const identity = path.toLocaleLowerCase("en-US");
    if (paths.has(identity)) {
      return yield* SkillsShCatalogPathError.make({
        path,
        message: "Catalog package contains duplicate or case-colliding file paths",
      });
    }
    paths.add(identity);
    const bytes = new TextEncoder().encode(file.contents);
    if (bytes.byteLength > MAX_FILE_CONTENT_BYTES) {
      return yield* SkillsShCatalogDownloadDecodeError.make({
        message: `Catalog file exceeds the 1 MiB content limit: ${path}`,
      });
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_CONTENT_BYTES) {
      return yield* SkillsShCatalogDownloadDecodeError.make({
        message: "Catalog package exceeds the 5 MiB total content limit",
      });
    }
    validated.push({ path, bytes });
  }
  if (!paths.has("skill.md")) {
    return yield* SkillsShCatalogPathError.make({
      path: "SKILL.md",
      message: "Catalog package must contain SKILL.md at its root",
    });
  }
  const exactRoot = validated.some((file) => file.path === "SKILL.md");
  if (!exactRoot) {
    return yield* SkillsShCatalogPathError.make({
      path: "SKILL.md",
      message: "Root skill manifest must use the exact path SKILL.md",
    });
  }
  return { files: validated, totalBytes };
});

function verifyCachedPackage(
  path: string,
  expectedHash: string,
): Effect.Effect<void, SkillsShCatalogIntegrityError> {
  return Effect.try({
    try: () => {
      assertImmutablePackageTree(path, "Cached catalog package");
      const actualHash = computeSkillVersionHash(join(path, "SKILL.md"));
      if (actualHash !== expectedHash) {
        throw new Error(`Cached catalog package failed canonical verification: ${path}`);
      }
    },
    catch: (cause) => SkillsShCatalogIntegrityError.make({ message: message(cause) }),
  });
}

const stagePackage = Effect.fn("SkillsShCatalog.stagePackage")(function* (
  name: string,
  files: ReadonlyArray<ValidatedFile>,
  options: SkillsShCatalogMaterializeOptions,
) {
  const stagingRoot = join(libraryPackagesDir(options), `.stage-${name}-${randomUUID()}`);
  yield* Effect.try({
    try: () => {
      mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
      for (const file of files) {
        const target = join(stagingRoot, ...file.path.split("/"));
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, file.bytes, { flag: "wx", mode: 0o600 });
      }
    },
    catch: (cause) =>
      SkillsShCatalogStorageError.make({ path: stagingRoot, message: message(cause) }),
  }).pipe(
    Effect.onError(() => Effect.sync(() => rmSync(stagingRoot, { recursive: true, force: true }))),
  );
  const contentHash = computeSkillVersionHash(join(stagingRoot, "SKILL.md"));
  if (!contentHash) {
    rmSync(stagingRoot, { recursive: true, force: true });
    return yield* SkillsShCatalogIntegrityError.make({
      message: "Could not compute the canonical revision of the staged catalog package",
    });
  }
  return { stagingRoot, contentHash };
});

/**
 * Downloads a catalog entry and atomically places it in SelfTune's immutable,
 * content-addressed Library. The upstream hash is retained as revision metadata,
 * but is not called verified because skills.sh does not publish its hash algorithm.
 */
export const materializeSkillsShCatalogEntry = Effect.fn("SkillsShCatalog.materialize")(function* (
  input: SkillsShCatalogMaterializeInput | SkillsShCatalogEntry,
  options: SkillsShCatalogMaterializeOptions = {},
) {
  report(options, { stage: "fetching", catalog_id: input.catalog_id });
  const url = yield* validatedDownloadUrl(input);
  const body = yield* Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        (options.fetcher ?? globalThis.fetch)(url, {
          headers: { Accept: "application/json", "User-Agent": "selftune-catalog" },
          signal,
        }),
      catch: (cause) => SkillsShCatalogFetchError.make({ message: message(cause) }),
    });
    if (!response.ok) {
      return yield* SkillsShCatalogDownloadHttpError.make({
        status: response.status,
        message: `Catalog download failed with HTTP ${response.status}`,
      });
    }
    return yield* readBoundedResponse(response);
  }).pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.catchTag("TimeoutError", () =>
      SkillsShCatalogFetchError.make({ message: "Catalog download timed out after 10 seconds" }),
    ),
  );

  report(options, { stage: "validating", catalog_id: input.catalog_id });
  const json = yield* Effect.try({
    try: (): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    catch: (cause) => SkillsShCatalogDownloadDecodeError.make({ message: message(cause) }),
  });
  const payload = yield* Schema.decodeUnknownEffect(SkillsShWireDownload)(json).pipe(
    Effect.mapError((cause) => SkillsShCatalogDownloadDecodeError.make({ message: cause.message })),
  );
  if (
    (payload.id !== undefined && payload.id !== input.catalog_id) ||
    (payload.source !== undefined && payload.source !== input.source) ||
    (payload.slug !== undefined && input.catalog_id !== `${input.source}/${payload.slug}`)
  ) {
    return yield* SkillsShCatalogIntegrityError.make({
      message: "Catalog download identity does not match the requested skill",
    });
  }
  if (!payload.files) {
    return yield* SkillsShCatalogDownloadDecodeError.make({
      message: "Catalog skill does not have a downloadable file snapshot",
    });
  }
  const catalogHash = payload.hash?.trim().toLowerCase() || null;
  if (catalogHash && !/^[a-f0-9]{64}$/.test(catalogHash)) {
    return yield* SkillsShCatalogDownloadDecodeError.make({
      message: "Catalog skill hash is not a SHA-256 hex digest",
    });
  }
  const name = yield* safePackageName(input.catalog_id.split("/").at(-1) ?? "");
  const validated = yield* validateFiles(payload.files);
  report(options, {
    stage: "staging",
    catalog_id: input.catalog_id,
    file_count: validated.files.length,
    total_bytes: validated.totalBytes,
  });
  const staged = yield* stagePackage(name, validated.files, options);
  const packagePath = libraryPackagePath(staged.contentHash, name, options);
  let reused = false;
  yield* Effect.gen(function* () {
    if (existsSync(packagePath)) {
      reused = true;
      return yield* verifyCachedPackage(packagePath, staged.contentHash);
    }
    yield* Effect.try({
      try: () => {
        mkdirSync(dirname(packagePath), { recursive: true, mode: 0o700 });
        renameSync(staged.stagingRoot, packagePath);
      },
      catch: (cause) =>
        SkillsShCatalogStorageError.make({ path: packagePath, message: message(cause) }),
    }).pipe(
      Effect.catchTag("SkillsShCatalogStorageError", (error) =>
        Effect.gen(function* () {
          if (!existsSync(packagePath)) return yield* Effect.fail(error);
          reused = true;
          return yield* verifyCachedPackage(packagePath, staged.contentHash);
        }),
      ),
    );
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => rmSync(staged.stagingRoot, { recursive: true, force: true })),
    ),
  );
  report(options, {
    stage: "complete",
    catalog_id: input.catalog_id,
    package_path: packagePath,
    reused,
  });
  return {
    name,
    display_name: input.name,
    package_path: packagePath,
    content_hash: staged.contentHash,
    upstream_revision: catalogHash,
    catalog_hash: catalogHash,
    catalog_hash_verified: false,
    file_count: validated.files.length,
    total_bytes: validated.totalBytes,
    reused,
  } satisfies SkillsShCatalogMaterialization;
});
