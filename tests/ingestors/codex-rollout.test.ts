import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCanonicalRecordsFromRollout,
  findRolloutFiles,
  findSkillNames,
  ingestFile,
  parseRolloutFile,
} from "@selftune/harness-codex/ingestors/codex-rollout";
import { NORMALIZER_VERSION } from "../../packages/runtime/normalization.js";
import { _setTestDb, getDb, openDb } from "../../packages/runtime/localdb/db.js";
import { writeSkillInvocationToDb } from "../../packages/runtime/localdb/direct-write.js";
import {
  fingerprintIngestionFile,
  isFileIngestionCurrent,
  loadFileIngestionMarker,
  saveFileIngestionMarker,
} from "../../packages/runtime/utils/jsonl.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-codex-rollout-"));
  const testDb = openDb(":memory:");
  _setTestDb(testDb);
});

afterEach(() => {
  _setTestDb(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a rollout file in the expected YYYY/MM/DD directory structure. */
function createRolloutFile(
  codexHome: string,
  year: string,
  month: string,
  day: string,
  filename: string,
  content: string,
): string {
  const dir = join(codexHome, "sessions", year, month, day);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("findRolloutFiles", () => {
  test("finds files in YYYY/MM/DD structure", () => {
    const codexHome = join(tmpDir, "codex");
    createRolloutFile(
      codexHome,
      "2026",
      "01",
      "15",
      "rollout-abc123.jsonl",
      '{"type":"turn.started"}\n',
    );
    createRolloutFile(
      codexHome,
      "2026",
      "02",
      "10",
      "rollout-def456.jsonl",
      '{"type":"turn.started"}\n',
    );

    const files = findRolloutFiles(codexHome);
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("rollout-abc123.jsonl");
    expect(files[1]).toContain("rollout-def456.jsonl");
  });

  test("filters by --since date", () => {
    const codexHome = join(tmpDir, "codex");
    createRolloutFile(
      codexHome,
      "2026",
      "01",
      "01",
      "rollout-old.jsonl",
      '{"type":"turn.started"}\n',
    );
    createRolloutFile(
      codexHome,
      "2026",
      "02",
      "15",
      "rollout-new.jsonl",
      '{"type":"turn.started"}\n',
    );
    createRolloutFile(
      codexHome,
      "2026",
      "03",
      "01",
      "rollout-newer.jsonl",
      '{"type":"turn.started"}\n',
    );

    const since = new Date(2026, 1, 1); // Feb 1 2026
    const files = findRolloutFiles(codexHome, since);
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("rollout-new.jsonl");
    expect(files[1]).toContain("rollout-newer.jsonl");
  });

  test("returns empty for missing sessions dir", () => {
    const files = findRolloutFiles(join(tmpDir, "nonexistent"));
    expect(files).toEqual([]);
  });

  test("ignores non-rollout files", () => {
    const codexHome = join(tmpDir, "codex");
    createRolloutFile(codexHome, "2026", "01", "15", "rollout-abc.jsonl", "data\n");
    createRolloutFile(codexHome, "2026", "01", "15", "other-file.jsonl", "data\n");
    createRolloutFile(codexHome, "2026", "01", "15", "readme.md", "data\n");

    const files = findRolloutFiles(codexHome);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("rollout-abc.jsonl");
  });
});

describe("parseRolloutFile", () => {
  test("discovers repo-local and global agent skills from .agents/skills", () => {
    const repoRoot = join(tmpDir, "workspace");
    const workspace = join(repoRoot, "apps", "web");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(repoRoot, ".git"), "gitdir: ./.git/worktrees/web\n", "utf-8");
    mkdirSync(join(repoRoot, ".agents", "skills", "LocalSkill"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".agents", "skills", "LocalSkill", "SKILL.md"),
      "# local",
      "utf-8",
    );
    mkdirSync(join(tmpDir, ".agents", "skills", "TooHigh"), { recursive: true });
    writeFileSync(join(tmpDir, ".agents", "skills", "TooHigh", "SKILL.md"), "# nope", "utf-8");

    const home = join(tmpDir, "home");
    mkdirSync(join(home, ".agents", "skills", "GlobalSkill"), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", "GlobalSkill", "SKILL.md"), "# global", "utf-8");
    const adminDir = join(tmpDir, "etc", "codex", "skills");
    mkdirSync(join(adminDir, "AdminSkill"), { recursive: true });
    writeFileSync(join(adminDir, "AdminSkill", "SKILL.md"), "# admin", "utf-8");
    const codexHome = join(tmpDir, "codex-home");
    mkdirSync(join(codexHome, "skills", ".system", "SystemSkill"), { recursive: true });
    writeFileSync(
      join(codexHome, "skills", ".system", "SystemSkill", "SKILL.md"),
      "# system",
      "utf-8",
    );

    expect(findSkillNames(workspace, home, adminDir, codexHome)).toEqual(
      new Set(["LocalSkill", "GlobalSkill", "AdminSkill", "SystemSkill"]),
    );
  });

  test("extracts metrics from events", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"item_type":"command_execution","command":"npm test","exit_code":0}}',
      '{"type":"item.completed","item":{"item_type":"file_change"}}',
      '{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":100}}',
    ].join("\n");

    const path = createRolloutFile(codexHome, "2026", "03", "15", "rollout-test-id.jsonl", content);
    const result = parseRolloutFile(path, new Set());

    expect(result).not.toBeNull();
    expect(result?.session_id).toBe("test-id");
    expect(result?.assistant_turns).toBe(1);
    expect(result?.tool_calls.command_execution).toBe(1);
    expect(result?.tool_calls.file_change).toBe(1);
    expect(result?.total_tool_calls).toBe(2);
    expect(result?.bash_commands).toEqual(["npm test"]);
    expect(result?.input_tokens).toBe(200);
    expect(result?.output_tokens).toBe(100);
    expect(result?.source).toBe("codex_rollout");
  });

  test("extracts prompt from event data", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      '{"type":"turn.started"}',
      '{"type":"turn.completed","user_message":"build the project"}',
    ].join("\n");

    const path = createRolloutFile(codexHome, "2026", "01", "01", "rollout-abc.jsonl", content);
    const result = parseRolloutFile(path, new Set());

    expect(result).not.toBeNull();
    expect(result?.query).toBe("build the project");
    expect(result?.last_user_query).toBe("build the project");
  });

  test("keeps the first actionable prompt in multi-turn rollouts", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      '{"type":"event_msg","payload":{"type":"user_message","message":"Continue from where you left off."}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"build the project"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"also add deployment checks"}}',
    ].join("\n");

    const path = createRolloutFile(
      codexHome,
      "2026",
      "01",
      "01",
      "rollout-first-actionable.jsonl",
      content,
    );
    const result = parseRolloutFile(path, new Set());

    expect(result?.query).toBe("build the project");
    expect(result?.last_user_query).toBe("also add deployment checks");
  });

  test("normalizes conductor-wrapped prompts to the underlying user query", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "user_message",
          message:
            "<system_instruction>hidden prompt</system_instruction>\n\nmy claude code isn't working with conductor.build anymore",
        },
      }),
    ].join("\n");

    const path = createRolloutFile(codexHome, "2026", "03", "11", "rollout-wrapped.jsonl", content);
    const result = parseRolloutFile(path, new Set(["selftune"]));

    expect(result?.query).toBe("my claude code isn't working with conductor.build anymore");
    expect(result?.last_user_query).toContain("<system_instruction>");
  });

  test("ignores skill inventory inside conductor-wrapped user prompts", () => {
    const codexHome = join(tmpDir, "codex");
    const wrappedInstructions = [
      "# AGENTS.md instructions for /",
      "",
      "<INSTRUCTIONS>",
      "### Available skills",
      "- Reins: Reins CLI skill. (file: /Users/danielpetro/.agents/skills/reins/SKILL.md)",
      "- agent-browser: Browser automation CLI. (file: /Users/danielpetro/.agents/skills/agent-browser/SKILL.md)",
      "</INSTRUCTIONS>",
    ].join("\n");
    const optimizerPrompt = [
      "You are a skill description optimizer for an AI agent routing system.",
      "",
      "Skill Name: CORE",
    ].join("\n");
    const content = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: wrappedInstructions },
            {
              type: "input_text",
              text: "<environment_context>\n  <cwd>/</cwd>\n</environment_context>",
            },
            { type: "input_text", text: optimizerPrompt },
          ],
        },
      }),
    ].join("\n");

    const path = createRolloutFile(
      codexHome,
      "2026",
      "03",
      "11",
      "rollout-wrapped-skills.jsonl",
      content,
    );
    const result = parseRolloutFile(path, new Set(["reins", "agent-browser", "CORE"]));

    expect(result?.skills_triggered).toEqual(["CORE"]);
  });

  test("detects explicit skill file reads in completed items", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      '{"type":"item.completed","item":{"item_type":"command_execution","command":"cat .agents/skills/DeploySkill/SKILL.md","exit_code":0}}',
    ].join("\n");

    const path = createRolloutFile(codexHome, "2026", "01", "01", "rollout-sk.jsonl", content);
    const result = parseRolloutFile(path, new Set(["DeploySkill"]));

    expect(result?.skills_triggered).toEqual(["DeploySkill"]);
  });

  test("returns null for empty file", () => {
    const codexHome = join(tmpDir, "codex");
    const path = createRolloutFile(codexHome, "2026", "01", "01", "rollout-empty.jsonl", "");
    expect(parseRolloutFile(path, new Set())).toBeNull();
  });

  test("bounds oversized JSONL records while preserving surrounding metadata", () => {
    const codexHome = join(tmpDir, "codex");
    const oversizedToolOutput = "x".repeat(9 * 1024 * 1024);
    const content = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-23T10:00:00.000Z",
        payload: { id: "bounded-rollout" },
      }),
      oversizedToolOutput,
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-23T10:00:01.000Z",
        payload: { type: "user_message", message: "Keep the parser bounded" },
      }),
    ].join("\n");
    const path = createRolloutFile(codexHome, "2026", "07", "23", "rollout-bounded.jsonl", content);

    const result = parseRolloutFile(path, new Set());

    expect(result?.session_id).toBe("bounded-rollout");
    expect(result?.query).toBe("Keep the parser bounded");
    expect(result?.started_at).toBe("2026-07-23T10:00:00.000Z");
    expect(result?.ended_at).toBe("2026-07-23T10:00:01.000Z");
    expect(result?.transcript_chars).toBeGreaterThan(9 * 1024 * 1024);
  });

  test("counts errors from turn.failed and error events", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      '{"type":"turn.failed","error":{"message":"timeout"}}',
      '{"type":"error","message":"fatal"}',
      '{"type":"item.completed","item":{"item_type":"command_execution","command":"exit 1","exit_code":1}}',
    ].join("\n");

    const path = createRolloutFile(codexHome, "2026", "01", "01", "rollout-err.jsonl", content);
    const result = parseRolloutFile(path, new Set());

    expect(result?.errors_encountered).toBe(3);
  });

  test("infers timestamp from path structure", () => {
    const codexHome = join(tmpDir, "codex");
    const content = '{"type":"turn.started"}\n';
    const path = createRolloutFile(codexHome, "2026", "06", "20", "rollout-ts.jsonl", content);
    const result = parseRolloutFile(path, new Set());

    expect(result?.timestamp).toContain("2026-06-20");
  });

  test("parses observed local rollout format (session_meta/event_msg)", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      '{"type":"session_meta","payload":{"id":"obs-session-1","cwd":"/project","model_provider":"openai","model":"gpt-4o","originator":"codex-cli"}}',
      '{"type":"turn_context","payload":{"approval_policy":"auto","sandbox_policy":"container","model":"gpt-4o","git":{"branch":"main","remote":"origin","commit":"abc123"}}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"Continue from where you left off."}}',
      '{"type":"session_meta","payload":{"id":"obs-session-1","originator":"codex-cli-secondary"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"Build the project"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"write_file","arguments":"{}"}}',
      '{"type":"response_item","payload":{"type":"agent_reasoning","text":"Let me think about this"}}',
      '{"type":"event_msg","payload":{"type":"usage","token_count":{"input_tokens":500,"output_tokens":250}}}',
    ].join("\n");

    const path = createRolloutFile(
      codexHome,
      "2026",
      "03",
      "10",
      "rollout-observed.jsonl",
      content,
    );
    const result = parseRolloutFile(path, new Set());

    expect(result).not.toBeNull();
    expect(result?.session_id).toBe("obs-session-1");
    expect(result?.cwd).toBe("/project");
    expect(result?.query).toBe("Build the project");
    expect(result?.assistant_turns).toBe(1); // turn_context counts as a turn
    expect(result?.input_tokens).toBe(500);
    expect(result?.output_tokens).toBe(250);
    expect(result?.tool_calls.write_file).toBe(1);
    expect(result?.tool_calls.reasoning).toBe(1);
    expect(result?.observed_meta).toBeTruthy();
    expect(result?.observed_meta?.model_provider).toBe("openai");
    expect(result?.observed_meta?.model).toBe("gpt-4o");
    expect(result?.observed_meta?.originator).toBe("codex-cli-secondary");
    expect(result?.observed_meta?.approval_policy).toBe("auto");
    expect(result?.observed_meta?.sandbox_policy).toBe("container");
    expect(result?.observed_meta?.git?.branch).toBe("main");
    expect(result?.observed_meta?.git?.commit).toBe("abc123");
  });

  test("extracts session-scoped skill inventory from instructions text", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      '{"type":"session_meta","payload":{"id":"obs-session-2","cwd":"/project","instructions":"## Skills\\n### Available skills\\n- selftune: Self-improving skills toolkit.\\n- paperclip: Paperclip operator skill.\\n### How to use skills"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"cat .agents/skills/selftune/SKILL.md && cat .agents/skills/paperclip/SKILL.md\\"}"}}',
    ].join("\n");

    const path = createRolloutFile(
      codexHome,
      "2026",
      "03",
      "12",
      "rollout-session-skills.jsonl",
      content,
    );
    const result = parseRolloutFile(path, new Set());

    expect(result?.skills_triggered).toContain("selftune");
    expect(result?.skills_triggered).toContain("paperclip");
  });

  test("marks explicit skill file reads as invoked", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      '{"type":"session_meta","payload":{"id":"obs-session-3","cwd":"/project","instructions":"### Available skills\\n- selftune: Self-improving skills toolkit.\\n### How to use skills"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"cat .agents/skills/selftune/SKILL.md\\"}"}}',
    ].join("\n");

    const path = createRolloutFile(
      codexHome,
      "2026",
      "03",
      "12",
      "rollout-explicit-skill.jsonl",
      content,
    );
    const result = parseRolloutFile(path, new Set(["selftune"]));

    expect(result?.skills_triggered).toContain("selftune");
    expect(result?.skills_invoked).toContain("selftune");
    expect(result?.skill_evidence.selftune).toBe("explicit");
  });

  test("parses Codex Desktop custom tool calls and their skill reads", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      '{"type":"session_meta","payload":{"id":"desktop-session","cwd":"/project","instructions":"### Available skills\\n- serve-sim: Run an app in an iOS simulator.\\n### How to use skills"}}',
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          status: "completed",
          input: [
            "const result = await tools.exec_command({",
            "  cmd: \"sed -n '1,220p' /project/.agents/skills/serve-sim/SKILL.md\",",
            '  workdir: "/project"',
            "});",
            "text(result.output);",
          ].join("\n"),
        },
      }),
    ].join("\n");

    const path = createRolloutFile(
      codexHome,
      "2026",
      "06",
      "06",
      "rollout-desktop-custom-tool.jsonl",
      content,
    );
    const result = parseRolloutFile(path, new Set(["serve-sim"]));

    expect(result?.tool_calls.exec).toBe(1);
    expect(result?.skills_triggered).toContain("serve-sim");
    expect(result?.skills_invoked).toContain("serve-sim");
    expect(result?.skill_evidence["serve-sim"]).toBe("explicit");
  });

  test("treats an attached project skill path in an actionable user turn as invoked", () => {
    const codexHome = join(tmpDir, "codex");
    const skillPath = "/project/.agents/skills/serve-sim/SKILL.md";
    const content = [
      '{"type":"session_meta","payload":{"id":"obs-session-attached-skill","cwd":"/project","instructions":"### Available skills\\n- serve-sim: Run an app in an iOS simulator.\\n### How to use skills"}}',
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `<system_instruction>\nThe user attached ${skillPath}\n</system_instruction>\n\nuse it ${skillPath}`,
            },
          ],
        },
      }),
    ].join("\n");

    const path = createRolloutFile(
      codexHome,
      "2026",
      "03",
      "12",
      "rollout-attached-skill.jsonl",
      content,
    );
    const result = parseRolloutFile(path, new Set(["serve-sim"]));

    expect(result?.skills_triggered).toContain("serve-sim");
    expect(result?.skills_invoked).toContain("serve-sim");
    expect(result?.skill_evidence["serve-sim"]).toBe("explicit");
  });

  test("ignores incidental user mentions that do not explicitly invoke a skill", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      '{"type":"session_meta","payload":{"id":"obs-session-5","cwd":"/project","instructions":"### Available skills\\n- selftune: Self-improving skills toolkit.\\n### How to use skills"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"the selftune dashboard is broken and ugly try to test it yourself"}}',
    ].join("\n");

    const path = createRolloutFile(
      codexHome,
      "2026",
      "03",
      "12",
      "rollout-inferred-prompt-skill.jsonl",
      content,
    );
    const result = parseRolloutFile(path, new Set());

    expect(result?.skills_triggered).not.toContain("selftune");
    expect(result?.skills_invoked).not.toContain("selftune");
    expect(result?.skill_evidence.selftune).toBeUndefined();
  });

  test("does not infer cross-skill triggers from optimizer prompts", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      '{"type":"session_meta","payload":{"id":"obs-session-6","cwd":"/project","instructions":"### Available skills\\n- reins: Reins CLI skill for scaffold/audit/doctor/evolve workflows.\\n- CORE: Personal AI Infrastructure core.\\n### How to use skills"}}',
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "You are a skill description optimizer for an AI agent routing system.",
                "",
                "Skill Name: CORE",
                "",
                "Failure Patterns:",
                '  - "Draft a simple post about the open-source project Reins"',
                '  - "Write a blog post about Reins"',
              ].join("\n"),
            },
          ],
        },
      }),
    ].join("\n");

    const path = createRolloutFile(
      codexHome,
      "2026",
      "03",
      "12",
      "rollout-no-cross-skill-inference.jsonl",
      content,
    );
    const result = parseRolloutFile(path, new Set(["reins", "CORE"]));

    expect(result?.skills_triggered).toEqual(["CORE"]);
  });

  test("ignores non-string observed metadata payload fields", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      '{"type":"session_meta","payload":{"id":123,"cwd":{"path":"/project"},"model_provider":["openai"],"model":false,"originator":42}}',
      '{"type":"turn_context","payload":{"approval_policy":7,"sandbox_policy":{"mode":"container"},"model":["gpt-4o"],"git":{"branch":99,"remote":true,"commit":["abc123"]}}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"Build the project"}}',
    ].join("\n");

    const path = createRolloutFile(
      codexHome,
      "2026",
      "03",
      "10",
      "rollout-observed-invalid-meta.jsonl",
      content,
    );
    const result = parseRolloutFile(path, new Set());

    expect(result?.session_id).toBe("observed-invalid-meta");
    expect(result?.cwd).toBe("");
    expect(result?.query).toBe("Build the project");
    expect(result?.last_user_query).toBe("Build the project");
    expect(result?.observed_meta?.model_provider).toBeUndefined();
    expect(result?.observed_meta?.model).toBeUndefined();
    expect(result?.observed_meta?.originator).toBeUndefined();
    expect(result?.observed_meta?.approval_policy).toBeUndefined();
    expect(result?.observed_meta?.sandbox_policy).toBeUndefined();
    expect(result?.observed_meta?.git?.branch).toBeUndefined();
    expect(result?.observed_meta?.git?.remote).toBeUndefined();
    expect(result?.observed_meta?.git?.commit).toBeUndefined();
  });
});

