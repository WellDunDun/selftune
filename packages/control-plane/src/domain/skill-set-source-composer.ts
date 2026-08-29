import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const SKILL_SET_SOURCE_COMPOSER_PREVIEW_FORMAT =
  "selftune-skill-set-source-composer-preview-v1" as const;

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const SourceKind = Schema.Literals(["skills-sh", "github", "folder", "archive"]);
const Harness = Schema.Literals(["claude_code", "codex", "opencode", "openclaw", "pi"]);

export class ResolvedSkillSetComposerSource extends Schema.Class<ResolvedSkillSetComposerSource>(
  "ResolvedSkillSetComposerSource",
)({
  sourceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  kind: SourceKind,
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  logicalSkillId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  sourceRevisionSha256: Sha256,
  sourcePackageObjectSha256: Sha256,
  installSpec: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
}) {}

const ComposerSourceInput = Schema.Union([
  Schema.Struct({
    sourceId: Schema.String,
    kind: SourceKind,
    source: Schema.String,
    status: Schema.Literal("resolved"),
    resolution: ResolvedSkillSetComposerSource,
  }),
  Schema.Struct({
    sourceId: Schema.String,
    kind: SourceKind,
    source: Schema.String,
    status: Schema.Literals(["unresolved", "error"]),
    message: Schema.String,
  }),
]);

const ComposerInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  description: Schema.String.check(Schema.isMaxLength(4_000)),
  harnesses: Schema.Array(Harness),
  sources: Schema.Array(ComposerSourceInput),
});

export class SkillSetSourceComposerPreview extends Schema.Class<SkillSetSourceComposerPreview>(
  "SkillSetSourceComposerPreview",
)({
  format: Schema.Literal(SKILL_SET_SOURCE_COMPOSER_PREVIEW_FORMAT),
  name: Schema.String,
  description: Schema.String,
  harnesses: Schema.Array(Harness),
  components: Schema.Array(ResolvedSkillSetComposerSource),
  directInstall: Schema.Literal(false),
  portableImportCommand: Schema.Literal(
    "selftune sets import --manifest <downloaded-selftune-skill-set.json>",
  ),
}) {}

export class SkillSetSourceComposerError extends Schema.TaggedErrorClass<SkillSetSourceComposerError>()(
  "SkillSetSourceComposerError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "unresolved_source",
      "duplicate_component",
      "source_binding_mismatch",
    ]),
    message: Schema.String.check(Schema.isMaxLength(320)),
  },
) {}

function invalid(
  reason: typeof SkillSetSourceComposerError.fields.reason.Type,
  message: string,
): SkillSetSourceComposerError {
  return SkillSetSourceComposerError.make({ reason, message: message.slice(0, 320) });
}

export const composeSkillSetSourcePreviewUnknown = Effect.fn("SkillSetSourceComposer.preview")(
  function* <Input>(input: Input) {
    const decoded = yield* Schema.decodeUnknownEffect(ComposerInput)(input, {
      errors: "all",
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError((cause) =>
        invalid("invalid_input", `Invalid Skill Set source composition: ${cause.message}`),
      ),
    );
    if (decoded.sources.length === 0 || decoded.harnesses.length === 0) {
      return yield* invalid(
        "invalid_input",
        "Source composition requires at least one source and one harness",
      );
    }
    const blocked = decoded.sources.find((source) => source.status !== "resolved");
    if (blocked) {
      return yield* invalid(
        "unresolved_source",
        `${blocked.kind} source ${blocked.sourceId} is not pinned: ${blocked.message}`,
      );
    }
    const resolved = decoded.sources.flatMap((source) =>
      source.status === "resolved" ? [source.resolution] : [],
    );
    const logicalIds = new Set<string>();
    const packageHashes = new Set<string>();
    for (const [index, source] of resolved.entries()) {
      const requested = decoded.sources[index];
      if (
        source.sourceId !== requested?.sourceId ||
        source.kind !== requested.kind ||
        source.source !== requested.source
      ) {
        return yield* invalid(
          "source_binding_mismatch",
          `Resolved source ${source.sourceId} does not match its requested source identity`,
        );
      }
      if (
        logicalIds.has(source.logicalSkillId) ||
        packageHashes.has(source.sourcePackageObjectSha256)
      ) {
        return yield* invalid(
          "duplicate_component",
          "Every composed skill must have a unique logical id and package object hash",
        );
      }
      logicalIds.add(source.logicalSkillId);
      packageHashes.add(source.sourcePackageObjectSha256);
    }
    return SkillSetSourceComposerPreview.make({
      format: SKILL_SET_SOURCE_COMPOSER_PREVIEW_FORMAT,
      name: decoded.name,
      description: decoded.description,
      harnesses: decoded.harnesses,
      components: resolved,
      directInstall: false,
      portableImportCommand: "selftune sets import --manifest <downloaded-selftune-skill-set.json>",
    });
  },
);

export type SkillSetSourceComposerInput = typeof ComposerInput.Type;
export const composeSkillSetSourcePreview: (
  input: SkillSetSourceComposerInput,
) => Effect.Effect<SkillSetSourceComposerPreview, SkillSetSourceComposerError> =
  composeSkillSetSourcePreviewUnknown;
