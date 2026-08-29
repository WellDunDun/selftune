import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const MEBIBYTE = 1024 * 1024;
const MAXIMUM_DIAGNOSTIC_MESSAGE_CHARACTERS = 320;
const MAXIMUM_DIAGNOSTIC_PATH_CHARACTERS = 160;
const MAXIMUM_DIAGNOSTIC_DETAIL_CHARACTERS = 240;

const DiagnosticMessage = Schema.String.check(
  Schema.isMaxLength(MAXIMUM_DIAGNOSTIC_MESSAGE_CHARACTERS),
);
const DiagnosticPath = Schema.String.check(Schema.isMaxLength(MAXIMUM_DIAGNOSTIC_PATH_CHARACTERS));
const DiagnosticDetail = Schema.String.check(
  Schema.isMaxLength(MAXIMUM_DIAGNOSTIC_DETAIL_CHARACTERS),
);

/** V1 preserves historical bundles whose file order was locale-dependent. */
export const LEGACY_PACKAGE_BUNDLE_VERSION = 1;
/** V2 requires code-unit path order so every conforming encoder emits the same bytes. */
export const CANONICAL_PACKAGE_BUNDLE_VERSION = 2;
/** Maximum container nesting accepted in release-authority evaluation JSON. */
export const MAXIMUM_RELEASE_AUTHORITY_EVALUATION_DEPTH = 64;

export interface PortablePackageBundleProfile {
  readonly name: "distribution" | "backup";
  readonly maximumEncodedPackageBytes: number;
  readonly maximumFileCount: number;
  readonly maximumDecodedFileBytes: number;
  readonly maximumDecodedPackageBytes: number;
}

export const DISTRIBUTION_PACKAGE_BUNDLE_PROFILE: PortablePackageBundleProfile = {
  name: "distribution",
  maximumEncodedPackageBytes: 25 * MEBIBYTE,
  maximumFileCount: 500,
  maximumDecodedFileBytes: 10 * MEBIBYTE,
  maximumDecodedPackageBytes: 25 * MEBIBYTE,
};

export const BACKUP_PACKAGE_BUNDLE_PROFILE: PortablePackageBundleProfile = {
  name: "backup",
  maximumEncodedPackageBytes: 50 * MEBIBYTE,
  maximumFileCount: 5_000,
  maximumDecodedFileBytes: 40 * MEBIBYTE,
  maximumDecodedPackageBytes: 40 * MEBIBYTE,
};

/** Backward-compatible name for the outward-distribution inspection limits. */
export const PACKAGE_BUNDLE_LIMITS = DISTRIBUTION_PACKAGE_BUNDLE_PROFILE;

export const PortablePackageBundleErrorReason = Schema.Literals([
  "encoded_package_too_large",
  "invalid_utf8",
  "invalid_json",
  "invalid_package",
  "duplicate_path",
  "missing_skill_manifest",
  "decoded_file_too_large",
  "decoded_package_too_large",
]);
export type PortablePackageBundleErrorReason = typeof PortablePackageBundleErrorReason.Type;

export class PortablePackageBundleError extends Schema.TaggedErrorClass<PortablePackageBundleError>()(
  "PortablePackageBundleError",
  {
    reason: PortablePackageBundleErrorReason,
    message: DiagnosticMessage,
    path: Schema.optionalKey(DiagnosticPath),
    detail: Schema.optionalKey(DiagnosticDetail),
  },
) {}

export interface PortablePackageFile {
  readonly path: string;
  readonly content: Uint8Array;
}

export class PortablePackageReleaseAuthority extends Schema.Class<PortablePackageReleaseAuthority>(
  "PortablePackageReleaseAuthority",
)({
  schema_version: Schema.Literal(1),
  candidate_id: Schema.String,
  evidence_snapshot_id: Schema.String,
  candidate_revision_hash: Schema.String,
  skill_name: Schema.String,
  draft_path: Schema.String,
  revision_hash: Schema.String,
  evaluated_at: Schema.String,
  replay_exit_code: Schema.Number,
  baseline_exit_code: Schema.Number,
  held_out_eval_ids: Schema.Array(Schema.String),
  recommended: Schema.Boolean,
  blockers: Schema.Array(Schema.String),
  evaluation: Schema.Json,
}) {}

