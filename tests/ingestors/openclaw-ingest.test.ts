import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCanonicalRecordsFromOpenClaw,
  findOpenClawSessions,
  findOpenClawSkillNames,
  parseOpenClawSession,
  writeSession,
} from "../../cli/selftune/ingestors/openclaw-ingest.js";
import { loadMarker, saveMarker } from "../../cli/selftune/utils/jsonl.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-openclaw-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a mock OpenClaw session JSONL file. */
function createSessionFile(
  dir: string,
  agentId: string,
  sessionId: string,
  lines: object[],
): string {
  const agentDir = join(dir, agentId, "sessions");
  mkdirSync(agentDir, { recursive: true });
  const filePath = join(agentDir, `${sessionId}.jsonl`);
  writeFileSync(filePath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf-8");
  return filePath;
}

describe("parseOpenClawSession", () => {
  test("parses a session with header, user, and assistant messages", () => {
    const filePath = createSessionFile(tmpDir, "agent-1", "sess-abc", [
      {
        type: "session",
        version: 5,
        id: "sess-abc",
        timestamp: "2026-03-01T10:00:00.000Z",
        cwd: "/home/user/project",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Build me a REST API" }],
        timestamp: 1709290800000,
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc-1", name: "Bash", input: { command: "npm init -y" } },
          { type: "text", text: "I created the project" },
        ],
        timestamp: 1709290801000,
      },
    ]);

    const session = parseOpenClawSession(filePath, new Set());
    expect(session.session_id).toBe("sess-abc");
    expect(session.source).toBe("openclaw");
    expect(session.cwd).toBe("/home/user/project");
    expect(session.query).toBe("Build me a REST API");
    expect(session.last_user_query).toBe("Build me a REST API");
    expect(session.tool_calls.Bash).toBe(1);
    expect(session.total_tool_calls).toBe(1);
    expect(session.bash_commands).toEqual(["npm init -y"]);
    expect(session.assistant_turns).toBe(1);
    expect(session.transcript_path).toBe(filePath);
  });

  test("detects skills from SKILL.md reads via toolCall", () => {
    const filePath = createSessionFile(tmpDir, "agent-1", "sess-skill", [
      {
        type: "session",
        version: 5,
        id: "sess-skill",
        timestamp: "2026-03-01T10:00:00.000Z",
        cwd: "/home/user",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Deploy the app" }],
        timestamp: 1709290800000,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "Read",
            input: { file_path: "/skills/Deploy/SKILL.md" },
          },
        ],
        timestamp: 1709290801000,
      },
    ]);

    const session = parseOpenClawSession(filePath, new Set());
    expect(session.skills_triggered).toContain("Deploy");
    expect(session.skill_detections).toEqual([{ skill_name: "Deploy", has_skill_md_read: true }]);
  });

  test("counts tool calls across multiple assistant turns", () => {
    const filePath = createSessionFile(tmpDir, "agent-1", "sess-tools", [
      {
        type: "session",
        version: 5,
        id: "sess-tools",
        timestamp: "2026-03-01T10:00:00.000Z",
        cwd: "/project",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Refactor the codebase" }],
        timestamp: 1709290800000,
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc-1", name: "Bash", input: { command: "ls -la" } },
          { type: "toolCall", id: "tc-2", name: "Read", input: { file_path: "/app.ts" } },
        ],
        timestamp: 1709290801000,
      },
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "tc-3", name: "Edit", input: { file_path: "/app.ts" } },
          { type: "toolCall", id: "tc-4", name: "Bash", input: { command: "bun test" } },
        ],
        timestamp: 1709290802000,
      },
    ]);

    const session = parseOpenClawSession(filePath, new Set());
    expect(session.tool_calls.Bash).toBe(2);
    expect(session.tool_calls.Read).toBe(1);
    expect(session.tool_calls.Edit).toBe(1);
    expect(session.total_tool_calls).toBe(4);
    expect(session.bash_commands).toEqual(["ls -la", "bun test"]);
    expect(session.assistant_turns).toBe(2);
  });

  test("counts errors from toolResult with isError true", () => {
    const filePath = createSessionFile(tmpDir, "agent-1", "sess-err", [
      {
        type: "session",
        version: 5,
        id: "sess-err",
        timestamp: "2026-03-01T10:00:00.000Z",
        cwd: "/project",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Run the tests" }],
        timestamp: 1709290800000,
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "Error: command not found" }],
        toolCallId: "tc-1",
        isError: true,
        timestamp: 1709290801000,
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "Success" }],
        toolCallId: "tc-2",
        timestamp: 1709290802000,
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "Permission denied" }],
        toolCallId: "tc-3",
        isError: true,
        timestamp: 1709290803000,
      },
    ]);

    const session = parseOpenClawSession(filePath, new Set());
    expect(session.errors_encountered).toBe(2);
  });

  test("handles all content block types: text, toolCall, toolResult, thinking", () => {
    const filePath = createSessionFile(tmpDir, "agent-1", "sess-blocks", [
      {
        type: "session",
        version: 5,
        id: "sess-blocks",
        timestamp: "2026-03-01T10:00:00.000Z",
        cwd: "/project",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Help with code" }],
        timestamp: 1709290800000,
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "Let me think about this..." },
          { type: "text", text: "I will help you." },
          { type: "toolCall", id: "tc-1", name: "Grep", input: { pattern: "TODO" } },
        ],
        timestamp: 1709290801000,
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "Found 3 matches" }],
        toolCallId: "tc-1",
        timestamp: 1709290802000,
      },
    ]);

    const session = parseOpenClawSession(filePath, new Set());
    expect(session.query).toBe("Help with code");
    expect(session.tool_calls.Grep).toBe(1);
    expect(session.total_tool_calls).toBe(1);
    expect(session.assistant_turns).toBe(1);
    expect(session.errors_encountered).toBe(0);
  });

  test("detects skills from text content mentioning skill names", () => {
    const filePath = createSessionFile(tmpDir, "agent-1", "sess-mention", [
      {
        type: "session",
        version: 5,
        id: "sess-mention",
        timestamp: "2026-03-01T10:00:00.000Z",
        cwd: "/project",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Help me deploy" }],
        timestamp: 1709290800000,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "I will use the Deploy skill to help you." }],
        timestamp: 1709290801000,
      },
    ]);

    const session = parseOpenClawSession(filePath, new Set(["Deploy", "Testing"]));
    expect(session.skills_triggered).toContain("Deploy");
    expect(session.skills_triggered).not.toContain("Testing");
    expect(session.skill_detections).toEqual([{ skill_name: "Deploy", has_skill_md_read: false }]);
  });

  test("handles empty or malformed JSONL gracefully", () => {
    const agentDir = join(tmpDir, "agent-1", "sessions");
    mkdirSync(agentDir, { recursive: true });
    const filePath = join(agentDir, "bad-sess.jsonl");
    writeFileSync(filePath, "not json\n{bad json too\n", "utf-8");

    const session = parseOpenClawSession(filePath, new Set());
    expect(session.session_id).toBe("");
    expect(session.assistant_turns).toBe(0);
  });

  test("tracks last_user_query from most recent user message", () => {
    const filePath = createSessionFile(tmpDir, "agent-1", "sess-multi-user", [
      {
        type: "session",
        version: 5,
        id: "sess-multi-user",
        timestamp: "2026-03-01T10:00:00.000Z",
        cwd: "/project",
      },
      {
        role: "user",
        content: [{ type: "text", text: "First question" }],
        timestamp: 1709290800000,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "First answer" }],
        timestamp: 1709290801000,
      },
      {
        role: "user",
        content: [{ type: "text", text: "Follow-up question" }],
        timestamp: 1709290802000,
      },
    ]);

    const session = parseOpenClawSession(filePath, new Set());
    expect(session.query).toBe("First question");
    expect(session.last_user_query).toBe("Follow-up question");
  });
});

