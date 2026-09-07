import assert from "node:assert/strict";
import type { skill_invocations } from "@selftune/local-store/schema";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeSkillPackageManifest } from "@selftune/telemetry-contract";

import { processPrompt } from "@selftune/harness-claude-code/hooks/prompt-log";
import {
  countSkillToolInvocations,
  findLatestSkillToolInvocationId,
  extractSkillName,
  processToolUse,
} from "@selftune/harness-claude-code/hooks/skill-eval";
import { _setTestDb, getDb, openDb } from "../../packages/runtime/localdb/db.js";
import type { PostToolUsePayload } from "../../packages/runtime/types.js";

let tmpDir: string;
let canonicalLogPath: string;
let promptStatePath: string;
let _queryLogPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-skill-eval-"));
  canonicalLogPath = join(tmpDir, "canonical.jsonl");
  promptStatePath = join(tmpDir, "canonical-session-state.json");
  _queryLogPath = join(tmpDir, "queries.jsonl");

  const testDb = openDb(":memory:");
  _setTestDb(testDb);
});

afterEach(() => {
  const db = getDb();
  db?.close?.();
  _setTestDb(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper to count skill check rows in the unified skill_invocations table. */
function skillUsageCount(): number {
  const db = getDb();
  const row = db
    .query<{ cnt: number }, string[]>("SELECT COUNT(*) as cnt FROM skill_invocations")
    .get();
  assert.ok(row);
  return row.cnt;
}

describe("extractSkillName", () => {
  test("extracts skill name from SKILL.md path", () => {
    expect(extractSkillName("/mnt/skills/public/pptx/SKILL.md")).toBe("pptx");
    expect(extractSkillName("/skills/pdf/SKILL.md")).toBe("pdf");
    expect(extractSkillName("/a/b/c/my-skill/SKILL.md")).toBe("my-skill");
  });

  test("handles case-insensitive SKILL.md", () => {
    expect(extractSkillName("/skills/test/skill.md")).toBe("test");
    expect(extractSkillName("/skills/test/Skill.Md")).toBe("test");
  });

  test("returns null for non-SKILL.md files", () => {
    expect(extractSkillName("/src/auth.ts")).toBeNull();
    expect(extractSkillName("/README.md")).toBeNull();
    expect(extractSkillName("/skills/pptx/README.md")).toBeNull();
  });
});

describe("skill-eval hook", () => {
  test("ignores malformed and user-authored blocks when finding actual skill invocations", () => {
    const transcript = join(tmpDir, "mixed-transcript.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          role: "assistant",
          content: [
            { type: "tool_use", name: "Skill", id: "real-call", input: { skill: "reins" } },
          ],
        }),
        "null",
        "7",
        "[]",
        "{invalid",
        JSON.stringify({
          role: "assistant",
          content: [null, 9, { type: "tool_use", name: "Skill", id: 32, input: { skill: false } }],
        }),
        JSON.stringify({
          role: "user",
          content: [
            { type: "tool_use", name: "Skill", id: "quoted-call", input: { skill: "reins" } },
          ],
        }),
      ].join("\n"),
    );
    expect(countSkillToolInvocations(transcript, "reins")).toBe(1);
    expect(findLatestSkillToolInvocationId(transcript, "reins")).toBe("real-call");
  });

  test("ignores non-Read tools", async () => {
    const payload: PostToolUsePayload = {
      tool_name: "Write",
      tool_input: { file_path: "/skills/pdf/SKILL.md" },
      session_id: "sess-1",
    };

    const result = await processToolUse(payload, undefined, canonicalLogPath, promptStatePath);
    expect(result).toBeNull();
    expect(skillUsageCount()).toBe(0);
  });

  test("ignores non-SKILL.md reads", async () => {
    const payload: PostToolUsePayload = {
      tool_name: "Read",
      tool_input: { file_path: "/src/utils.ts" },
      session_id: "sess-2",
    };

    const result = await processToolUse(payload, undefined, canonicalLogPath, promptStatePath);
    expect(result).toBeNull();
    expect(skillUsageCount()).toBe(0);
  });

  test("extracts skill name correctly and writes record with triggered=true when Skill tool was invoked", async () => {
    const transcriptPath = join(tmpDir, "transcript.jsonl");
    const lines = [
      JSON.stringify({ role: "user", content: "Create a presentation" }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "tool_use", name: "Skill", input: { skill: "pptx" } }],
      }),
    ];
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    await processPrompt(
      { user_prompt: "Create a presentation", session_id: "sess-3" },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );

    const payload: PostToolUsePayload = {
      tool_name: "Read",
      tool_input: { file_path: "/mnt/skills/public/pptx/SKILL.md" },
      session_id: "sess-3",
      transcript_path: transcriptPath,
    };

    const result = await processToolUse(payload, undefined, canonicalLogPath, promptStatePath);
    expect(result).not.toBeNull();
    expect(result?.skill_name).toBe("pptx");
    expect(result?.skill_path).toBe("/mnt/skills/public/pptx/SKILL.md");
    expect(result?.triggered).toBe(true);
    expect(result?.source).toBe("claude_code");
  });

  test("marks triggered=false when SKILL.md is read without Skill tool invocation (browsing)", async () => {
    const transcriptPath = join(tmpDir, "transcript-browse.jsonl");
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ role: "user", content: "Let me look at what skills are available" })}\n`,
    );

    await processPrompt(
      {
        user_prompt: "Let me look at what skills are available",
        session_id: "sess-3b",
      },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );

    const payload: PostToolUsePayload = {
      tool_name: "Read",
      tool_input: { file_path: "/mnt/skills/public/pptx/SKILL.md" },
      session_id: "sess-3b",
      transcript_path: transcriptPath,
    };

    const result = await processToolUse(payload, undefined, canonicalLogPath, promptStatePath);
    expect(result).not.toBeNull();
    expect(result?.skill_name).toBe("pptx");
    expect(result?.triggered).toBe(false);
  });

  test("finds user query from transcript", async () => {
    const transcriptPath = join(tmpDir, "transcript2.jsonl");
    const lines = [
      JSON.stringify({ role: "user", content: "First question" }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "Looking into it..." }],
      }),
      JSON.stringify({ role: "user", content: "Now make a PDF please" }),
    ];
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    const payload: PostToolUsePayload = {
      tool_name: "Read",
      tool_input: { file_path: "/skills/pdf/SKILL.md" },
      session_id: "sess-4",
      transcript_path: transcriptPath,
    };

    await processPrompt(
      { user_prompt: "Now make a PDF please", session_id: "sess-4" },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );
    const result = await processToolUse(payload, undefined, canonicalLogPath, promptStatePath);
    expect(result).not.toBeNull();
    expect(result?.query).toBe("Now make a PDF please");
  });

  test("skips logging when transcript is missing", async () => {
    const payload: PostToolUsePayload = {
      tool_name: "Read",
      tool_input: { file_path: "/skills/pdf/SKILL.md" },
      session_id: "sess-5",
      transcript_path: join(tmpDir, "nonexistent.jsonl"),
    };

    const result = await processToolUse(payload, undefined, canonicalLogPath, promptStatePath);
    expect(result).toBeNull();
    expect(skillUsageCount()).toBe(0);
  });

  test("skips logging when the latest transcript content is only meta output", async () => {
    const transcriptPath = join(tmpDir, "transcript-meta.jsonl");
    const lines = [
      JSON.stringify({ role: "user", content: "real user prompt" }),
      JSON.stringify({
        role: "user",
        content: "<local-command-stdout> tool output",
      }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "tool_use", name: "Skill", input: { skill: "pdf" } }],
      }),
    ];
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    const payload: PostToolUsePayload = {
      tool_name: "Read",
      tool_input: { file_path: "/skills/pdf/SKILL.md" },
      session_id: "sess-5b",
      transcript_path: transcriptPath,
    };

    await processPrompt(
      { user_prompt: "real user prompt", session_id: "sess-5b" },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );
    const result = await processToolUse(payload, undefined, canonicalLogPath, promptStatePath);
    expect(result).not.toBeNull();
    expect(result?.query).toBe("real user prompt");
  });

  test("writes correct usage record format", async () => {
    const transcriptPath = join(tmpDir, "transcript3.jsonl");
    const lines = [
      JSON.stringify({ role: "user", content: "Generate slides" }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "tool_use", name: "Skill", input: { skill: "pptx" } }],
      }),
    ];
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    await processPrompt(
      { user_prompt: "Generate slides", session_id: "sess-6" },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );

    const payload: PostToolUsePayload = {
      tool_name: "Read",
      tool_input: { file_path: "/skills/pptx/SKILL.md" },
      session_id: "sess-6",
      transcript_path: transcriptPath,
    };

    const result = await processToolUse(payload, undefined, canonicalLogPath, promptStatePath);
    expect(result).not.toBeNull();

    expect(result?.timestamp).toBeTruthy();
    expect(result?.session_id).toBe("sess-6");
    expect(result?.skill_name).toBe("pptx");
    expect(result?.skill_path).toBe("/skills/pptx/SKILL.md");
    expect(result?.query).toBe("Generate slides");
    expect(result?.triggered).toBe(true);
  });

  test("records global skill provenance for installed global skills", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const transcriptPath = join(tmpDir, "transcript-global.jsonl");
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ role: "user", content: "Use the global skill" })}\n${JSON.stringify({
          role: "assistant",
          content: [{ type: "tool_use", name: "Skill", input: { skill: "pptx" } }],
        })}\n`,
      );

      await processPrompt(
        { user_prompt: "Use the global skill", session_id: "sess-global" },
        undefined,
        canonicalLogPath,
        promptStatePath,
      );

      const result = await processToolUse(
        {
          tool_name: "Read",
          tool_input: {
            file_path: join(tmpDir, ".agents", "skills", "pptx", "SKILL.md"),
          },
          session_id: "sess-global",
          transcript_path: transcriptPath,
        },
        undefined,
        canonicalLogPath,
        promptStatePath,
      );

      expect(result).not.toBeNull();
      expect(result?.skill_scope).toBe("global");
      expect(result?.skill_registry_dir).toBe(join(tmpDir, ".agents", "skills"));
      expect(result?.skill_project_root).toBeUndefined();
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("persists the exact package hash and enriches the Skill event row", async () => {
    const transcriptPath = join(tmpDir, "transcript-versioned.jsonl");
    const skillPath = join(tmpDir, "skills", "reins", "SKILL.md");
    const skillContent = "---\nname: reins\n---\nAudit the repository.\n";
    const workflowContent = "Run the reproduction before editing.\n";
    mkdirSync(join(tmpDir, "skills", "reins"), { recursive: true });
    writeFileSync(skillPath, skillContent);
    writeFileSync(join(tmpDir, "skills", "reins", "Workflow.md"), workflowContent);
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ role: "user", content: "audit this repository" })}\n${JSON.stringify({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "skill-tool-versioned",
            name: "Skill",
            input: { skill: "reins" },
          },
        ],
      })}\n`,
    );

    await processPrompt(
      { user_prompt: "audit this repository", session_id: "sess-versioned" },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );
    await processToolUse(
      {
        tool_name: "Skill",
        tool_input: { skill: "reins" },
        tool_use_id: "skill-tool-versioned",
        session_id: "sess-versioned",
        transcript_path: transcriptPath,
      },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );
    await processToolUse(
      {
        tool_name: "Read",
        tool_input: { file_path: skillPath },
        session_id: "sess-versioned",
        transcript_path: transcriptPath,
      },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );

    const row = getDb()
      .query<
        Pick<typeof skill_invocations.$inferSelect, "skill_path" | "skill_version_hash">,
        string[]
      >(
        "SELECT skill_path, skill_version_hash FROM skill_invocations WHERE skill_invocation_id = ?",
      )
      .get("sess-versioned:s:reins:event:skill-tool-versioned");
    assert.ok(row);
    expect(row.skill_path).toBe(skillPath);
    const manifest = [
      {
        path: "SKILL.md",
        hash: createHash("sha256").update(skillContent).digest("hex"),
        size: Buffer.byteLength(skillContent),
      },
      {
        path: "Workflow.md",
        hash: createHash("sha256").update(workflowContent).digest("hex"),
        size: Buffer.byteLength(workflowContent),
      },
    ];
    expect(row.skill_version_hash).toBe(
      createHash("sha256").update(canonicalizeSkillPackageManifest(manifest)).digest("hex"),
    );
  });
});