describe("ingestFile", () => {
  test("writes query, telemetry, and skill logs", () => {
    const queryLog = join(tmpDir, "queries.jsonl");
    const telemetryLog = join(tmpDir, "telemetry.jsonl");
    const skillLog = join(tmpDir, "skills.jsonl");
    const canonicalLog = join(tmpDir, "canonical.jsonl");

    const parsed = {
      timestamp: "2026-03-15T00:00:00.000Z",
      session_id: "sess-123",
      source: "codex_rollout",
      rollout_path: "/some/path",
      query: "build the app",
      tool_calls: { command_execution: 1 },
      total_tool_calls: 1,
      bash_commands: ["npm test"],
      skills_triggered: ["MySkill"],
      skills_invoked: ["MySkill"],
      skill_evidence: { MySkill: "explicit" as const },
      assistant_turns: 2,
      errors_encountered: 0,
      input_tokens: 100,
      output_tokens: 50,
      transcript_chars: 500,
      cwd: "",
      transcript_path: "/some/path",
      last_user_query: "build the app",
    };

    ingestFile(parsed, false, queryLog, telemetryLog, skillLog, canonicalLog);

    // Verify query written to SQLite
    const db = getDb();
    const queryRow = db
      .query("SELECT query, source FROM queries WHERE session_id = ?")
      .get("sess-123") as { query: string; source: string } | null;
    expect(queryRow).toBeTruthy();
    expect(queryRow?.query).toBe("build the app");
    expect(queryRow?.source).toBe("codex_rollout");

    // Verify telemetry written to SQLite
    const telemetryRow = db
      .query("SELECT session_id, assistant_turns FROM session_telemetry WHERE session_id = ?")
      .get("sess-123") as { session_id: string; assistant_turns: number } | null;
    expect(telemetryRow).toBeTruthy();
    expect(telemetryRow?.session_id).toBe("sess-123");
    expect(telemetryRow?.assistant_turns).toBe(2);

    // Verify skill usage written to SQLite
    const skillRow = db
      .query("SELECT skill_name, skill_path, source FROM skill_usage WHERE session_id = ?")
      .get("sess-123") as { skill_name: string; skill_path: string; source: string } | null;
    expect(skillRow).toBeTruthy();
    expect(skillRow?.skill_name).toBe("MySkill");
    expect(skillRow?.skill_path).toBe("(codex:MySkill)");
    expect(skillRow?.source).toBe("codex_rollout_explicit");

    // Verify canonical records structure via the exported builder
    const canonicalRecords = buildCanonicalRecordsFromRollout(parsed);
    const canonicalPrompt = canonicalRecords.find((r) => r.record_kind === "prompt");
    expect(canonicalPrompt).toBeTruthy();
    expect((canonicalPrompt as Record<string, unknown>).platform).toBe("codex");
    expect((canonicalPrompt as Record<string, unknown>).capture_mode).toBe("batch_ingest");
  });

  test("records project-scoped provenance for explicit repo-local skill reads", () => {
    const repoRoot = join(tmpDir, "workspace");
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, ".git"), "gitdir: ./.git/worktrees/workspace\n", "utf-8");
    mkdirSync(join(repoRoot, ".agents", "skills", "MySkill"), { recursive: true });
    writeFileSync(join(repoRoot, ".agents", "skills", "MySkill", "SKILL.md"), "# my skill");

    ingestFile(
      {
        timestamp: "2026-03-15T00:00:00.000Z",
        session_id: "sess-project",
        source: "codex_rollout",
        rollout_path: "/some/path",
        query: "build the app",
        tool_calls: { command_execution: 1 },
        total_tool_calls: 1,
        bash_commands: ["npm test"],
        skills_triggered: ["MySkill"],
        skills_invoked: ["MySkill"],
        skill_evidence: { MySkill: "explicit" as const },
        assistant_turns: 1,
        errors_encountered: 0,
        input_tokens: 100,
        output_tokens: 50,
        transcript_chars: 200,
        cwd: repoRoot,
        transcript_path: "/some/path",
        last_user_query: "build the app",
      },
      false,
      join(tmpDir, "queries-project.jsonl"),
      join(tmpDir, "telemetry-project.jsonl"),
      join(tmpDir, "skills-project.jsonl"),
      join(tmpDir, "canonical-project.jsonl"),
    );

    // Verify skill record written to SQLite with project-scoped provenance
    const db = getDb();
    const skillRow = db
      .query("SELECT skill_path, skill_scope FROM skill_usage WHERE session_id = ?")
      .get("sess-project") as { skill_path: string; skill_scope: string | null } | null;
    expect(skillRow).toBeTruthy();
    expect(skillRow?.skill_path).toEndWith(".agents/skills/MySkill/SKILL.md");
    expect(skillRow?.skill_scope).toBe("project");
  });

  test("replaces canonical skill facts when an appended rollout is reprocessed", () => {
    const base = {
      timestamp: "2026-03-15T00:00:00.000Z",
      session_id: "sess-appended-snapshot",
      source: "codex_rollout",
      rollout_path: "/some/appended-rollout.jsonl",
      query: "build the app",
      tool_calls: { command_execution: 1 },
      total_tool_calls: 1,
      bash_commands: ["npm test"],
      skills_invoked: ["serve-sim"],
      assistant_turns: 2,
      errors_encountered: 0,
      input_tokens: 100,
      output_tokens: 50,
      transcript_chars: 500,
      cwd: "",
      transcript_path: "/some/appended-rollout.jsonl",
      last_user_query: "build the app",
    };

    const first = {
      ...base,
      skills_triggered: ["removed-skill", "serve-sim"],
      skill_evidence: { "removed-skill": "inferred", "serve-sim": "explicit" } as const,
    };
    ingestFile(first);
    const firstServeSimId = (
      getDb()
        .query("SELECT skill_invocation_id FROM skill_invocations WHERE skill_name = 'serve-sim'")
        .get() as { skill_invocation_id: string }
    ).skill_invocation_id;
    writeSkillInvocationToDb({
      skill_invocation_id: `${base.session_id}:hook:preserved`,
      session_id: base.session_id,
      occurred_at: base.timestamp,
      skill_name: "hook-skill",
      invocation_mode: "explicit",
      triggered: true,
      confidence: 1,
      platform: "codex",
      capture_mode: "hook",
    });

    const current = {
      ...base,
      query: "continue building the app",
      last_user_query: "continue building the app",
      total_tool_calls: 2,
      skills_triggered: ["new-skill", "serve-sim"],
      skill_evidence: { "new-skill": "inferred", "serve-sim": "explicit" } as const,
    };
    ingestFile(current);
    ingestFile(current);

    const db = getDb();
    const rows = db
      .query(
        `SELECT skill_name, skill_invocation_id, capture_mode
         FROM skill_invocations
         WHERE session_id = ?
         ORDER BY skill_name`,
      )
      .all(base.session_id) as Array<{
      skill_name: string;
      skill_invocation_id: string;
      capture_mode: string;
    }>;
    expect(rows.map((row) => row.skill_name)).toEqual(["hook-skill", "new-skill", "serve-sim"]);
    expect(rows.filter((row) => row.skill_name === "serve-sim")).toHaveLength(1);
    expect(rows.find((row) => row.skill_name === "serve-sim")?.skill_invocation_id).toBe(
      firstServeSimId,
    );
    expect(rows.find((row) => row.skill_name === "hook-skill")?.capture_mode).toBe("hook");

    const prompt = db
      .query(
        `SELECT prompt_text, normalizer_version FROM prompts
         WHERE session_id = ? AND platform = 'codex' AND capture_mode = 'batch_ingest'`,
      )
      .get(base.session_id) as { prompt_text: string; normalizer_version: string };
    expect(prompt.prompt_text).toBe("continue building the app");

    const facts = db
      .query(
        `SELECT total_tool_calls, normalizer_version FROM execution_facts
         WHERE session_id = ? AND platform = 'codex' AND capture_mode = 'batch_ingest'`,
      )
      .all(base.session_id) as Array<{ total_tool_calls: number; normalizer_version: string }>;
    expect(facts).toHaveLength(1);
    expect(facts[0]?.total_tool_calls).toBe(2);
    expect(facts[0]?.normalizer_version).toBe(prompt.normalizer_version);
  });

  test("skips short queries", () => {
    const queryLog = join(tmpDir, "queries.jsonl");
    const telemetryLog = join(tmpDir, "telemetry.jsonl");
    const skillLog = join(tmpDir, "skills.jsonl");
    const canonicalLog = join(tmpDir, "canonical.jsonl");

    const parsed = {
      timestamp: "2026-03-15T00:00:00.000Z",
      session_id: "sess-123",
      source: "codex_rollout",
      rollout_path: "/p",
      query: "hi",
      tool_calls: {},
      total_tool_calls: 0,
      bash_commands: [],
      skills_triggered: ["MySkill"],
      skills_invoked: [],
      skill_evidence: { MySkill: "inferred" as const },
      assistant_turns: 0,
      errors_encountered: 0,
      input_tokens: 0,
      output_tokens: 0,
      transcript_chars: 0,
      cwd: "",
      transcript_path: "/p",
      last_user_query: "hi",
    };

    ingestFile(parsed, false, queryLog, telemetryLog, skillLog, canonicalLog);

    // Query should NOT be written to SQLite (short prompt)
    const db = getDb();
    const queryCount = (
      db.query("SELECT COUNT(*) as cnt FROM queries WHERE session_id = ?").get("sess-123") as {
        cnt: number;
      }
    ).cnt;
    expect(queryCount).toBe(0);
    // Telemetry should still be written
    const telemetryCount = (
      db
        .query("SELECT COUNT(*) as cnt FROM session_telemetry WHERE session_id = ?")
        .get("sess-123") as { cnt: number }
    ).cnt;
    expect(telemetryCount).toBe(1);

    // Verify canonical records for short-query case via builder
    const canonicalRecords = buildCanonicalRecordsFromRollout(parsed);
    const prompt = canonicalRecords.find((r) => r.record_kind === "prompt");
    const invocation = canonicalRecords.find((r) => r.record_kind === "skill_invocation");
    const executionFact = canonicalRecords.find((r) => r.record_kind === "execution_fact");
    expect(prompt).toBeUndefined();
    expect(invocation).toBeTruthy();
    expect(executionFact).toBeTruthy();
    expect((invocation as Record<string, unknown>)?.matched_prompt_id).toBeUndefined();
    expect((executionFact as Record<string, unknown>)?.prompt_id).toBeUndefined();
  });
});