describe("findOpenClawSessions", () => {
  test("finds sessions across multiple agent directories", () => {
    createSessionFile(tmpDir, "agent-alpha", "sess-1", [
      {
        type: "session",
        version: 5,
        id: "sess-1",
        timestamp: "2026-03-01T10:00:00.000Z",
        cwd: "/a",
      },
    ]);
    createSessionFile(tmpDir, "agent-beta", "sess-2", [
      {
        type: "session",
        version: 5,
        id: "sess-2",
        timestamp: "2026-03-01T11:00:00.000Z",
        cwd: "/b",
      },
    ]);
    createSessionFile(tmpDir, "agent-beta", "sess-3", [
      {
        type: "session",
        version: 5,
        id: "sess-3",
        timestamp: "2026-03-01T12:00:00.000Z",
        cwd: "/c",
      },
    ]);

    const sessions = findOpenClawSessions(tmpDir, null);
    expect(sessions).toHaveLength(3);
    const ids = sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(["sess-1", "sess-2", "sess-3"]);
  });

  test("filters sessions by --since timestamp", () => {
    // Old session
    createSessionFile(tmpDir, "agent-1", "old-sess", [
      {
        type: "session",
        version: 5,
        id: "old-sess",
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: "/old",
      },
    ]);
    // New session
    createSessionFile(tmpDir, "agent-1", "new-sess", [
      {
        type: "session",
        version: 5,
        id: "new-sess",
        timestamp: "2026-06-15T00:00:00.000Z",
        cwd: "/new",
      },
    ]);

    const sinceTs = new Date("2026-01-01T00:00:00Z").getTime();
    const sessions = findOpenClawSessions(tmpDir, sinceTs);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("new-sess");
  });

  test("returns empty array for non-existent directory", () => {
    const sessions = findOpenClawSessions(join(tmpDir, "nonexistent"), null);
    expect(sessions).toEqual([]);
  });

  test("skips non-JSONL files", () => {
    const agentDir = join(tmpDir, "agent-1", "sessions");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "readme.txt"), "not a session", "utf-8");
    writeFileSync(join(agentDir, "sessions.json"), "{}", "utf-8");

    createSessionFile(tmpDir, "agent-1", "real-sess", [
      {
        type: "session",
        version: 5,
        id: "real-sess",
        timestamp: "2026-03-01T10:00:00.000Z",
        cwd: "/a",
      },
    ]);

    const sessions = findOpenClawSessions(tmpDir, null);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("real-sess");
  });
});