export interface PortablePackageBundle {
  readonly version: 1 | 2;
  readonly files: ReadonlyArray<PortablePackageFile>;
  readonly releaseAuthority?: PortablePackageReleaseAuthority;
}

export interface PortablePackageBundleInput {
  readonly files: ReadonlyArray<PortablePackageFile>;
  readonly releaseAuthority?: PortablePackageReleaseAuthority;
}

// oxlint-disable-next-line no-control-regex -- portable paths reject ASCII control bytes.
const WINDOWS_FORBIDDEN_PATH_CHARACTER = /[<>:"|?*\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED_PATH_SEGMENT =
  /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;
const NON_PORTABLE_ASCII_PATH_CHARACTER = /[^\x20-\x7e]/;

function safeNormalizedRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    // Filesystems do not agree on Unicode normalization and case folding.
    // The portable distribution format therefore uses printable ASCII paths;
    // adapters may retain broader names in private, non-distributed storage.
    NON_PORTABLE_ASCII_PATH_CHARACTER.test(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !WINDOWS_FORBIDDEN_PATH_CHARACTER.test(segment) &&
      !WINDOWS_RESERVED_PATH_SEGMENT.test(segment) &&
      !/[ .]$/.test(segment),
  );
}

function portablePathIdentity(path: string): string {
  // A validated bundle must materialize to one file set on case-insensitive
  // and normalization-insensitive filesystems as well as Linux.
  return path.toLowerCase();
}

export const PortablePackagePath = Schema.String.check(
  Schema.makeFilter(
    safeNormalizedRelativePath,
    { message: "Expected a safe normalized relative package path" },
    true,
  ),
);

function strictBase64Syntax(content: string): boolean {
  if (content.length % 4 !== 0) return false;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    const alphaNumeric =
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (alphaNumeric || code === 43 || code === 47) continue;
    if (code !== 61 || index < content.length - 2) return false;
    if (index === content.length - 2 && content.charCodeAt(index + 1) !== 61) return false;
  }
  return true;
}

const StrictBase64 = Schema.String.check(
  Schema.makeFilter(
    strictBase64Syntax,
    { message: "Expected canonical base64 file content" },
    true,
  ),
);

const EncodedPortablePackageFile = Schema.Struct({
  path: PortablePackagePath,
  contentBase64: StrictBase64,
});

const EncodedPortablePackageBundleV1 = Schema.Struct({
  version: Schema.Literal(LEGACY_PACKAGE_BUNDLE_VERSION),
  files: Schema.Array(EncodedPortablePackageFile),
  releaseAuthority: Schema.optionalKey(PortablePackageReleaseAuthority),
});

const EncodedPortablePackageBundleV2 = Schema.Struct({
  version: Schema.Literal(CANONICAL_PACKAGE_BUNDLE_VERSION),
  files: Schema.Array(EncodedPortablePackageFile),
  releaseAuthority: Schema.optionalKey(PortablePackageReleaseAuthority),
});

const EncodedPortablePackageBundle = Schema.Union([
  EncodedPortablePackageBundleV1,
  EncodedPortablePackageBundleV2,
]);

const PortablePackageFileInputSchema = Schema.Struct({
  path: PortablePackagePath,
  content: Schema.Uint8Array,
});

const PortablePackageBundleInputSchema = Schema.Struct({
  files: Schema.Array(PortablePackageFileInputSchema),
  releaseAuthority: Schema.optionalKey(PortablePackageReleaseAuthority),
});

const PackageBundleCardinality = Schema.Struct({
  files: Schema.Array(Schema.Unknown),
});
const PackageBundleReleaseAuthorityPreflight = Schema.Struct({
  releaseAuthority: Schema.Struct({
    evaluation: Schema.Unknown,
  }),
});
const TraversableContainer = Schema.Union([
  Schema.Array(Schema.Unknown),
  Schema.Record(Schema.String, Schema.Unknown),
]);
const JsonObject = Schema.Record(Schema.String, Schema.Json);
const decodePackageBundleCardinality = Schema.decodeUnknownOption(PackageBundleCardinality);
const decodePackageBundleReleaseAuthorityPreflight = Schema.decodeUnknownOption(
  PackageBundleReleaseAuthorityPreflight,
);
const isTraversableContainer = Schema.is(TraversableContainer);
const isJsonArray = Schema.is(Schema.Array(Schema.Json));
const isJsonObject = Schema.is(JsonObject);
const decodeJsonText = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

