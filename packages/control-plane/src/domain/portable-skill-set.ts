import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  CANONICAL_PACKAGE_BUNDLE_VERSION,
  decodeCanonicalPortablePackageBundleV2,
  PortablePackagePath,
  type PortablePackageBundle,
} from "./package-bundle";

const MEBIBYTE = 1024 * 1024;

export const SKILL_SET_SOURCE_MANIFEST_FORMAT = "selftune-skill-set-source-v1" as const;
export const CANONICAL_SKILL_SET_SOURCE_MANIFEST_VERSION = 1 as const;
export const MAXIMUM_SKILL_SET_COMPONENTS = 500;
export const MAXIMUM_SKILL_SET_SOURCE_MANIFEST_BYTES = 1 * MEBIBYTE;
export const PORTABLE_SKILL_SET_ENVELOPE_FORMAT = "selftune-portable-skill-set-v1" as const;
export const PORTABLE_SKILL_SET_ENVELOPE_VERSION = 1 as const;
/** Cloudflare's request ceiling is the final authority for the portable object. */
export const MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES = 25 * MEBIBYTE;
/** Leaves one MiB for the root manifest, terms, hashes, and JSON structure. */
export const MAXIMUM_PORTABLE_SKILL_SET_EMBEDDED_PACKAGE_BYTES = 24 * MEBIBYTE;
/** Leaves base64 and envelope headroom while bounding decoded aggregate expansion. */
export const MAXIMUM_PORTABLE_SKILL_SET_DECODED_CONTENT_BYTES = 16 * MEBIBYTE;

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const SkillSetId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const LogicalSkillId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const DisplayName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Description = Schema.String.check(Schema.isMaxLength(4_000));
const Harness = Schema.Literals(["claude_code", "codex", "opencode", "openclaw", "pi"]);
const Ordinal = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

export const PortableSkillSetErrorReason = Schema.Literals([
  "encoded_manifest_too_large",
  "invalid_utf8",
  "invalid_json",
  "invalid_manifest",
  "component_count_exceeded",
  "component_identity_collision",
  "hash_mismatch",
  "encoded_envelope_too_large",
  "embedded_packages_too_large",
  "decoded_content_too_large",
  "source_binding_mismatch",
  "invalid_component_package",
  "invalid_terms",
]);
export type PortableSkillSetErrorReason = typeof PortableSkillSetErrorReason.Type;

export class PortableSkillSetError extends Schema.TaggedErrorClass<PortableSkillSetError>()(
  "PortableSkillSetError",
  {
    reason: PortableSkillSetErrorReason,
    message: Schema.String.check(Schema.isMaxLength(320)),
  },
) {}

export class CanonicalSkillSetSourceComponent extends Schema.Class<CanonicalSkillSetSourceComponent>(
  "CanonicalSkillSetSourceComponent",
)({
  ordinal: Ordinal,
  logicalSkillId: LogicalSkillId,
  sourceRevisionSha256: Sha256,
  sourcePackageObjectSha256: Sha256,
}) {}

const CanonicalSkillSetSourceManifestInput = Schema.Struct({
  skillSetId: SkillSetId,
  name: DisplayName,
  description: Description,
  harnesses: Schema.Array(Harness),
  components: Schema.Array(CanonicalSkillSetSourceComponent),
});

export class CanonicalSkillSetSourceManifest extends Schema.Class<CanonicalSkillSetSourceManifest>(
  "CanonicalSkillSetSourceManifest",
)({
  format: Schema.Literal(SKILL_SET_SOURCE_MANIFEST_FORMAT),
  version: Schema.Literal(CANONICAL_SKILL_SET_SOURCE_MANIFEST_VERSION),
  skillSetId: SkillSetId,
  name: DisplayName,
  description: Description,
  harnesses: Schema.Array(Harness),
  bomSha256: Sha256,
  skillSetRevisionSha256: Sha256,
  components: Schema.Array(CanonicalSkillSetSourceComponent),
}) {}

export interface CanonicalSkillSetSourceManifestEncoding {
  readonly bytes: Uint8Array;
  readonly manifest: CanonicalSkillSetSourceManifest;
  readonly skillSetRevisionSha256: string;
  readonly sourceManifestObjectSha256: string;
}

const TermsPathHash = Schema.Struct({
  path: PortablePackagePath,
  sha256: Sha256,
});

