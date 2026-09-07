import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCreateScaffold } from "../../packages/runtime/create/scaffold.js";
import { _setTestDb, openDb } from "../../packages/runtime/localdb/db.js";
import {
  writeSessionTelemetryToDb,
  writeSkillCheckToDb,
} from "../../packages/runtime/localdb/direct-write.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "selftune-scaffold-query-"));
  _setTestDb(openDb(":memory:"));
  for (let index = 1; index <= 3; index++) {
    const sessionId = `session-${index}`;
    const timestamp = `2026-09-0${index}T10:00:00Z`;
    writeSessionTelemetryToDb({
      timestamp,
      session_id: sessionId,
      cwd: root,
      transcript_path: join(root, `${sessionId}.jsonl`),
      tool_calls: {},
      total_tool_calls: 0,
      bash_commands: [],
      skills_triggered: ["Draft", "Review"],
      assistant_turns: 2,
      errors_encountered: 0,
      transcript_chars: 100,
      last_user_query: "Draft and review a document",
    });
    for (const [offset, skillName] of ["Draft", "Review"].entries()) {
      writeSkillCheckToDb({
        skill_invocation_id: `${sessionId}-${skillName}`,
        session_id: sessionId,
        occurred_at: `2026-09-0${index}T10:0${offset}:00Z`,
        skill_name: skillName,
        invocation_mode: "explicit",
        confidence: 1,
        triggered: true,
        query: "Draft and review a document",
        skill_path: join(root, skillName, "SKILL.md"),
      });
    }
  }
});
afterEach(() => {
  _setTestDb(null);
  rmSync(root, { recursive: true, force: true });
});

test("canonical SQLite observations produce a workflow package preview without writing it", () => {
  const outputDir = join(root, "output");
  const result = runCreateScaffold({ fromWorkflow: "1", outputDir });
  expect(result.mode).toBe("preview");
  expect(result.draft.content).toContain("Draft");
  expect(result.draft.content).toContain("Review");
  expect(result.draft.content).toContain("Draft and review a document");
  expect(result.draft.files.map((file) => file.relative_path)).toEqual([
    "SKILL.md",
    "workflows/default.md",
    "references/overview.md",
    "selftune.create.json",
  ]);
  expect(existsSync(outputDir)).toBe(false);
});

test("an invalid workflow selection fails before a scaffold is written", () => {
  const outputDir = join(root, "output");
  expect(() =>
    runCreateScaffold({ fromWorkflow: "missing-workflow", outputDir, write: true }),
  ).toThrow("No workflow found");
  expect(existsSync(outputDir)).toBe(false);
});
