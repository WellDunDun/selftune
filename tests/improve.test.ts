import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runImprove } from "@selftune/orchestration/improve";

const ORIGINAL_ARGV = [...process.argv];
let tempRoot = "";

afterEach(() => {
  process.argv = [...ORIGINAL_ARGV];
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

describe("selftune improve", () => {
  test("uses historical replay for an eligible auto dry-run and stops before evolve", async () => {
    let historicalInput: unknown;
    let evolved = false;
    const originalLog = console.log;
    console.log = () => undefined;
    try {
      await runImprove(
        [
          "--skill",
          "to-issues",
          "--skill-path",
          "/tmp/skills/to-issues/SKILL.md",
          "--scope",
          "auto",
          "--dry-run",
          "--agent",
          "codex",
        ],
        {
          historicalImprove: async (input) => {
            historicalInput = input;
            return { handled: true, result: { status: "review_ready" } };
          },
          evolveCliMain: async () => {
            evolved = true;
          },
        },
      );
    } finally {
      console.log = originalLog;
    }

    expect(historicalInput).toEqual({
      skill: "to-issues",
      skillPath: "/tmp/skills/to-issues/SKILL.md",
      agent: "codex",
    });
    expect(evolved).toBe(false);
  });

  test("falls back to description evolution when historical contrast is ineligible", async () => {
    let evolved = false;
    await runImprove(
      [
        "--skill",
        "unused-skill",
        "--skill-path",
        "/tmp/skills/unused-skill/SKILL.md",
        "--scope",
        "auto",
        "--dry-run",
      ],
      {
        historicalImprove: async () => ({ handled: false }),
        evolveCliMain: async () => {
          evolved = true;
        },
      },
    );

    expect(evolved).toBe(true);
  });

  test("delegates package scope into search-run and preserves package-evaluator flags", async () => {
    let delegatedArgv: string[] | null = null;

    process.argv = ["bun", "improve.ts"];
    await runImprove(
      [
        "--skill",
        "code-review",
        "--skill-path",
        "/tmp/code-review/SKILL.md",
        "--scope",
        "package",
        "--eval-set",
        "/tmp/evals.json",
        "--dry-run",
        "--validation-mode",
        "replay",
        "--candidates",
        "7",
      ],
      {
        searchRunCliMain: async () => {
          delegatedArgv = [...process.argv];
        },
      },
    );

    expect(delegatedArgv).not.toBeNull();
    expect(delegatedArgv).toEqual([
      "bun",
      "improve.ts",
      "--skill",
      "code-review",
      "--skill-path",
      "/tmp/code-review/SKILL.md",
      "--eval-set",
      "/tmp/evals.json",
      "--max-candidates",
      "7",
    ]);
  });

  test("adds --apply-winner for package scope when dry-run is not requested", async () => {
    let delegatedArgv: string[] | null = null;

    process.argv = ["bun", "improve.ts"];
    await runImprove(
      ["--skill", "code-review", "--skill-path", "/tmp/code-review/SKILL.md", "--scope", "package"],
      {
        searchRunCliMain: async () => {
          delegatedArgv = [...process.argv];
        },
      },
    );

    expect(delegatedArgv).toEqual([
      "bun",
      "improve.ts",
      "--skill",
      "code-review",
      "--skill-path",
      "/tmp/code-review/SKILL.md",
      "--apply-winner",
    ]);
  });

  test("auto-selects package search for draft packages even without --scope package", async () => {
    let delegatedArgv: string[] | null = null;
    tempRoot = mkdtempSync(join(tmpdir(), "selftune-improve-auto-"));
    const skillDir = join(tempRoot, "research-assistant");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Research Assistant\n", "utf-8");
    writeFileSync(join(skillDir, "selftune.create.json"), "{}", "utf-8");

    process.argv = ["bun", "improve.ts"];
    await runImprove(
      ["--skill", "research-assistant", "--skill-path", join(skillDir, "SKILL.md")],
      {
        searchRunCliMain: async () => {
          delegatedArgv = [...process.argv];
        },
      },
    );

    expect(delegatedArgv).toEqual([
      "bun",
      "improve.ts",
      "--skill",
      "research-assistant",
      "--skill-path",
      join(skillDir, "SKILL.md"),
      "--apply-winner",
    ]);
  });

  test("rejects judge validation for package scope", async () => {
    await expect(
      runImprove([
        "--skill",
        "code-review",
        "--skill-path",
        "/tmp/code-review/SKILL.md",
        "--scope",
        "package",
        "--validation-mode",
        "judge",
      ]),
    ).rejects.toMatchObject({
      message: expect.stringContaining("does not support judge-only validation"),
      code: "INVALID_FLAG",
    });
  });
});