const PortableSkillSetComponentTermsInput = Schema.Struct({
  licenseExpression: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  licenseFilePath: Schema.optionalKey(PortablePackagePath),
  noticePaths: Schema.Array(PortablePackagePath),
});

export class PortableSkillSetComponentTerms extends Schema.Class<PortableSkillSetComponentTerms>(
  "PortableSkillSetComponentTerms",
)({
  licenseExpression: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  licenseFile: Schema.NullOr(TermsPathHash),
  notices: Schema.Array(TermsPathHash),
}) {}

const PortableSkillSetEnvelopeComponentInput = Schema.Struct({
  ordinal: Ordinal,
  logicalSkillId: LogicalSkillId,
  sourceRevisionSha256: Sha256,
  sourcePackageObjectSha256: Sha256,
  sealedPackageBytes: Schema.Uint8Array,
  terms: PortableSkillSetComponentTermsInput,
});

const PortableSkillSetEnvelopeInput = Schema.Struct({
  sourceManifestBytes: Schema.Uint8Array,
  components: Schema.Array(PortableSkillSetEnvelopeComponentInput),
});
const PortableSkillSetEnvelopeCardinality = Schema.Struct({
  components: Schema.Array(Schema.Unknown),
});
const decodePortableSkillSetEnvelopeCardinality = Schema.decodeUnknownOption(
  PortableSkillSetEnvelopeCardinality,
);
const decodeJsonText = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

export class PortableSkillSetEnvelopeComponent extends Schema.Class<PortableSkillSetEnvelopeComponent>(
  "PortableSkillSetEnvelopeComponent",
)({
  ordinal: Ordinal,
  logicalSkillId: LogicalSkillId,
  sourceRevisionSha256: Sha256,
  sourcePackageObjectSha256: Sha256,
  sealedPackageObjectSha256: Sha256,
  terms: PortableSkillSetComponentTerms,
  package: Schema.Json,
}) {}

export class PortableSkillSetEnvelope extends Schema.Class<PortableSkillSetEnvelope>(
  "PortableSkillSetEnvelope",
)({
  format: Schema.Literal(PORTABLE_SKILL_SET_ENVELOPE_FORMAT),
  version: Schema.Literal(PORTABLE_SKILL_SET_ENVELOPE_VERSION),
  sourceManifestObjectSha256: Sha256,
  skillSetRevisionSha256: Sha256,
  sourceBomSha256: Sha256,
  sourceManifest: CanonicalSkillSetSourceManifest,
  packagedBomSha256: Sha256,
  components: Schema.Array(PortableSkillSetEnvelopeComponent),
}) {}

export interface PortableSkillSetEnvelopeEncoding {
  readonly bytes: Uint8Array;
  readonly envelope: PortableSkillSetEnvelope;
  readonly sourceManifestObjectSha256: string;
  readonly portableSkillSetEnvelopeSha256: string;
  readonly components: ReadonlyArray<{
    readonly sealedPackageObjectSha256: string;
    readonly package: PortablePackageBundle;
  }>;
}