interface PortablePackageBundleErrorFields {
  reason: PortablePackageBundleErrorReason;
  message: string;
  path?: string;
  detail?: string;
}

const invalid = (
  reason: PortablePackageBundleErrorReason,
  message: string,
  path?: string,
  detail?: string,
) => {
  const fields: PortablePackageBundleErrorFields = {
    reason,
    message: bounded(message, MAXIMUM_DIAGNOSTIC_MESSAGE_CHARACTERS),
  };
  if (path) fields.path = bounded(path, MAXIMUM_DIAGNOSTIC_PATH_CHARACTERS);
  if (detail) fields.detail = bounded(detail, MAXIMUM_DIAGNOSTIC_DETAIL_CHARACTERS);
  return PortablePackageBundleError.make(fields);
};

const schemaIssueFormatter = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => {
    switch (issue._tag) {
      case "InvalidType":
        return "Value has an invalid type";
      case "InvalidValue":
        return "Value is invalid";
      case "MissingKey":
        return "Required value is missing";
      case "UnexpectedKey":
        return "Unexpected value is present";
      case "Forbidden":
        return "Value is forbidden";
      case "OneOf":
        return "Value does not match exactly one schema member";
    }
  },
  checkHook: () => "Value does not satisfy the package constraint",
});

function bounded(value: string, maximumCharacters: number): string {
  return value.length <= maximumCharacters ? value : `${value.slice(0, maximumCharacters - 1)}…`;
}

interface SchemaDiagnostic {
  path?: string;
  detail?: string;
}

const KeyedPathSegment = Schema.Struct({ key: Schema.PropertyKey });
const isKeyedPathSegment = Schema.is(KeyedPathSegment);

function pathSegmentKey(segment: PropertyKey | typeof KeyedPathSegment.Type): PropertyKey {
  return isKeyedPathSegment(segment) ? segment.key : segment;
}

function schemaDiagnostic(error: Schema.SchemaError): SchemaDiagnostic {
  const issues = schemaIssueFormatter(error.issue).issues;
  const issue =
    issues.find((candidate) =>
      candidate.path?.some((segment) => pathSegmentKey(segment) === "files"),
    ) ?? issues[0];
  if (!issue) return {};
  const path = issue.path?.map((segment) => String(pathSegmentKey(segment))).join(".");
  const diagnostic: SchemaDiagnostic = {
    detail: bounded(issue.message, MAXIMUM_DIAGNOSTIC_DETAIL_CHARACTERS),
  };
  if (path) diagnostic.path = bounded(path, MAXIMUM_DIAGNOSTIC_PATH_CHARACTERS);
  return diagnostic;
}

function invalidSchema(error: Schema.SchemaError, message: string) {
  const diagnostic = schemaDiagnostic(error);
  return invalid("invalid_package", message, diagnostic.path, diagnostic.detail);
}

function formatByteLimit(bytes: number): string {
  return Number.isInteger(bytes / MEBIBYTE) ? `${bytes / MEBIBYTE} MiB` : `${bytes} bytes`;
}

function decodedBase64Length(contentBase64: string): number {
  const padding = contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0;
  return (contentBase64.length / 4) * 3 - padding;
}

function validateManifestAndDuplicates(
  files: ReadonlyArray<{ readonly path: string }>,
): Effect.Effect<void, PortablePackageBundleError> {
  const paths = new Set<string>();
  for (const file of files) {
    const identity = portablePathIdentity(file.path);
    if (paths.has(identity)) {
      return Effect.fail(
        invalid(
          "duplicate_path",
          `Package bundle contains a cross-platform path collision: ${file.path}`,
        ),
      );
    }
    paths.add(identity);
  }
  for (const file of files) {
    const identity = portablePathIdentity(file.path);
    let separator = identity.indexOf("/");
    while (separator !== -1) {
      const ancestor = identity.slice(0, separator);
      if (paths.has(ancestor)) {
        return Effect.fail(
          invalid(
            "duplicate_path",
            `Package bundle contains a file/descendant path collision: ${file.path}`,
          ),
        );
      }
      separator = identity.indexOf("/", separator + 1);
    }
  }
  if (!files.some((file) => file.path === "SKILL.md")) {
    return Effect.fail(
      invalid("missing_skill_manifest", "Package bundle must contain root SKILL.md"),
    );
  }
  return Effect.void;
}

