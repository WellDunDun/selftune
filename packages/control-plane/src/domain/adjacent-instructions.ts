import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const MAXIMUM_INSTRUCTION_BYTES = 256 * 1024;
const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,79}$/));

export const AdjacentInstructionKind = Schema.Literals([
  "agents_md",
  "claude_md",
  "cursor_rule",
  "copilot_instructions",
]);
export type AdjacentInstructionKind = typeof AdjacentInstructionKind.Type;

export const AdjacentInstructionHarness = Schema.Literals([
  "codex",
  "claude_code",
  "cursor",
  "github_copilot",
]);
export type AdjacentInstructionHarness = typeof AdjacentInstructionHarness.Type;

export const AdjacentInstructionActivation = Schema.Literals([
  "project_always",
  "directory_hierarchy",
  "cursor_always",
  "cursor_auto_attached",
  "cursor_agent_requested",
  "cursor_manual",
  "repository_always",
]);
export type AdjacentInstructionActivation = typeof AdjacentInstructionActivation.Type;

export class AdjacentInstructionError extends Schema.TaggedErrorClass<AdjacentInstructionError>()(
  "AdjacentInstructionError",
  { code: Schema.String, message: Schema.String },
) {}

export interface AdjacentInstructionImportInput {
  readonly kind: AdjacentInstructionKind;
  readonly harness: AdjacentInstructionHarness;
  readonly projectRelativePath: string;
  readonly bytes: Uint8Array;
  readonly cursorRuleSlug?: string;
  readonly declaredActivation?: AdjacentInstructionActivation;
}

export interface AdjacentInstructionArtifact {
  readonly artifactType: "adjacent_instruction";
  readonly kind: AdjacentInstructionKind;
  readonly harness: AdjacentInstructionHarness;
  readonly projectRelativePath: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly contract: {
    readonly importBehavior: "exact_utf8_markdown" | "exact_utf8_mdc";
    readonly validationBehavior: "bounded_nonempty_utf8" | "bounded_cursor_mdc_frontmatter";
    readonly placementBehavior: "project_root" | "cursor_project_rules" | "github_repository";
    readonly activationBehavior: AdjacentInstructionActivation;
    readonly conflictBehavior: "block_existing_different_bytes";
    readonly updateBehavior: "explicit_replace_after_hash_preview";
    readonly rollbackBehavior: "restore_previous_bytes_or_remove_created_file";
  };
}

function invalid(code: string, message: string) {
  return Effect.fail(new AdjacentInstructionError({ code, message }));
}

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 240 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").includes("..")
  );
}

function exactPlacement(input: AdjacentInstructionImportInput): string | null {
  if (input.kind === "agents_md")
    return input.projectRelativePath === "AGENTS.md" ? "AGENTS.md" : null;
  if (input.kind === "claude_md")
    return input.projectRelativePath === "CLAUDE.md" ? "CLAUDE.md" : null;
  if (input.kind === "copilot_instructions")
    return input.projectRelativePath === ".github/copilot-instructions.md"
      ? ".github/copilot-instructions.md"
      : null;
  const slug = input.cursorRuleSlug;
  if (!slug || !Schema.is(Slug)(slug)) return null;
  const target = `.cursor/rules/${slug}.mdc`;
  return input.projectRelativePath === target ? target : null;
}

function supported(kind: AdjacentInstructionKind, harness: AdjacentInstructionHarness): boolean {
  return (
    (kind === "agents_md" && harness === "codex") ||
    (kind === "claude_md" && harness === "claude_code") ||
    (kind === "cursor_rule" && harness === "cursor") ||
    (kind === "copilot_instructions" && harness === "github_copilot")
  );
}