function invalid(reason: PortableSkillSetErrorReason, message: string): PortableSkillSetError {
  return PortableSkillSetError.make({ reason, message: message.slice(0, 320) });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes<Value>(value: Value): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalComponents(
  components: ReadonlyArray<CanonicalSkillSetSourceComponent>,
): ReadonlyArray<CanonicalSkillSetSourceComponent> {
  // oxlint-disable-next-line unicorn/no-array-sort -- the spread creates an encoder-owned array.
  return [...components].sort((left, right) => left.ordinal - right.ordinal);
}

function validateComponentBom(
  components: ReadonlyArray<CanonicalSkillSetSourceComponent>,
): Effect.Effect<void, PortableSkillSetError> {
  if (components.length === 0 || components.length > MAXIMUM_SKILL_SET_COMPONENTS) {
    return Effect.fail(
      invalid(
        "component_count_exceeded",
        `Skill Set manifests require 1-${MAXIMUM_SKILL_SET_COMPONENTS} components`,
      ),
    );
  }
  const logicalIds = new Set<string>();
  const objectHashes = new Set<string>();
  for (const [ordinal, component] of components.entries()) {
    if (component.ordinal !== ordinal) {
      return Effect.fail(
        invalid("invalid_manifest", "Component ordinals must be contiguous and zero-based"),
      );
    }
    if (
      logicalIds.has(component.logicalSkillId) ||
      objectHashes.has(component.sourcePackageObjectSha256)
    ) {
      return Effect.fail(
        invalid(
          "component_identity_collision",
          "Component logical ids and package object hashes must be unique",
        ),
      );
    }
    logicalIds.add(component.logicalSkillId);
    objectHashes.add(component.sourcePackageObjectSha256);
  }
  return Effect.void;
}

function bomIdentity(components: ReadonlyArray<CanonicalSkillSetSourceComponent>) {
  return components.map((component) => ({
    ordinal: component.ordinal,
    logicalSkillId: component.logicalSkillId,
    sourceRevisionSha256: component.sourceRevisionSha256,
    sourcePackageObjectSha256: component.sourcePackageObjectSha256,
  }));
}

function manifestRevisionIdentity(input: {
  readonly skillSetId: string;
  readonly name: string;
  readonly description: string;
  readonly harnesses: ReadonlyArray<typeof Harness.Type>;
  readonly bomSha256: string;
}) {
  return {
    skillSetId: input.skillSetId,
    name: input.name,
    description: input.description,
    harnesses: input.harnesses,
    bomSha256: input.bomSha256,
  };
}

function buildManifest(input: typeof CanonicalSkillSetSourceManifestInput.Type) {
  const components = canonicalComponents(input.components);
  // oxlint-disable-next-line unicorn/no-array-sort -- the spread creates an encoder-owned array.
  const harnesses = [...input.harnesses].sort(compareText);
  const bomSha256 = sha256(canonicalBytes(bomIdentity(components)));
  const skillSetRevisionSha256 = sha256(
    canonicalBytes(
      manifestRevisionIdentity({
        skillSetId: input.skillSetId,
        name: input.name,
        description: input.description,
        harnesses,
        bomSha256,
      }),
    ),
  );
  return CanonicalSkillSetSourceManifest.make({
    format: SKILL_SET_SOURCE_MANIFEST_FORMAT,
    version: CANONICAL_SKILL_SET_SOURCE_MANIFEST_VERSION,
    skillSetId: input.skillSetId,
    name: input.name,
    description: input.description,
    harnesses,
    bomSha256,
    skillSetRevisionSha256,
    components,
  });
}

export const encodeCanonicalSkillSetSourceManifestUnknown = Effect.fn(
  "encodeCanonicalSkillSetSourceManifest",
)(function* <Input>(input: Input) {
  const decoded = yield* Schema.decodeUnknownEffect(CanonicalSkillSetSourceManifestInput)(input, {
    errors: "all",
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => invalid("invalid_manifest", "Invalid Skill Set manifest")));
  if (new Set(decoded.harnesses).size !== decoded.harnesses.length) {
    return yield* invalid("invalid_manifest", "Harness ids must be unique");
  }
  const manifest = buildManifest(decoded);
  yield* validateComponentBom(manifest.components);
  const bytes = canonicalBytes(manifest);
  if (bytes.byteLength > MAXIMUM_SKILL_SET_SOURCE_MANIFEST_BYTES) {
    return yield* invalid(
      "encoded_manifest_too_large",
      `Skill Set source manifest exceeds ${MAXIMUM_SKILL_SET_SOURCE_MANIFEST_BYTES} bytes`,
    );
  }
  return {
    bytes,
    manifest,
    skillSetRevisionSha256: manifest.skillSetRevisionSha256,
    sourceManifestObjectSha256: sha256(bytes),
  } satisfies CanonicalSkillSetSourceManifestEncoding;
});

export const encodeCanonicalSkillSetSourceManifest: (
  input: typeof CanonicalSkillSetSourceManifestInput.Type,
) => Effect.Effect<CanonicalSkillSetSourceManifestEncoding, PortableSkillSetError> =
  encodeCanonicalSkillSetSourceManifestUnknown;

export const decodeCanonicalSkillSetSourceManifest = Effect.fn(
  "decodeCanonicalSkillSetSourceManifest",
)(function* (bytes: Uint8Array) {
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_SKILL_SET_SOURCE_MANIFEST_BYTES) {
    return yield* invalid(
      "encoded_manifest_too_large",
      `Skill Set source manifest must be 1-${MAXIMUM_SKILL_SET_SOURCE_MANIFEST_BYTES} bytes`,
    );
  }
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => invalid("invalid_utf8", "Skill Set source manifest is not valid UTF-8"),
  });
  const parsed = yield* decodeJsonText(text).pipe(
    Effect.mapError(() => invalid("invalid_json", "Skill Set source manifest is not valid JSON")),
  );
  const manifest = yield* Schema.decodeUnknownEffect(CanonicalSkillSetSourceManifest)(parsed, {
    errors: "all",
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => invalid("invalid_manifest", "Invalid Skill Set manifest")));
  yield* validateComponentBom(manifest.components);
  // oxlint-disable-next-line unicorn/no-array-sort -- the spread creates a decoder-owned array.
  const canonicalHarnesses = [...manifest.harnesses].sort(compareText);
  if (
    manifest.harnesses.some((harness, index) => harness !== canonicalHarnesses[index]) ||
    new Set(manifest.harnesses).size !== manifest.harnesses.length
  ) {
    return yield* invalid("invalid_manifest", "Harness ids must use canonical order");
  }
  const expected = buildManifest(manifest);
  const expectedBytes = canonicalBytes(expected);
  if (
    manifest.bomSha256 !== expected.bomSha256 ||
    manifest.skillSetRevisionSha256 !== expected.skillSetRevisionSha256 ||
    text !== new TextDecoder().decode(expectedBytes)
  ) {
    return yield* invalid("hash_mismatch", "Skill Set source manifest hashes do not match its BOM");
  }
  return {
    bytes: Uint8Array.from(bytes),
    manifest,
    skillSetRevisionSha256: manifest.skillSetRevisionSha256,
    sourceManifestObjectSha256: sha256(bytes),
  } satisfies CanonicalSkillSetSourceManifestEncoding;
});