describe("findOpenClawSkillNames", () => {
  test("finds skill directories containing SKILL.md", () => {
    const skillsDir = join(tmpDir, "skills");
    mkdirSync(join(skillsDir, "Deploy"), { recursive: true });
    writeFileSync(join(skillsDir, "Deploy", "SKILL.md"), "# Deploy skill", "utf-8");
    mkdirSync(join(skillsDir, "Testing"), { recursive: true });
    writeFileSync(join(skillsDir, "Testing", "SKILL.md"), "# Testing skill", "utf-8");
    // This one has no SKILL.md, should be ignored
    mkdirSync(join(skillsDir, "Incomplete"), { recursive: true });

    const names = findOpenClawSkillNames(tmpDir, []);
    expect(names.has("Deploy")).toBe(true);
    expect(names.has("Testing")).toBe(true);
    expect(names.has("Incomplete")).toBe(false);
  });

  test("returns empty set when no skill directories exist", () => {
    const names = findOpenClawSkillNames(join(tmpDir, "nonexistent"), []);
    expect(names.size).toBe(0);
  });
});

describe("writeSession", () => {
  test("writes query, telemetry, and skill logs", () => {
    const queryLog = join(tmpDir, "queries.jsonl");
    const telemetryLog = join(tmpDir, "telemetry.jsonl");
    const skillLog = join(tmpDir, "skills.jsonl");
    const canonicalLog = join(tmpDir, "canonical.jsonl");

    const session = {
      timestamp: "2026-03-15T00:00:00.000Z",
      session_id: "sess-oc-1",
      source: "openclaw",
      transcript_path: "/path/to/session.jsonl",
      cwd: "/project",
      last_user_query: "Build an API",
      query: "Build an API",
      tool_calls: { Bash: 2 },
      total_tool_calls: 2,
      bash_commands: ["npm init", "npm test"],
      skills_triggered: ["RestAPI"],
      skill_detections: [{ skill_name: "RestAPI", has_skill_md_read: false }],
      assistant_turns: 3,
      errors_encountered: 0,
      transcript_chars: 1000,
    };

    writeSession(session, false, queryLog, telemetryLog, skillLog, canonicalLog);

    const queryLines = readFileSync(queryLog, "utf-8").trim().split("\n");
    const queryRecord = JSON.parse(queryLines[0]);
    expect(queryRecord.query).toBe("Build an API");
    expect(queryRecord.source).toBe("openclaw");

    const telemetryLines = readFileSync(telemetryLog, "utf-8").trim().split("\n");
    const telemetryRecord = JSON.parse(telemetryLines[0]);
    expect(telemetryRecord.session_id).toBe("sess-oc-1");
    expect(telemetryRecord.source).toBe("openclaw");

    const skillLines = readFileSync(skillLog, "utf-8").trim().split("\n");
    const skillRecord = JSON.parse(skillLines[0]);
    expect(skillRecord.skill_name).toBe("RestAPI");
    expect(skillRecord.skill_path).toBe("(openclaw:RestAPI)");

    // Verify canonical records structure via the exported builder
    const canonicalRecords = buildCanonicalRecordsFromOpenClaw(session);
    const canonicalSession = canonicalRecords.find((r) => r.record_kind === "session");
    expect(canonicalSession).toBeTruthy();
    expect((canonicalSession as Record<string, unknown>).platform).toBe("openclaw");
    expect((canonicalSession as Record<string, unknown>).capture_mode).toBe("batch_ingest");

    const canonicalInvocation = canonicalRecords.find((r) => r.record_kind === "skill_invocation");
    expect((canonicalInvocation as Record<string, unknown>)?.invocation_mode).toBe("inferred");
  });

  test("dry run does not write files", () => {
    const queryLog = join(tmpDir, "queries-dry.jsonl");
    const telemetryLog = join(tmpDir, "telemetry-dry.jsonl");
    const skillLog = join(tmpDir, "skills-dry.jsonl");
    const canonicalLog = join(tmpDir, "canonical-dry.jsonl");

    const session = {
      timestamp: "2026-03-15T00:00:00.000Z",
      session_id: "sess-dry",
      source: "openclaw",
      transcript_path: "/path",
      cwd: "/project",
      last_user_query: "Test dry run",
      query: "Test dry run",
      tool_calls: {},
      total_tool_calls: 0,
      bash_commands: [],
      skills_triggered: [],
      assistant_turns: 1,
      errors_encountered: 0,
      transcript_chars: 100,
    };

    writeSession(session, true, queryLog, telemetryLog, skillLog, canonicalLog);

    // Files should not exist
    expect(() => readFileSync(queryLog)).toThrow();
    expect(() => readFileSync(telemetryLog)).toThrow();
    expect(() => readFileSync(skillLog)).toThrow();
  });

  test("skips query log for short queries", () => {
    const queryLog = join(tmpDir, "queries-short.jsonl");
    const telemetryLog = join(tmpDir, "telemetry-short.jsonl");
    const skillLog = join(tmpDir, "skills-short.jsonl");
    const canonicalLog = join(tmpDir, "canonical-short.jsonl");

    const session = {
      timestamp: "2026-03-15T00:00:00.000Z",
      session_id: "sess-short",
      source: "openclaw",
      transcript_path: "/path",
      cwd: "/project",
      last_user_query: "hi",
      query: "hi",
      tool_calls: {},
      total_tool_calls: 0,
      bash_commands: [],
      skills_triggered: [],
      assistant_turns: 1,
      errors_encountered: 0,
      transcript_chars: 50,
    };

    writeSession(session, false, queryLog, telemetryLog, skillLog, canonicalLog);

    // Query log should not exist (query too short)
    expect(() => readFileSync(queryLog)).toThrow();
    // But telemetry should still be written
    const telemetryLines = readFileSync(telemetryLog, "utf-8").trim().split("\n");
    expect(JSON.parse(telemetryLines[0]).session_id).toBe("sess-short");
  });
});

describe("marker file tracks ingested sessions", () => {
  test("round-trips marker data", () => {
    const markerPath = join(tmpDir, "marker.json");
    const data = new Set(["sess-1", "sess-2", "sess-3"]);
    saveMarker(markerPath, data);
    const loaded = loadMarker(markerPath);
    expect(loaded).toEqual(data);
  });
});