function validateCanonicalFileOrder(
  version: 1 | 2,
  files: ReadonlyArray<{ readonly path: string }>,
): Effect.Effect<void, PortablePackageBundleError> {
  if (version === 1) return Effect.void;
  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1];
    const current = files[index];
    if (previous && current && previous.path >= current.path) {
      return Effect.fail(
        invalid("invalid_package", "Version 2 package files must use canonical path order"),
      );
    }
  }
  return Effect.void;
}

function validateDecodedSizes(
  files: ReadonlyArray<{
    readonly path: string;
    readonly contentBase64: string;
  }>,
  profile: PortablePackageBundleProfile,
): Effect.Effect<void, PortablePackageBundleError> {
  let total = 0;
  for (const file of files) {
    const decodedLength = decodedBase64Length(file.contentBase64);
    if (decodedLength > profile.maximumDecodedFileBytes) {
      return Effect.fail(
        invalid(
          "decoded_file_too_large",
          `Decoded package file exceeds ${formatByteLimit(profile.maximumDecodedFileBytes)}`,
          file.path,
        ),
      );
    }
    total += decodedLength;
    if (total > profile.maximumDecodedPackageBytes) {
      return Effect.fail(
        invalid(
          "decoded_package_too_large",
          `Decoded package content exceeds ${formatByteLimit(profile.maximumDecodedPackageBytes)}`,
          file.path,
        ),
      );
    }
  }
  return Effect.void;
}

function validateRawFileSizes(
  files: ReadonlyArray<PortablePackageFile>,
  profile: PortablePackageBundleProfile,
): Effect.Effect<void, PortablePackageBundleError> {
  let total = 0;
  for (const file of files) {
    if (file.content.byteLength > profile.maximumDecodedFileBytes) {
      return Effect.fail(
        invalid(
          "decoded_file_too_large",
          `Decoded package file exceeds ${formatByteLimit(profile.maximumDecodedFileBytes)}`,
          file.path,
        ),
      );
    }
    total += file.content.byteLength;
    if (total > profile.maximumDecodedPackageBytes) {
      return Effect.fail(
        invalid(
          "decoded_package_too_large",
          `Decoded package content exceeds ${formatByteLimit(profile.maximumDecodedPackageBytes)}`,
          file.path,
        ),
      );
    }
  }
  return Effect.void;
}

function canonicalizeJson(value: Schema.Json): Schema.Json {
  if (isJsonArray(value)) return value.map(canonicalizeJson);
  if (!isJsonObject(value)) return value;
  const canonical: Array<readonly [string, Schema.Json]> = [];
  // oxlint-disable-next-line unicorn/no-array-sort -- sorting a new key array cannot mutate input.
  for (const key of Object.keys(value).sort()) {
    canonical.push([key, canonicalizeJson(value[key])]);
  }
  return Object.fromEntries(canonical);
}

function canonicalizeReleaseAuthority(
  authority: PortablePackageReleaseAuthority,
): PortablePackageReleaseAuthority {
  return PortablePackageReleaseAuthority.make({
    schema_version: authority.schema_version,
    candidate_id: authority.candidate_id,
    evidence_snapshot_id: authority.evidence_snapshot_id,
    candidate_revision_hash: authority.candidate_revision_hash,
    skill_name: authority.skill_name,
    draft_path: authority.draft_path,
    revision_hash: authority.revision_hash,
    evaluated_at: authority.evaluated_at,
    replay_exit_code: authority.replay_exit_code,
    baseline_exit_code: authority.baseline_exit_code,
    held_out_eval_ids: authority.held_out_eval_ids,
    recommended: authority.recommended,
    blockers: authority.blockers,
    evaluation: canonicalizeJson(authority.evaluation),
  });
}

function hasTooManyFiles<Input>(input: Input, profile: PortablePackageBundleProfile): boolean {
  const cardinality = decodePackageBundleCardinality(input);
  return Option.isSome(cardinality) && cardinality.value.files.length > profile.maximumFileCount;
}