function hasTooManyEnvelopeComponents<Input>(input: Input): boolean {
  const cardinality = decodePortableSkillSetEnvelopeCardinality(input);
  return (
    Option.isSome(cardinality) && cardinality.value.components.length > MAXIMUM_SKILL_SET_COMPONENTS
  );
}

const decodeCanonicalV2Package = Effect.fn("decodeCanonicalV2SkillSetPackage")(function* (
  bytes: Uint8Array,
) {
  const decoded = yield* decodeCanonicalPortablePackageBundleV2(bytes).pipe(
    Effect.mapError(() =>
      invalid("invalid_component_package", "Skill Set component is not a valid package"),
    ),
  );
  if (decoded.version !== CANONICAL_PACKAGE_BUNDLE_VERSION) {
    return yield* invalid(
      "invalid_component_package",
      "Skill Set components must use canonical package version 2",
    );
  }
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => invalid("invalid_component_package", "Skill Set component is not valid UTF-8"),
  });
  const parsedUnknown = yield* decodeJsonText(text).pipe(
    Effect.mapError(() =>
      invalid("invalid_component_package", "Skill Set component is not valid JSON"),
    ),
  );
  const parsed = yield* Schema.decodeUnknownEffect(Schema.Json)(parsedUnknown, {
    errors: "all",
  }).pipe(
    Effect.mapError(() =>
      invalid("invalid_component_package", "Skill Set component is not canonical JSON"),
    ),
  );
  return { parsed, decoded };
});

function sourceBindingMatches(
  source: CanonicalSkillSetSourceComponent,
  component: {
    readonly ordinal: number;
    readonly logicalSkillId: string;
    readonly sourceRevisionSha256: string;
    readonly sourcePackageObjectSha256: string;
  },
): boolean {
  return (
    source.ordinal === component.ordinal &&
    source.logicalSkillId === component.logicalSkillId &&
    source.sourceRevisionSha256 === component.sourceRevisionSha256 &&
    source.sourcePackageObjectSha256 === component.sourcePackageObjectSha256
  );
}

