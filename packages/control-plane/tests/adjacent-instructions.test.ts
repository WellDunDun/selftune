import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import {
  exportAdjacentInstruction,
  importAdjacentInstruction,
} from "../src/domain/adjacent-instructions";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("adjacent instruction artifacts", () => {
  it.each([
    ["agents_md", "codex", "AGENTS.md", "directory_hierarchy"],
    ["claude_md", "claude_code", "CLAUDE.md", "directory_hierarchy"],
    [
      "copilot_instructions",
      "github_copilot",
      ".github/copilot-instructions.md",
      "repository_always",
    ],
  ] as const)(
    "imports %s without re-labeling it as an Agent Skill",
    async (kind, harness, path, activation) => {
      const artifact = await Effect.runPromise(
        importAdjacentInstruction({
          kind,
          harness,
          projectRelativePath: path,
          bytes: bytes("# Repository instructions\n\nRun tests before merging.\n"),
        }),
      );

      expect(artifact).toMatchObject({
        artifactType: "adjacent_instruction",
        kind,
        harness,
        projectRelativePath: path,
        contract: {
          activationBehavior: activation,
          conflictBehavior: "block_existing_different_bytes",
          updateBehavior: "explicit_replace_after_hash_preview",
          rollbackBehavior: "restore_previous_bytes_or_remove_created_file",
        },
      });
      expect(artifact).not.toHaveProperty("skill");
      expect(exportAdjacentInstruction(artifact, null)).toMatchObject({
        action: "create",
        destination: path,
      });
      expect(exportAdjacentInstruction(artifact, artifact.sha256).action).toBe("unchanged");
      expect(exportAdjacentInstruction(artifact, "f".repeat(64)).action).toBe("blocked_conflict");
    },
  );

  it.each([
    [
      "cursor_always",
      "---\ndescription: Team rules\nglobs:\nalwaysApply: true\n---\nAlways test.\n",
    ],
    [
      "cursor_auto_attached",
      "---\ndescription: TypeScript rules\nglobs: '*.ts'\nalwaysApply: false\n---\nUse strict types.\n",
    ],
    [
      "cursor_agent_requested",
      "---\ndescription: Database migration workflow\nglobs:\nalwaysApply: false\n---\nReview migrations.\n",
    ],
    ["cursor_manual", "---\ndescription:\nglobs:\nalwaysApply: false\n---\nManual workflow.\n"],
  ] as const)(
    "requires explicit matching Cursor activation for %s",
    async (activation, content) => {
      const artifact = await Effect.runPromise(
        importAdjacentInstruction({
          kind: "cursor_rule",
          harness: "cursor",
          projectRelativePath: ".cursor/rules/team.mdc",
          cursorRuleSlug: "team",
          declaredActivation: activation,
          bytes: bytes(content),
        }),
      );
      expect(artifact.contract.activationBehavior).toBe(activation);
      expect(artifact.contract.placementBehavior).toBe("cursor_project_rules");
    },
  );

  it("fails closed for unsupported harness semantics and noncanonical placement", async () => {
    await expect(
      Effect.runPromise(
        importAdjacentInstruction({
          kind: "claude_md",
          harness: "codex",
          projectRelativePath: "CLAUDE.md",
          bytes: bytes("# Claude"),
        }),
      ),
    ).rejects.toMatchObject({ code: "ADJACENT_UNSUPPORTED_HARNESS" });
    await expect(
      Effect.runPromise(
        importAdjacentInstruction({
          kind: "copilot_instructions",
          harness: "github_copilot",
          projectRelativePath: "copilot-instructions.md",
          bytes: bytes("# Copilot"),
        }),
      ),
    ).rejects.toMatchObject({ code: "ADJACENT_INVALID_PLACEMENT" });
  });

  it("does not infer Cursor activation from ambiguous frontmatter", async () => {
    await expect(
      Effect.runPromise(
        importAdjacentInstruction({
          kind: "cursor_rule",
          harness: "cursor",
          projectRelativePath: ".cursor/rules/team.mdc",
          cursorRuleSlug: "team",
          bytes: bytes("---\ndescription: Team\nglobs:\nalwaysApply: false\n---\nTeam rules.\n"),
        }),
      ),
    ).rejects.toMatchObject({ code: "ADJACENT_ACTIVATION_REQUIRED" });
  });
});