const preflightReleaseAuthorityEvaluation = Effect.fn("preflightReleaseAuthorityEvaluation")(
  function* <Input>(input: Input) {
    const preflight = decodePackageBundleReleaseAuthorityPreflight(input);
    if (Option.isNone(preflight)) return;
    const evaluation = preflight.value.releaseAuthority.evaluation;
    if (!isTraversableContainer(evaluation)) return;

    type Frame = {
      readonly value: typeof TraversableContainer.Type;
      readonly depth: number;
      readonly exiting: boolean;
    };
    const active = new WeakSet<object>();
    const stack: Array<Frame> = [{ value: evaluation, depth: 1, exiting: false }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) continue;
      if (frame.exiting) {
        active.delete(frame.value);
        continue;
      }
      if (frame.depth > MAXIMUM_RELEASE_AUTHORITY_EVALUATION_DEPTH || active.has(frame.value)) {
        return yield* invalid(
          "invalid_package",
          `Release authority evaluation exceeds ${MAXIMUM_RELEASE_AUTHORITY_EVALUATION_DEPTH} JSON levels or contains a cycle`,
          "releaseAuthority.evaluation",
        );
      }
      active.add(frame.value);
      stack.push({ ...frame, exiting: true });

      const children = Array.isArray(frame.value) ? frame.value : Object.values(frame.value);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (isTraversableContainer(child)) {
          stack.push({ value: child, depth: frame.depth + 1, exiting: false });
        }
      }
    }
  },
);

const decodeEncodedPackageBundle = Effect.fn("decodeEncodedPortablePackageBundle")(function* <
  Input,
>(input: Input, profile: PortablePackageBundleProfile) {
  yield* preflightReleaseAuthorityEvaluation(input);
  if (hasTooManyFiles(input, profile)) {
    return yield* invalid(
      "invalid_package",
      `Package bundle contains more than ${profile.maximumFileCount} files`,
      "files",
    );
  }
  return yield* Schema.decodeUnknownEffect(EncodedPortablePackageBundle)(input, {
    errors: "all",
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((error) =>
      invalidSchema(error, "Package bundle does not match the portable bundle schema"),
    ),
  );
});

const decodePortablePackageBundleData = Effect.fn("decodePortablePackageBundleData")(function* <
  Input,
>(input: Input, profile: PortablePackageBundleProfile) {
  const encoded = yield* decodeEncodedPackageBundle(input, profile);
  yield* validateManifestAndDuplicates(encoded.files);
  yield* validateCanonicalFileOrder(encoded.version, encoded.files);
  yield* validateDecodedSizes(encoded.files, profile);

  const files = yield* Effect.forEach(encoded.files, (file) =>
    Effect.fromResult(Encoding.decodeBase64(file.contentBase64)).pipe(
      Effect.filterOrFail(
        (content) => Encoding.encodeBase64(content) === file.contentBase64,
        () => invalid("invalid_package", `Package file is not canonical base64: ${file.path}`),
      ),
      Effect.mapError(() =>
        invalid("invalid_package", `Package file is not valid base64: ${file.path}`),
      ),
      Effect.map((content) => ({ path: file.path, content })),
    ),
  );
  const bundle: PortablePackageBundle = {
    version: encoded.version,
    files,
  };
  return encoded.releaseAuthority
    ? { ...bundle, releaseAuthority: encoded.releaseAuthority }
    : bundle;
});

export const decodePortablePackageBundle = Effect.fn("decodePortablePackageBundle")(function* (
  bytes: Uint8Array,
  profile: PortablePackageBundleProfile = DISTRIBUTION_PACKAGE_BUNDLE_PROFILE,
) {
  if (bytes.byteLength > profile.maximumEncodedPackageBytes) {
    return yield* invalid(
      "encoded_package_too_large",
      `Encoded package JSON exceeds ${formatByteLimit(profile.maximumEncodedPackageBytes)}`,
    );
  }

  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => invalid("invalid_utf8", "Package bundle is not valid UTF-8"),
  });
  const parsed = yield* decodeJsonText(text).pipe(
    Effect.mapError(() => invalid("invalid_json", "Package bundle is not valid JSON")),
  );
  return yield* decodePortablePackageBundleData(parsed, profile);
});

/**
 * Distribution boundary decoder: accepts only the one byte representation
 * emitted by the canonical V2 encoder, including nested authority JSON order.
 */