function validateEnvelopeSourceBindings(
  sourceComponents: ReadonlyArray<CanonicalSkillSetSourceComponent>,
  components: ReadonlyArray<{
    readonly ordinal: number;
    readonly logicalSkillId: string;
    readonly sourceRevisionSha256: string;
    readonly sourcePackageObjectSha256: string;
  }>,
): Effect.Effect<void, PortableSkillSetError> {
  if (components.length !== sourceComponents.length) {
    return Effect.fail(
      invalid(
        "source_binding_mismatch",
        "Every source manifest component must be sealed exactly once",
      ),
    );
  }
  for (const [index, component] of components.entries()) {
    const source = sourceComponents[index];
    if (!source || !sourceBindingMatches(source, component)) {
      return Effect.fail(
        invalid(
          "source_binding_mismatch",
          "Sealed component bindings must exactly match source manifest order and identity",
        ),
      );
    }
  }
  return Effect.void;
}

function decodedContentBytes(bundle: PortablePackageBundle): number {
  return bundle.files.reduce((total, file) => total + file.content.byteLength, 0);
}

function makeTerms(
  input: typeof PortableSkillSetComponentTermsInput.Type,
  bundle: PortablePackageBundle,
): Effect.Effect<PortableSkillSetComponentTerms, PortableSkillSetError> {
  if (new Set(input.noticePaths).size !== input.noticePaths.length) {
    return Effect.fail(invalid("invalid_terms", "Notice paths must be unique"));
  }
  const files = new Map(bundle.files.map((file) => [file.path, file.content]));
  const licenseContent = input.licenseFilePath ? files.get(input.licenseFilePath) : undefined;
  if (input.licenseFilePath && !licenseContent) {
    return Effect.fail(
      invalid("invalid_terms", "Declared license file is missing from the sealed component"),
    );
  }
  const notices: Array<{ readonly path: string; readonly sha256: string }> = [];
  // oxlint-disable-next-line unicorn/no-array-sort -- the spread creates an encoder-owned array.
  for (const path of [...input.noticePaths].sort(compareText)) {
    const content = files.get(path);
    if (!content) {
      return Effect.fail(
        invalid("invalid_terms", "Declared notice file is missing from the sealed component"),
      );
    }
    notices.push({ path, sha256: sha256(content) });
  }
  return Effect.succeed(
    PortableSkillSetComponentTerms.make({
      licenseExpression: input.licenseExpression,
      licenseFile:
        input.licenseFilePath && licenseContent
          ? { path: input.licenseFilePath, sha256: sha256(licenseContent) }
          : null,
      notices,
    }),
  );
}

function validateStoredTerms(
  terms: PortableSkillSetComponentTerms,
  bundle: PortablePackageBundle,
): Effect.Effect<void, PortableSkillSetError> {
  const files = new Map(bundle.files.map((file) => [file.path, file.content]));
  if (terms.licenseFile) {
    const content = files.get(terms.licenseFile.path);
    if (!content || sha256(content) !== terms.licenseFile.sha256) {
      return Effect.fail(
        invalid("invalid_terms", "License file hash does not match the sealed component"),
      );
    }
  }
  const noticePaths = new Set<string>();
  for (const [index, notice] of terms.notices.entries()) {
    if (
      noticePaths.has(notice.path) ||
      (index > 0 && terms.notices[index - 1]!.path >= notice.path)
    ) {
      return Effect.fail(invalid("invalid_terms", "Notice files must use unique canonical order"));
    }
    const content = files.get(notice.path);
    if (!content || sha256(content) !== notice.sha256) {
      return Effect.fail(
        invalid("invalid_terms", "Notice file hash does not match the sealed component"),
      );
    }
    noticePaths.add(notice.path);
  }
  return Effect.void;
}

function packagedBomIdentity(components: ReadonlyArray<PortableSkillSetEnvelopeComponent>) {
  return components.map((component) => ({
    ordinal: component.ordinal,
    logicalSkillId: component.logicalSkillId,
    sourceRevisionSha256: component.sourceRevisionSha256,
    sourcePackageObjectSha256: component.sourcePackageObjectSha256,
    sealedPackageObjectSha256: component.sealedPackageObjectSha256,
    terms: component.terms,
  }));
}