function cursorActivation(
  text: string,
  declared: AdjacentInstructionActivation | undefined,
): Effect.Effect<AdjacentInstructionActivation, AdjacentInstructionError> {
  if (!declared?.startsWith("cursor_"))
    return invalid(
      "ADJACENT_ACTIVATION_REQUIRED",
      "Cursor rules require an explicit activation mode; SelfTune does not infer semantic intent.",
    );
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1];
  if (!frontmatter)
    return invalid("ADJACENT_INVALID_CURSOR_RULE", "Cursor rules require MDC frontmatter.");
  const always = /^alwaysApply:\s*(true|false)\s*$/m.exec(frontmatter)?.[1];
  const description = /^description:\s*(.+)\s*$/m.exec(frontmatter)?.[1]?.trim() ?? "";
  const globs = /^globs:\s*(.*)\s*$/m.exec(frontmatter)?.[1]?.trim() ?? "";
  if (always === undefined)
    return invalid("ADJACENT_INVALID_CURSOR_RULE", "Cursor rules must declare alwaysApply.");
  if (declared === "cursor_always" && always !== "true")
    return invalid("ADJACENT_ACTIVATION_MISMATCH", "Always rules must set alwaysApply: true.");
  if (declared === "cursor_auto_attached" && (always !== "false" || globs.length === 0))
    return invalid(
      "ADJACENT_ACTIVATION_MISMATCH",
      "Auto-attached rules must set alwaysApply: false and declare globs.",
    );
  if (declared === "cursor_agent_requested" && (always !== "false" || description.length === 0))
    return invalid(
      "ADJACENT_ACTIVATION_MISMATCH",
      "Agent-requested rules must set alwaysApply: false and declare a description.",
    );
  if (declared === "cursor_manual" && always !== "false")
    return invalid("ADJACENT_ACTIVATION_MISMATCH", "Manual rules must set alwaysApply: false.");
  return Effect.succeed(declared);
}

function fixedActivation(kind: AdjacentInstructionKind): AdjacentInstructionActivation {
  if (kind === "agents_md") return "directory_hierarchy";
  if (kind === "claude_md") return "directory_hierarchy";
  return "repository_always";
}

export const importAdjacentInstruction = Effect.fn("importAdjacentInstruction")(function* (
  input: AdjacentInstructionImportInput,
) {
  if (!supported(input.kind, input.harness))
    return yield* invalid(
      "ADJACENT_UNSUPPORTED_HARNESS",
      `${input.kind} semantics are not declared for ${input.harness}.`,
    );
  if (!safePath(input.projectRelativePath) || exactPlacement(input) === null)
    return yield* invalid(
      "ADJACENT_INVALID_PLACEMENT",
      `${input.kind} must use its declared project-relative placement.`,
    );
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAXIMUM_INSTRUCTION_BYTES)
    return yield* invalid(
      "ADJACENT_INVALID_SIZE",
      `Instruction content must be 1-${MAXIMUM_INSTRUCTION_BYTES} bytes.`,
    );
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(input.bytes),
    catch: () =>
      new AdjacentInstructionError({
        code: "ADJACENT_INVALID_UTF8",
        message: "Instruction content must be valid UTF-8.",
      }),
  });
  if (text.trim().length === 0 || text.includes("\u0000"))
    return yield* invalid(
      "ADJACENT_INVALID_CONTENT",
      "Instruction content must be non-empty text without NUL bytes.",
    );
  const activation =
    input.kind === "cursor_rule"
      ? yield* cursorActivation(text, input.declaredActivation)
      : fixedActivation(input.kind);
  return {
    artifactType: "adjacent_instruction",
    kind: input.kind,
    harness: input.harness,
    projectRelativePath: input.projectRelativePath,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    bytes: input.bytes,
    contract: {
      importBehavior:
        input.kind === "cursor_rule"
          ? ("exact_utf8_mdc" as const)
          : ("exact_utf8_markdown" as const),
      validationBehavior:
        input.kind === "cursor_rule"
          ? ("bounded_cursor_mdc_frontmatter" as const)
          : ("bounded_nonempty_utf8" as const),
      placementBehavior:
        input.kind === "cursor_rule"
          ? ("cursor_project_rules" as const)
          : input.kind === "copilot_instructions"
            ? ("github_repository" as const)
            : ("project_root" as const),
      activationBehavior: activation,
      conflictBehavior: "block_existing_different_bytes" as const,
      updateBehavior: "explicit_replace_after_hash_preview" as const,
      rollbackBehavior: "restore_previous_bytes_or_remove_created_file" as const,
    },
  } satisfies AdjacentInstructionArtifact;
});

export function exportAdjacentInstruction(
  artifact: AdjacentInstructionArtifact,
  existingSha256: string | null,
) {
  return {
    artifactType: artifact.artifactType,
    destination: artifact.projectRelativePath,
    bytes: artifact.bytes,
    expectedSha256: artifact.sha256,
    action:
      existingSha256 === null
        ? ("create" as const)
        : existingSha256 === artifact.sha256
          ? ("unchanged" as const)
          : ("blocked_conflict" as const),
    activation: artifact.contract.activationBehavior,
    update: artifact.contract.updateBehavior,
    rollback: artifact.contract.rollbackBehavior,
  };
}
