import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCanonicalRecordsFromRollout,
  findRolloutFiles,
  findSkillNames,
  ingestFile,
  parseRolloutFile,
} from "../../cli/selftune/ingestors/codex-rollout.js";
import { _setTestDb, getDb, openDb } from "../../cli/selftune/localdb/db.js";
import { loadMarker, saveMarker } from "../../cli/selftune/utils/jsonl.js";

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

  test("detects skill names in completed items", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      '{"type":"item.completed","item":{"item_type":"agent_message","text":"Loading DeploySkill now"}}',
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

  test("treats explicit prompt mention as an invoked skill", () => {
    const codexHome = join(tmpDir, "codex");
    const content = [
      '{"type":"session_meta","payload":{"id":"obs-session-4","cwd":"/project","instructions":"### Available skills\\n- Reins: Reins CLI skill for scaffold/audit/doctor/evolve workflows.\\n### How to use skills"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"audit the project with reins"}}',
    ].join("\n");

    const path = createRolloutFile(
      codexHome,
      "2026",
      "03",
      "12",
      "rollout-explicit-prompt-skill.jsonl",
      content,
    );
    const result = parseRolloutFile(path, new Set(["reins"]));

    expect(result?.query).toBe("audit the project with reins");
    expect(result?.skills_triggered).toContain("reins");
    expect(result?.skills_triggered).not.toContain("Reins");
    expect(result?.skills_invoked).toContain("reins");
    expect(result?.skill_evidence.reins).toBe("explicit");
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
    expect(queryRow!.query).toBe("build the app");
    expect(queryRow!.source).toBe("codex_rollout");

    // Verify telemetry written to SQLite
    const telemetryRow = db
      .query("SELECT session_id, assistant_turns FROM session_telemetry WHERE session_id = ?")
      .get("sess-123") as { session_id: string; assistant_turns: number } | null;
    expect(telemetryRow).toBeTruthy();
    expect(telemetryRow!.session_id).toBe("sess-123");
    expect(telemetryRow!.assistant_turns).toBe(2);

    // Verify skill usage written to SQLite
    const skillRow = db
      .query("SELECT skill_name, skill_path, source FROM skill_usage WHERE session_id = ?")
      .get("sess-123") as { skill_name: string; skill_path: string; source: string } | null;
    expect(skillRow).toBeTruthy();
    expect(skillRow!.skill_name).toBe("MySkill");
    expect(skillRow!.skill_path).toBe("(codex:MySkill)");
    expect(skillRow!.source).toBe("codex_rollout_explicit");

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
    expect(skillRow!.skill_path).toEndWith(".agents/skills/MySkill/SKILL.md");
    expect(skillRow!.skill_scope).toBe("project");
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
  test("round-trips marker data", () => {
    const markerPath = join(tmpDir, "marker.json");
    const data = new Set(["/path/to/file1.jsonl", "/path/to/file2.jsonl"]);
    saveMarker(markerPath, data);
    const loaded = loadMarker(markerPath);
    expect(loaded).toEqual(data);
  });
});