function validateAggregateLimits(
  embeddedBytes: number,
  decodedBytes: number,
): Effect.Effect<void, PortableSkillSetError> {
  if (embeddedBytes > MAXIMUM_PORTABLE_SKILL_SET_EMBEDDED_PACKAGE_BYTES) {
    return Effect.fail(
      invalid(
        "embedded_packages_too_large",
        `Embedded component packages exceed ${MAXIMUM_PORTABLE_SKILL_SET_EMBEDDED_PACKAGE_BYTES} bytes`,
      ),
    );
  }
  if (decodedBytes > MAXIMUM_PORTABLE_SKILL_SET_DECODED_CONTENT_BYTES) {
    return Effect.fail(
      invalid(
        "decoded_content_too_large",
        `Decoded component content exceeds ${MAXIMUM_PORTABLE_SKILL_SET_DECODED_CONTENT_BYTES} bytes`,
      ),
    );
  }
  return Effect.void;
}

export const encodePortableSkillSetEnvelopeUnknown = Effect.fn("encodePortableSkillSetEnvelope")(
  function* <Input>(input: Input) {
    if (hasTooManyEnvelopeComponents(input)) {
      return yield* invalid(
        "component_count_exceeded",
        `Skill Set envelopes support at most ${MAXIMUM_SKILL_SET_COMPONENTS} components`,
      );
    }
    const decodedInput = yield* Schema.decodeUnknownEffect(PortableSkillSetEnvelopeInput)(input, {
      errors: "all",
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => invalid("invalid_manifest", "Invalid portable Skill Set input")));
    const source = yield* decodeCanonicalSkillSetSourceManifest(decodedInput.sourceManifestBytes);
    // oxlint-disable-next-line unicorn/no-array-sort -- the spread creates an encoder-owned array.
    const components = [...decodedInput.components].sort(
      (left, right) => left.ordinal - right.ordinal,
    );
    yield* validateEnvelopeSourceBindings(source.manifest.components, components);

    let embeddedBytes = 0;
    let decodedBytes = 0;
    const decodedComponents: Array<{
      readonly sealedPackageObjectSha256: string;
      readonly package: PortablePackageBundle;
    }> = [];
    const envelopeComponents: Array<PortableSkillSetEnvelopeComponent> = [];
    const sealedHashes = new Set<string>();
    for (const component of components) {
      embeddedBytes += component.sealedPackageBytes.byteLength;
      yield* validateAggregateLimits(embeddedBytes, decodedBytes);
      const sealed = yield* decodeCanonicalV2Package(component.sealedPackageBytes);
      decodedBytes += decodedContentBytes(sealed.decoded);
      yield* validateAggregateLimits(embeddedBytes, decodedBytes);
      const terms = yield* makeTerms(component.terms, sealed.decoded);
      const sealedPackageObjectSha256 = sha256(component.sealedPackageBytes);
      if (sealedHashes.has(sealedPackageObjectSha256)) {
        return yield* invalid(
          "component_identity_collision",
          "Sealed component package hashes must be unique",
        );
      }
      sealedHashes.add(sealedPackageObjectSha256);
      envelopeComponents.push(
        PortableSkillSetEnvelopeComponent.make({
          ordinal: component.ordinal,
          logicalSkillId: component.logicalSkillId,
          sourceRevisionSha256: component.sourceRevisionSha256,
          sourcePackageObjectSha256: component.sourcePackageObjectSha256,
          sealedPackageObjectSha256,
          terms,
          package: sealed.parsed,
        }),
      );
      decodedComponents.push({ sealedPackageObjectSha256, package: sealed.decoded });
    }

    const packagedBomSha256 = sha256(canonicalBytes(packagedBomIdentity(envelopeComponents)));
    const envelope = PortableSkillSetEnvelope.make({
      format: PORTABLE_SKILL_SET_ENVELOPE_FORMAT,
      version: PORTABLE_SKILL_SET_ENVELOPE_VERSION,
      sourceManifestObjectSha256: source.sourceManifestObjectSha256,
      skillSetRevisionSha256: source.skillSetRevisionSha256,
      sourceBomSha256: source.manifest.bomSha256,
      sourceManifest: source.manifest,
      packagedBomSha256,
      components: envelopeComponents,
    });
    const bytes = canonicalBytes(envelope);
    if (bytes.byteLength > MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES) {
      return yield* invalid(
        "encoded_envelope_too_large",
        `Portable Skill Set envelope exceeds ${MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES} bytes`,
      );
    }
    return {
      bytes,
      envelope,
      sourceManifestObjectSha256: source.sourceManifestObjectSha256,
      portableSkillSetEnvelopeSha256: sha256(bytes),
      components: decodedComponents,
    } satisfies PortableSkillSetEnvelopeEncoding;
  },
);