export const decodeCanonicalPortablePackageBundleV2 = Effect.fn(
  "decodeCanonicalPortablePackageBundleV2",
)(function* (
  bytes: Uint8Array,
  profile: PortablePackageBundleProfile = DISTRIBUTION_PACKAGE_BUNDLE_PROFILE,
) {
  const decoded = yield* decodePortablePackageBundle(bytes, profile);
  if (decoded.version !== CANONICAL_PACKAGE_BUNDLE_VERSION) {
    return yield* invalid(
      "invalid_package",
      "Canonical distribution packages must use package bundle version 2",
    );
  }
  const canonicalInput: PortablePackageBundleInput = { files: decoded.files };
  const canonicalBytes = yield* encodePortablePackageBundle(
    decoded.releaseAuthority
      ? { ...canonicalInput, releaseAuthority: decoded.releaseAuthority }
      : canonicalInput,
    profile,
  );
  if (
    canonicalBytes.byteLength !== bytes.byteLength ||
    canonicalBytes.some((byte, index) => byte !== bytes[index])
  ) {
    return yield* invalid(
      "invalid_package",
      "Package bytes do not match the canonical version 2 encoding",
    );
  }
  return decoded;
});

/** Plain synchronous decoder boundary for hosts on a different Effect major. */
export function decodePortablePackageBundleSync(
  bytes: Uint8Array,
  profile: PortablePackageBundleProfile = DISTRIBUTION_PACKAGE_BUNDLE_PROFILE,
): PortablePackageBundle {
  return Effect.runSync(decodePortablePackageBundle(bytes, profile));
}

function comparePaths(left: PortablePackageFile, right: PortablePackageFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export const encodePortablePackageBundleUnknown = Effect.fn("encodePortablePackageBundle")(
  function* <Input>(
    input: Input,
    profile: PortablePackageBundleProfile = DISTRIBUTION_PACKAGE_BUNDLE_PROFILE,
  ) {
    yield* preflightReleaseAuthorityEvaluation(input);
    if (hasTooManyFiles(input, profile)) {
      return yield* invalid(
        "invalid_package",
        `Package bundle contains more than ${profile.maximumFileCount} files`,
        "files",
      );
    }
    const bundle = yield* Schema.decodeUnknownEffect(PortablePackageBundleInputSchema)(input, {
      errors: "all",
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError((error) =>
        invalidSchema(error, "Package input does not match the portable bundle schema"),
      ),
    );
    yield* validateRawFileSizes(bundle.files, profile);

    // oxlint-disable-next-line unicorn/no-array-sort -- the spread creates an encoder-owned array.
    const encodedFiles = [...bundle.files].sort(comparePaths).map((file) => ({
      path: file.path,
      contentBase64: Encoding.encodeBase64(file.content),
    }));
    const encodedBundle = {
      version: CANONICAL_PACKAGE_BUNDLE_VERSION,
      files: encodedFiles,
    };
    const encoded = bundle.releaseAuthority
      ? {
          ...encodedBundle,
          releaseAuthority: canonicalizeReleaseAuthority(bundle.releaseAuthority),
        }
      : encodedBundle;

    yield* decodeEncodedPackageBundle(encoded, profile);
    yield* validateManifestAndDuplicates(encodedFiles);
    yield* validateDecodedSizes(encodedFiles, profile);

    const bytes = new TextEncoder().encode(JSON.stringify(encoded));
    if (bytes.byteLength > profile.maximumEncodedPackageBytes) {
      return yield* invalid(
        "encoded_package_too_large",
        `Encoded package JSON exceeds ${formatByteLimit(profile.maximumEncodedPackageBytes)}`,
      );
    }
    return bytes;
  },
);

export const encodePortablePackageBundle: (
  bundle: PortablePackageBundleInput,
  profile?: PortablePackageBundleProfile,
) => Effect.Effect<Uint8Array, PortablePackageBundleError> = encodePortablePackageBundleUnknown;

/**
 * Plain synchronous boundary for hosts that do not share the control plane's
 * Effect major version. The canonical encoder remains the single authority;
 * callers receive the same V2 bytes and validation as Effect-native callers.
 */
export function encodePortablePackageBundleSync(
  bundle: PortablePackageBundleInput,
  profile: PortablePackageBundleProfile = DISTRIBUTION_PACKAGE_BUNDLE_PROFILE,
): Uint8Array {
  return Effect.runSync(encodePortablePackageBundle(bundle, profile));
}
