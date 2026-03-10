import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findRolloutFiles,
  ingestFile,
  parseRolloutFile,
} from "../../cli/selftune/ingestors/codex-rollout.js";
import { loadMarker, saveMarker } from "../../cli/selftune/utils/jsonl.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-codex-rollout-"));
});

afterEach(() => {
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
    expect(result?.observed_meta?.approval_policy).toBe("auto");
    expect(result?.observed_meta?.sandbox_policy).toBe("container");
    expect(result?.observed_meta?.git?.branch).toBe("main");
    expect(result?.observed_meta?.git?.commit).toBe("abc123");
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

    const queryLines = readFileSync(queryLog, "utf-8").trim().split("\n");
    const queryRecord = JSON.parse(queryLines[0]);
    expect(queryRecord.query).toBe("build the app");
    expect(queryRecord.source).toBe("codex_rollout");

    const telemetryLines = readFileSync(telemetryLog, "utf-8").trim().split("\n");
    const telemetryRecord = JSON.parse(telemetryLines[0]);
    expect(telemetryRecord.session_id).toBe("sess-123");
    expect(telemetryRecord.assistant_turns).toBe(2);

    const skillLines = readFileSync(skillLog, "utf-8").trim().split("\n");
    const skillRecord = JSON.parse(skillLines[0]);
    expect(skillRecord.skill_name).toBe("MySkill");
    expect(skillRecord.skill_path).toBe("(codex:MySkill)");

    const canonicalSession = readFileSync(canonicalLog, "utf-8")
      .trim()
      .split("\n")
      .map((l: string) => JSON.parse(l))
      .find((r: Record<string, unknown>) => r.record_kind === "prompt");
    expect(canonicalSession).toBeTruthy();
    expect(canonicalSession.platform).toBe("codex");
    expect(canonicalSession.capture_mode).toBe("batch_ingest");
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

    // Query log should NOT exist (short prompt)
    expect(() => readFileSync(queryLog, "utf-8")).toThrow();
    // Telemetry log should still exist
    expect(readFileSync(telemetryLog, "utf-8").trim()).toBeTruthy();

    const canonicalRecords = readFileSync(canonicalLog, "utf-8")
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    const prompt = canonicalRecords.find(
      (record: Record<string, unknown>) => record.record_kind === "prompt",
    );
    const invocation = canonicalRecords.find(
      (record: Record<string, unknown>) => record.record_kind === "skill_invocation",
    );
    const executionFact = canonicalRecords.find(
      (record: Record<string, unknown>) => record.record_kind === "execution_fact",
    );
    expect(prompt).toBeUndefined();
    expect(invocation?.matched_prompt_id).toBeUndefined();
    expect(executionFact?.prompt_id).toBeUndefined();
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
