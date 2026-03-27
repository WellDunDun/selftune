import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCanonicalRecordsFromOpenCode,
  getDbSchema,
  readSessionsFromJsonFiles,
  readSessionsFromSqlite,
  writeSession,
} from "../../cli/selftune/ingestors/opencode-ingest.js";
import {
  _setTestDb,
  getDb as getSelftunDb,
  openDb as openSelftuneDb,
} from "../../cli/selftune/localdb/db.js";
import { loadMarker, saveMarker } from "../../cli/selftune/utils/jsonl.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-opencode-"));
  const testDb = openSelftuneDb(":memory:");
  _setTestDb(testDb);
});

afterEach(() => {
  _setTestDb(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a test SQLite database with session and message tables. */
function createTestDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      created INTEGER,
      updated INTEGER
    )
  `);
  db.run(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      role TEXT,
      content TEXT,
      created INTEGER
    )
  `);
  return db;
}

describe("readSessionsFromSqlite", () => {
  test("reads sessions from database", () => {
    const dbPath = join(tmpDir, "opencode.db");
    const db = createTestDb(dbPath);

    const created = Date.now();
    db.run("INSERT INTO session (id, title, created, updated) VALUES (?, ?, ?, ?)", [
      "sess-1",
      "Test Session",
      created,
      created,
    ]);

    const userContent = JSON.stringify([{ type: "text", text: "Build me a REST API" }]);
    const assistantContent = JSON.stringify([
      { type: "tool_use", name: "Bash", input: { command: "npm init -y" } },
      { type: "text", text: "I created the project" },
    ]);

    db.run("INSERT INTO message (id, session_id, role, content, created) VALUES (?, ?, ?, ?, ?)", [
      "msg-1",
      "sess-1",
      "user",
      userContent,
      created,
    ]);
    db.run("INSERT INTO message (id, session_id, role, content, created) VALUES (?, ?, ?, ?, ?)", [
      "msg-2",
      "sess-1",
      "assistant",
      assistantContent,
      created + 1,
    ]);
    db.close();

    const sessions = readSessionsFromSqlite(dbPath, null, new Set());
    expect(sessions).toHaveLength(1);

    const s = sessions[0];
    expect(s.session_id).toBe("sess-1");
    expect(s.query).toBe("Build me a REST API");
    expect(s.tool_calls.Bash).toBe(1);
    expect(s.bash_commands).toEqual(["npm init -y"]);
    expect(s.assistant_turns).toBe(1);
    expect(s.source).toBe("opencode");
  });

  test("handles Anthropic tool_use format", () => {
    const dbPath = join(tmpDir, "opencode.db");
    const db = createTestDb(dbPath);

    const created = Date.now();
    db.run("INSERT INTO session (id, title, created, updated) VALUES (?, ?, ?, ?)", [
      "sess-2",
      "Tool Test",
      created,
      created,
    ]);

    const assistantContent = JSON.stringify([
      { type: "tool_use", name: "Read", input: { file_path: "/skills/Deploy/SKILL.md" } },
      { type: "tool_use", name: "Bash", input: { command: "echo hello" } },
      { type: "tool_use", name: "Edit", input: { file_path: "/app.ts" } },
    ]);

    db.run("INSERT INTO message (id, session_id, role, content, created) VALUES (?, ?, ?, ?, ?)", [
      "msg-1",
      "sess-2",
      "user",
      JSON.stringify([{ type: "text", text: "Deploy the app" }]),
      created,
    ]);
    db.run("INSERT INTO message (id, session_id, role, content, created) VALUES (?, ?, ?, ?, ?)", [
      "msg-2",
      "sess-2",
      "assistant",
      assistantContent,
      created + 1,
    ]);
    db.close();

    const sessions = readSessionsFromSqlite(dbPath, null, new Set());
    const s = sessions[0];
    expect(s.tool_calls.Read).toBe(1);
    expect(s.tool_calls.Bash).toBe(1);
    expect(s.tool_calls.Edit).toBe(1);
    expect(s.total_tool_calls).toBe(3);
    expect(s.bash_commands).toEqual(["echo hello"]);
    // Skill detection from reading SKILL.md
    expect(s.skills_triggered).toContain("Deploy");
    expect(s.skill_detections).toEqual([{ skill_name: "Deploy", has_skill_md_read: true }]);
  });

  test("uses whole-word matching for text-only skill mentions", () => {
    const dbPath = join(tmpDir, "opencode.db");
    const db = createTestDb(dbPath);

    const created = Date.now();
    db.run("INSERT INTO session (id, title, created, updated) VALUES (?, ?, ?, ?)", [
      "sess-mention",
      "Mention test",
      created,
      created,
    ]);

    db.run("INSERT INTO message (id, session_id, role, content, created) VALUES (?, ?, ?, ?, ?)", [
      "msg-1",
      "sess-mention",
      "user",
      JSON.stringify([{ type: "text", text: "Plan the deploy" }]),
      created,
    ]);
    db.run("INSERT INTO message (id, session_id, role, content, created) VALUES (?, ?, ?, ?, ?)", [
      "msg-2",
      "sess-mention",
      "assistant",
      JSON.stringify([{ type: "text", text: "DeploySkill can help here." }]),
      created + 1,
    ]);
    db.close();

    const sessions = readSessionsFromSqlite(dbPath, null, new Set(["Deploy"]));
    expect(sessions[0].skills_triggered).toEqual([]);
    expect(sessions[0].skill_detections).toEqual([]);
  });

  test("handles OpenAI tool_calls format", () => {
    const dbPath = join(tmpDir, "opencode.db");
    const db = createTestDb(dbPath);

    const created = Date.now();
    db.run("INSERT INTO session (id, title, created, updated) VALUES (?, ?, ?, ?)", [
      "sess-3",
      "OpenAI format",
      created,
      created,
    ]);

    const assistantContent = JSON.stringify([
      {
        type: "tool_calls",
        tool_calls: [
          { function: { name: "execute_code" } },
          { function: { name: "search_files" } },
        ],
      },
    ]);

    db.run("INSERT INTO message (id, session_id, role, content, created) VALUES (?, ?, ?, ?, ?)", [
      "msg-1",
      "sess-3",
      "user",
      JSON.stringify([{ type: "text", text: "Search for patterns" }]),
      created,
    ]);
    db.run("INSERT INTO message (id, session_id, role, content, created) VALUES (?, ?, ?, ?, ?)", [
      "msg-2",
      "sess-3",
      "assistant",
      assistantContent,
      created + 1,
    ]);
    db.close();

    const sessions = readSessionsFromSqlite(dbPath, null, new Set());
    const s = sessions[0];
    expect(s.tool_calls.execute_code).toBe(1);
    expect(s.tool_calls.search_files).toBe(1);
    expect(s.total_tool_calls).toBe(2);
  });

  test("filters by since timestamp", () => {
    const dbPath = join(tmpDir, "opencode.db");
    const db = createTestDb(dbPath);

    const oldTime = new Date("2025-01-01T00:00:00Z").getTime();
    const newTime = new Date("2026-06-15T00:00:00Z").getTime();

    db.run("INSERT INTO session (id, title, created, updated) VALUES (?, ?, ?, ?)", [
      "old-sess",
      "Old",
      oldTime,
      oldTime,
    ]);
    db.run("INSERT INTO session (id, title, created, updated) VALUES (?, ?, ?, ?)", [
      "new-sess",
      "New",
      newTime,
      newTime,
    ]);
    db.close();

    const sinceTs = new Date("2026-01-01T00:00:00Z").getTime() / 1000;
    const sessions = readSessionsFromSqlite(dbPath, sinceTs, new Set());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].session_id).toBe("new-sess");
  });

  test("counts errors from tool_result blocks", () => {
    const dbPath = join(tmpDir, "opencode.db");
    const db = createTestDb(dbPath);

    const created = Date.now();
    db.run("INSERT INTO session (id, title, created, updated) VALUES (?, ?, ?, ?)", [
      "sess-err",
      "Error test",
      created,
      created,
    ]);

    const userContent = JSON.stringify([
      { type: "tool_result", is_error: true },
      { type: "tool_result", error: "something failed" },
      { type: "tool_result" },
    ]);

    db.run("INSERT INTO message (id, session_id, role, content, created) VALUES (?, ?, ?, ?, ?)", [
      "msg-1",
      "sess-err",
      "user",
      userContent,
      created,
    ]);
    db.close();

    const sessions = readSessionsFromSqlite(dbPath, null, new Set());
    expect(sessions[0].errors_encountered).toBe(2);
  });

  test("returns empty for database without expected tables", () => {
    const dbPath = join(tmpDir, "empty.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE unrelated (id TEXT)");
    db.close();

    const sessions = readSessionsFromSqlite(dbPath, null, new Set());
    expect(sessions).toEqual([]);
  });
});