describe("marker file tracks ingested files", () => {
  test("reprocesses an unchanged rollout after the wrapper-filter normalizer bump", () => {
    const markerPath = join(tmpDir, "marker.json");
    const rolloutPath = createRolloutFile(
      join(tmpDir, "codex"),
      "2026",
      "08",
      "24",
      "rollout-wrapper-version.jsonl",
      "<codex_internal_context>internal</codex_internal_context>\n",
    );
    const previous = fingerprintIngestionFile(rolloutPath, "1.2.0");
    saveFileIngestionMarker(markerPath, new Map([[rolloutPath, previous]]));
    const loaded = loadFileIngestionMarker(markerPath);
    const current = fingerprintIngestionFile(rolloutPath, NORMALIZER_VERSION);

    expect(current.normalizer_version).not.toBe(previous.normalizer_version);
    expect(isFileIngestionCurrent(loaded, rolloutPath, current)).toBe(false);
  });

  test("reprocesses an ingested rollout after it is appended", () => {
    const markerPath = join(tmpDir, "marker.json");
    const rolloutPath = createRolloutFile(
      join(tmpDir, "codex"),
      "2026",
      "01",
      "15",
      "rollout-append-aware.jsonl",
      [JSON.stringify({ type: "session_meta", payload: { id: "append-aware" } })].join("\n"),
    );
    const initial = fingerprintIngestionFile(rolloutPath, "1.1.0");
    saveFileIngestionMarker(markerPath, new Map([[rolloutPath, initial]]));
    const loaded = loadFileIngestionMarker(markerPath);
    expect(isFileIngestionCurrent(loaded, rolloutPath, initial)).toBe(true);

    writeFileSync(
      rolloutPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "append-aware" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "later" } }),
      ].join("\n"),
    );
    const appended = fingerprintIngestionFile(rolloutPath, "1.1.0");
    expect(isFileIngestionCurrent(loaded, rolloutPath, appended)).toBe(false);
  });
});