export const encodePortableSkillSetEnvelope: (
  input: typeof PortableSkillSetEnvelopeInput.Type,
) => Effect.Effect<PortableSkillSetEnvelopeEncoding, PortableSkillSetError> =
  encodePortableSkillSetEnvelopeUnknown;

export const decodePortableSkillSetEnvelope = Effect.fn("decodePortableSkillSetEnvelope")(
  function* (bytes: Uint8Array) {
    if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES) {
      return yield* invalid(
        "encoded_envelope_too_large",
        `Portable Skill Set envelope must be 1-${MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES} bytes`,
      );
    }
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => invalid("invalid_utf8", "Portable Skill Set envelope is not valid UTF-8"),
    });
    const parsed = yield* decodeJsonText(text).pipe(
      Effect.mapError(() =>
        invalid("invalid_json", "Portable Skill Set envelope is not valid JSON"),
      ),
    );
    if (hasTooManyEnvelopeComponents(parsed)) {
      return yield* invalid(
        "component_count_exceeded",
        `Skill Set envelopes support at most ${MAXIMUM_SKILL_SET_COMPONENTS} components`,
      );
    }
    const envelope = yield* Schema.decodeUnknownEffect(PortableSkillSetEnvelope)(parsed, {
      errors: "all",
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() => invalid("invalid_manifest", "Invalid portable Skill Set envelope")),
    );
    if (text !== JSON.stringify(envelope)) {
      return yield* invalid("hash_mismatch", "Portable Skill Set envelope is not canonical JSON");
    }
    const sourceBytes = canonicalBytes(envelope.sourceManifest);
    const source = yield* decodeCanonicalSkillSetSourceManifest(sourceBytes);
    if (
      source.sourceManifestObjectSha256 !== envelope.sourceManifestObjectSha256 ||
      source.skillSetRevisionSha256 !== envelope.skillSetRevisionSha256 ||
      source.manifest.bomSha256 !== envelope.sourceBomSha256
    ) {
      return yield* invalid(
        "source_binding_mismatch",
        "Skill Set root hashes do not bind its source manifest",
      );
    }
    yield* validateEnvelopeSourceBindings(source.manifest.components, envelope.components);

    let embeddedBytes = 0;
    let decodedBytes = 0;
    const decodedComponents: Array<{
      readonly sealedPackageObjectSha256: string;
      readonly package: PortablePackageBundle;
    }> = [];
    const sealedHashes = new Set<string>();
    for (const component of envelope.components) {
      const packageBytes = canonicalBytes(component.package);
      embeddedBytes += packageBytes.byteLength;
      yield* validateAggregateLimits(embeddedBytes, decodedBytes);
      const sealed = yield* decodeCanonicalV2Package(packageBytes);
      decodedBytes += decodedContentBytes(sealed.decoded);
      yield* validateAggregateLimits(embeddedBytes, decodedBytes);
      const sealedPackageObjectSha256 = sha256(packageBytes);
      if (
        sealedPackageObjectSha256 !== component.sealedPackageObjectSha256 ||
        sealedHashes.has(sealedPackageObjectSha256)
      ) {
        return yield* invalid(
          sealedHashes.has(sealedPackageObjectSha256)
            ? "component_identity_collision"
            : "hash_mismatch",
          "Sealed component package hashes must match and be unique",
        );
      }
      sealedHashes.add(sealedPackageObjectSha256);
      yield* validateStoredTerms(component.terms, sealed.decoded);
      decodedComponents.push({ sealedPackageObjectSha256, package: sealed.decoded });
    }
    const expectedPackagedBomSha256 = sha256(
      canonicalBytes(packagedBomIdentity(envelope.components)),
    );
    if (expectedPackagedBomSha256 !== envelope.packagedBomSha256) {
      return yield* invalid(
        "hash_mismatch",
        "Packaged Skill Set BOM hash does not match components",
      );
    }
    return {
      bytes: Uint8Array.from(bytes),
      envelope,
      sourceManifestObjectSha256: source.sourceManifestObjectSha256,
      portableSkillSetEnvelopeSha256: sha256(bytes),
      components: decodedComponents,
    } satisfies PortableSkillSetEnvelopeEncoding;
  },
);