describe("readSessionsFromJsonFiles", () => {
  test("reads legacy JSON sessions", () => {
    const storageDir = join(tmpDir, "storage");
    mkdirSync(join(storageDir, "session"), { recursive: true });

    const sessionData = {
      id: "json-sess-1",
      created: Date.now() / 1000,
      messages: [
        { role: "user", content: [{ type: "text", text: "Help me refactor" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Bash", input: { command: "git diff" } },
            { type: "text", text: "Here are the changes" },
          ],
        },
      ],
    };

    writeFileSync(join(storageDir, "session", "sess1.json"), JSON.stringify(sessionData), "utf-8");

    const sessions = readSessionsFromJsonFiles(storageDir, null, new Set());
    expect(sessions).toHaveLength(1);

    const s = sessions[0];
    expect(s.session_id).toBe("json-sess-1");
    expect(s.query).toBe("Help me refactor");
    expect(s.tool_calls.Bash).toBe(1);
    expect(s.bash_commands).toEqual(["git diff"]);
    expect(s.source).toBe("opencode_json");
  });

  test("handles string content in messages", () => {
    const storageDir = join(tmpDir, "storage");
    mkdirSync(join(storageDir, "session"), { recursive: true });

    const sessionData = {
      id: "string-sess",
      created: Date.now() / 1000,
      messages: [
        { role: "user", content: "Build a simple app" },
        { role: "assistant", content: "Sure, I will build it" },
      ],
    };

    writeFileSync(join(storageDir, "session", "string.json"), JSON.stringify(sessionData), "utf-8");

    const sessions = readSessionsFromJsonFiles(storageDir, null, new Set());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].query).toBe("Build a simple app");
    expect(sessions[0].assistant_turns).toBe(1);
  });

  test("returns empty for missing session directory", () => {
    const sessions = readSessionsFromJsonFiles(join(tmpDir, "nonexistent"), null, new Set());
    expect(sessions).toEqual([]);
  });

  test("handles millisecond timestamps", () => {
    const storageDir = join(tmpDir, "storage");
    mkdirSync(join(storageDir, "session"), { recursive: true });

    const createdMs = Date.now(); // milliseconds
    const sessionData = {
      id: "ms-sess",
      created: createdMs,
      messages: [{ role: "user", content: [{ type: "text", text: "Test with ms timestamp" }] }],
    };

    writeFileSync(join(storageDir, "session", "ms.json"), JSON.stringify(sessionData), "utf-8");

    const sessions = readSessionsFromJsonFiles(storageDir, null, new Set());
    expect(sessions).toHaveLength(1);
    // Should have a valid ISO timestamp (not in the far future)
    const ts = new Date(sessions[0].timestamp);
    expect(ts.getFullYear()).toBeGreaterThanOrEqual(2025);
    expect(ts.getFullYear()).toBeLessThanOrEqual(2027);
  });

  test("detects skills from SKILL.md reads", () => {
    const storageDir = join(tmpDir, "storage");
    mkdirSync(join(storageDir, "session"), { recursive: true });

    const sessionData = {
      id: "skill-sess",
      created: Date.now() / 1000,
      messages: [
        { role: "user", content: [{ type: "text", text: "Deploy the app" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/skills/Deploy/SKILL.md" } },
          ],
        },
      ],
    };

    writeFileSync(join(storageDir, "session", "skill.json"), JSON.stringify(sessionData), "utf-8");

    const sessions = readSessionsFromJsonFiles(storageDir, null, new Set());
    expect(sessions[0].skills_triggered).toContain("Deploy");
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
      source: "opencode",
      transcript_path: "/db/path",
      cwd: "",
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

    // Verify query written to SQLite
    const db = getSelftunDb();
    const queryRow = db
      .query("SELECT query, source FROM queries WHERE session_id = ?")
      .get("sess-oc-1") as { query: string; source: string } | null;
    expect(queryRow).toBeTruthy();
    expect(queryRow!.query).toBe("Build an API");
    expect(queryRow!.source).toBe("opencode");

    // Verify telemetry written to SQLite
    const telemetryRow = db
      .query("SELECT session_id FROM session_telemetry WHERE session_id = ?")
      .get("sess-oc-1") as { session_id: string } | null;
    expect(telemetryRow).toBeTruthy();
    expect(telemetryRow!.session_id).toBe("sess-oc-1");

    // Verify skill usage written to SQLite
    const skillRow = db
      .query("SELECT skill_name, skill_path FROM skill_usage WHERE session_id = ?")
      .get("sess-oc-1") as { skill_name: string; skill_path: string } | null;
    expect(skillRow).toBeTruthy();
    expect(skillRow!.skill_name).toBe("RestAPI");
    expect(skillRow!.skill_path).toBe("(opencode:RestAPI)");

    // Verify canonical records structure via the exported builder
    const canonicalRecords = buildCanonicalRecordsFromOpenCode(session);
    expect(canonicalRecords.some((r) => r.record_kind === "session")).toBe(true);
    const canonicalInvocation = canonicalRecords.find((r) => r.record_kind === "skill_invocation");
    expect((canonicalInvocation as Record<string, unknown>)?.invocation_mode).toBe("inferred");
  });
});

describe("getDbSchema", () => {
  test("returns schema summary", () => {
    const dbPath = join(tmpDir, "schema-test.db");
    const db = createTestDb(dbPath);
    db.close();

    const schema = getDbSchema(dbPath);
    expect(schema).toContain("Table: session");
    expect(schema).toContain("Table: message");
    expect(schema).toContain("id");
    expect(schema).toContain("TEXT");
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
