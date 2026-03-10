import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCanonicalRecordsFromWrapper,
  extractPromptFromArgs,
  logQuery,
  logSkillTrigger,
  logTelemetry,
  parseJsonlStream,
} from "../../cli/selftune/ingestors/codex-wrapper.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-codex-wrapper-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("extractPromptFromArgs", () => {
  test("extracts last positional arg", () => {
    expect(extractPromptFromArgs(["--full-auto", "make me a slide deck"])).toBe(
      "make me a slide deck",
    );
  });

  test("skips flags", () => {
    expect(extractPromptFromArgs(["--full-auto", "--json", "build the app"])).toBe("build the app");
  });

  test("returns empty string for no positional args", () => {
    expect(extractPromptFromArgs(["--full-auto", "--json"])).toBe("");
  });

  test("returns empty string for empty args", () => {
    expect(extractPromptFromArgs([])).toBe("");
  });
});

describe("parseJsonlStream", () => {
  test("handles all event types", () => {
    const lines = [
      '{"type":"thread.started","thread_id":"th-123"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"item_type":"command_execution","command":"ls -la","exit_code":0}}',
      '{"type":"item.completed","item":{"item_type":"file_change"}}',
      '{"type":"item.completed","item":{"item_type":"web_search"}}',
      '{"type":"item.completed","item":{"item_type":"reasoning"}}',
      '{"type":"item.completed","item":{"item_type":"mcp_tool_call","tool":"read_file"}}',
      '{"type":"item.completed","item":{"item_type":"agent_message","text":"Done building"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}',
    ];

    const result = parseJsonlStream(lines, new Set());

    expect(result.thread_id).toBe("th-123");
    expect(result.assistant_turns).toBe(1);
    expect(result.tool_calls.command_execution).toBe(1);
    expect(result.tool_calls.file_change).toBe(1);
    expect(result.tool_calls.web_search).toBe(1);
    expect(result.tool_calls.reasoning).toBe(1);
    expect(result.tool_calls["mcp:read_file"]).toBe(1);
    expect(result.total_tool_calls).toBe(5);
    expect(result.bash_commands).toEqual(["ls -la"]);
    expect(result.input_tokens).toBe(100);
    expect(result.output_tokens).toBe(50);
    expect(result.agent_summary).toBe("Done building");
  });

  test("detects skill names", () => {
    const lines = [
      '{"type":"item.completed","item":{"item_type":"agent_message","text":"Using MySkill to do things"}}',
      '{"type":"item.completed","item":{"item_type":"command_execution","command":"run MyOtherSkill","exit_code":0}}',
    ];

    const result = parseJsonlStream(lines, new Set(["MySkill", "MyOtherSkill", "UnusedSkill"]));

    expect(result.skills_triggered).toContain("MySkill");
    expect(result.skills_triggered).toContain("MyOtherSkill");
    expect(result.skills_triggered).not.toContain("UnusedSkill");
  });

  test("counts errors correctly", () => {
    const lines = [
      '{"type":"turn.failed","error":{"message":"timeout"}}',
      '{"type":"item.completed","item":{"item_type":"command_execution","command":"false","exit_code":1}}',
      '{"type":"error","message":"something broke"}',
    ];

    const result = parseJsonlStream(lines, new Set());
    expect(result.errors_encountered).toBe(3);
  });

  test("skips malformed lines", () => {
    const lines = ["not-json", "", '{"type":"turn.started"}', "also-not-json"];
    const result = parseJsonlStream(lines, new Set());
    expect(result.assistant_turns).toBe(1);
  });

  test("accumulates tokens across multiple turns", () => {
    const lines = [
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}',
      '{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":75}}',
    ];
    const result = parseJsonlStream(lines, new Set());
    expect(result.input_tokens).toBe(300);
    expect(result.output_tokens).toBe(125);
  });
});

describe("logQuery", () => {
  test("writes correct record to JSONL", () => {
    const logPath = join(tmpDir, "queries.jsonl");
    logQuery("build the app", "session-1", logPath);

    const content = readFileSync(logPath, "utf-8").trim();
    const record = JSON.parse(content);
    expect(record.session_id).toBe("session-1");
    expect(record.query).toBe("build the app");
    expect(record.source).toBe("codex");
    expect(record.timestamp).toBeTruthy();
  });

  test("skips short prompts", () => {
    const logPath = join(tmpDir, "queries.jsonl");
    logQuery("hi", "session-1", logPath);
    expect(() => readFileSync(logPath, "utf-8")).toThrow();
  });

  test("skips empty prompts", () => {
    const logPath = join(tmpDir, "queries.jsonl");
    logQuery("", "session-1", logPath);
    expect(() => readFileSync(logPath, "utf-8")).toThrow();
  });
});

describe("logTelemetry", () => {
  test("writes correct record to JSONL", () => {
    const logPath = join(tmpDir, "telemetry.jsonl");
    const metrics = {
      tool_calls: { command_execution: 2 },
      total_tool_calls: 2,
      bash_commands: ["ls", "pwd"],
      skills_triggered: ["MySkill"],
      assistant_turns: 1,
      errors_encountered: 0,
      input_tokens: 100,
      output_tokens: 50,
      agent_summary: "Did stuff",
      transcript_chars: 500,
    };

    logTelemetry(metrics, "build it", "session-1", "/home/user", logPath);

    const content = readFileSync(logPath, "utf-8").trim();
    const record = JSON.parse(content);
    expect(record.session_id).toBe("session-1");
    expect(record.cwd).toBe("/home/user");
    expect(record.source).toBe("codex");
    expect(record.tool_calls.command_execution).toBe(2);
    expect(record.bash_commands).toEqual(["ls", "pwd"]);
    expect(record.last_user_query).toBe("build it");
  });
});

describe("logSkillTrigger", () => {
  test("writes correct record to JSONL", () => {
    const logPath = join(tmpDir, "skills.jsonl");
    logSkillTrigger("MySkill", "build it", "session-1", logPath);

    const content = readFileSync(logPath, "utf-8").trim();
    const record = JSON.parse(content);
    expect(record.session_id).toBe("session-1");
    expect(record.skill_name).toBe("MySkill");
    expect(record.skill_path).toBe("(codex:MySkill)");
    expect(record.query).toBe("build it");
    expect(record.triggered).toBe(true);
    expect(record.source).toBe("codex");
  });
});

describe("buildCanonicalRecordsFromWrapper", () => {
  test("preserves zero token counts in canonical execution facts", () => {
    const records = buildCanonicalRecordsFromWrapper(
      {
        tool_calls: {},
        total_tool_calls: 0,
        bash_commands: [],
        skills_triggered: [],
        assistant_turns: 0,
        errors_encountered: 0,
        input_tokens: 0,
        output_tokens: 0,
        transcript_chars: 0,
      },
      "build it",
      "session-1",
      "/tmp/project",
    );

    const executionFact = records.find((record) => record.record_kind === "execution_fact");
    expect(executionFact?.input_tokens).toBe(0);
    expect(executionFact?.output_tokens).toBe(0);
  });
});
