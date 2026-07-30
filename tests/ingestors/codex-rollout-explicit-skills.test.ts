import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRolloutFile } from "@selftune/harness-codex/ingestors/codex-rollout";

let temporaryRoot = "";

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "selftune-codex-explicit-skills-"));
});

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

function writeRollout(name: string, body: string): string {
  const directory = join(temporaryRoot, "sessions", "2026", "03", "12");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, body, "utf8");
  return path;
}

test("treats explicit prompt mention as an invoked skill", () => {
  const path = writeRollout(
    "rollout-explicit-prompt-skill.jsonl",
    [
      '{"type":"session_meta","payload":{"id":"obs-session-4","cwd":"/project","instructions":"### Available skills\\n- Reins: Reins CLI skill for scaffold/audit/doctor/evolve workflows.\\n### How to use skills"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"audit the project with reins"}}',
    ].join("\n"),
  );

  const result = parseRolloutFile(path, new Set(["reins"]));

  expect(result?.query).toBe("audit the project with reins");
  expect(result?.skills_triggered).toContain("reins");
  expect(result?.skills_triggered).not.toContain("Reins");
  expect(result?.skills_invoked).toContain("reins");
  expect(result?.skill_evidence.reins).toBe("explicit");
});

test("canonicalizes mixed-case explicit prompt skill mentions", () => {
  const path = writeRollout(
    "rollout-mixed-case-explicit-prompt.jsonl",
    '{"type":"event_msg","payload":{"type":"user_message","message":"use reins"}}\n',
  );

  const result = parseRolloutFile(path, new Set(["Reins"]));

  expect(result?.skills_triggered).toEqual(["Reins"]);
  expect(result?.skills_invoked).toEqual(["Reins"]);
});
