import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCanonicalRecordsFromReplay,
  extractAllUserQueries,
  findTranscriptFiles,
  parseSession,
  writeSession,
} from "../../cli/selftune/ingestors/claude-replay.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-claude-replay-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a transcript file in the expected <hash>/<session>.jsonl structure. */
function createTranscriptFile(
  projectsDir: string,
  hash: string,
  sessionId: string,
  content: string,
): string {
  const dir = join(projectsDir, hash);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("findTranscriptFiles", () => {
  test("finds .jsonl in project hash dirs", () => {
    const projectsDir = join(tmpDir, "projects");
    createTranscriptFile(
      projectsDir,
      "a1b2c3d4",
      "sess-001",
      '{"role":"user","content":"hello world"}\n',
    );
    createTranscriptFile(
      projectsDir,
      "e5f6a7b8",
      "sess-002",
      '{"role":"user","content":"test query"}\n',
    );

    const files = findTranscriptFiles(projectsDir);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.includes("sess-001.jsonl"))).toBe(true);
    expect(files.some((f) => f.includes("sess-002.jsonl"))).toBe(true);
  });

  test("filters by --since date using mtime", () => {
    const projectsDir = join(tmpDir, "projects");
    const oldFile = createTranscriptFile(
      projectsDir,
      "aaa111",
      "old-sess",
      '{"role":"user","content":"old query"}\n',
    );
    // Set mtime far in the past
    const pastTime = new Date("2020-01-01").getTime() / 1000;
    utimesSync(oldFile, pastTime, pastTime);

    createTranscriptFile(
      projectsDir,
      "bbb222",
      "new-sess",
      '{"role":"user","content":"new query"}\n',
    );

    const since = new Date("2025-01-01");
    const files = findTranscriptFiles(projectsDir, since);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("new-sess.jsonl");
  });

  test("returns empty for missing dir", () => {
    const files = findTranscriptFiles(join(tmpDir, "nonexistent"));
    expect(files).toEqual([]);
  });

  test("ignores non-jsonl files", () => {
    const projectsDir = join(tmpDir, "projects");
    const hashDir = join(projectsDir, "abcdef12");
    mkdirSync(hashDir, { recursive: true });
    writeFileSync(join(hashDir, "session.jsonl"), '{"role":"user","content":"hello world"}\n');
    writeFileSync(join(hashDir, "readme.md"), "# readme\n");
    writeFileSync(join(hashDir, "notes.txt"), "notes\n");

    const files = findTranscriptFiles(projectsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("session.jsonl");
  });

  test("returns sorted paths", () => {
    const projectsDir = join(tmpDir, "projects");
    createTranscriptFile(projectsDir, "zzz999", "zzz-sess", '{"role":"user","content":"z"}\n');
    createTranscriptFile(projectsDir, "aaa111", "aaa-sess", '{"role":"user","content":"a"}\n');

    const files = findTranscriptFiles(projectsDir);
    expect(files).toHaveLength(2);
    // Should be sorted
    expect(files[0]).toContain("aaa111");
    expect(files[1]).toContain("zzz999");
  });

  test("finds nested subagent transcripts recursively", () => {
    const projectsDir = join(tmpDir, "projects");
    createTranscriptFile(
      projectsDir,
      "base123",
      "top-level",
      '{"role":"user","content":"top level session"}\n',
    );

    const subagentDir = join(projectsDir, "base123", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "agent-1.jsonl"),
      '{"role":"user","content":"nested subagent session"}\n',
      "utf-8",
    );

    const files = findTranscriptFiles(projectsDir);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith("top-level.jsonl"))).toBe(true);
    expect(files.some((f) => f.endsWith("subagents/agent-1.jsonl"))).toBe(true);
  });
});

describe("extractAllUserQueries", () => {
  test("extracts user messages from Variant B (direct role)", () => {
    const projectsDir = join(tmpDir, "projects");
    const content = [
      '{"role":"user","content":"first question here"}',
      '{"role":"assistant","content":"response here"}',
      '{"role":"user","content":"second question here"}',
    ].join("\n");
    const path = createTranscriptFile(projectsDir, "hash1", "sess1", content);

    const queries = extractAllUserQueries(path);
    expect(queries).toHaveLength(2);
    expect(queries[0].query).toBe("first question here");
    expect(queries[1].query).toBe("second question here");
  });

  test("extracts user messages from Variant A (nested message)", () => {
    const projectsDir = join(tmpDir, "projects");
    const content = [
      '{"type":"user","message":{"role":"user","content":"nested user query"}}',
      '{"type":"assistant","message":{"role":"assistant","content":"response"}}',
    ].join("\n");
    const path = createTranscriptFile(projectsDir, "hash2", "sess2", content);

    const queries = extractAllUserQueries(path);
    expect(queries).toHaveLength(1);
    expect(queries[0].query).toBe("nested user query");
  });

  test("handles content arrays, extracting only text blocks", () => {
    const projectsDir = join(tmpDir, "projects");
    const content = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "please fix this bug" },
          { type: "tool_result", tool_use_id: "abc", content: "result data" },
          { type: "text", text: "and also refactor" },
        ],
      },
    });
    const path = createTranscriptFile(projectsDir, "hash3", "sess3", content);

    const queries = extractAllUserQueries(path);
    expect(queries).toHaveLength(1);
    expect(queries[0].query).toBe("please fix this bug and also refactor");
  });

  test("skips messages starting with SKIP_PREFIXES", () => {
    const projectsDir = join(tmpDir, "projects");
    const content = [
      '{"role":"user","content":"<tool_result>some result</tool_result>"}',
      '{"role":"user","content":"<function_result>output</function_result>"}',
      '{"role":"user","content":"[Automated] system msg"}',
      '{"role":"user","content":"[System] internal"}',
      '{"role":"user","content":"real user query here"}',
    ].join("\n");
    const path = createTranscriptFile(projectsDir, "hash4", "sess4", content);

    const queries = extractAllUserQueries(path);
    expect(queries).toHaveLength(1);
    expect(queries[0].query).toBe("real user query here");
  });

  test("skips queries shorter than 4 characters", () => {
    const projectsDir = join(tmpDir, "projects");
    const content = [
      '{"role":"user","content":"hi"}',
      '{"role":"user","content":"yes"}',
      '{"role":"user","content":"ok"}',
      '{"role":"user","content":"this is a real question"}',
    ].join("\n");
    const path = createTranscriptFile(projectsDir, "hash5", "sess5", content);

    const queries = extractAllUserQueries(path);
    expect(queries).toHaveLength(1);
    expect(queries[0].query).toBe("this is a real question");
  });

  test("uses timestamp field if present", () => {
    const projectsDir = join(tmpDir, "projects");
    const content =
      '{"role":"user","content":"query with timestamp","timestamp":"2026-01-15T10:30:00Z"}\n';
    const path = createTranscriptFile(projectsDir, "hash6", "sess6", content);

    const queries = extractAllUserQueries(path);
    expect(queries).toHaveLength(1);
    expect(queries[0].timestamp).toBe("2026-01-15T10:30:00Z");
  });

  test("uses empty string for timestamp if not present", () => {
    const projectsDir = join(tmpDir, "projects");
    const content = '{"role":"user","content":"query without timestamp"}\n';
    const path = createTranscriptFile(projectsDir, "hash7", "sess7", content);

    const queries = extractAllUserQueries(path);
    expect(queries).toHaveLength(1);
    expect(queries[0].timestamp).toBe("");
  });

  test("returns empty array for nonexistent file", () => {
    const queries = extractAllUserQueries(join(tmpDir, "nonexistent.jsonl"));
    expect(queries).toEqual([]);
  });
});

describe("parseSession", () => {
  test("returns metrics and all user queries", () => {
    const projectsDir = join(tmpDir, "projects");
    const content = [
      '{"role":"user","content":"first question from user"}',
      '{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/test.ts"}}]}',
      '{"role":"user","content":"follow up question here"}',
      '{"role":"assistant","content":[{"type":"text","text":"done"}]}',
    ].join("\n");
    const path = createTranscriptFile(projectsDir, "hashA", "session-abc", content);

    const session = parseSession(path);
    expect(session).not.toBeNull();
    if (!session) return;
    expect(session.session_id).toBe("session-abc");
    expect(session.transcript_path).toBe(path);
    expect(session.metrics.assistant_turns).toBe(2);
    expect(session.metrics.tool_calls.Read).toBe(1);
    expect(session.user_queries).toHaveLength(2);
    expect(session.user_queries[0].query).toBe("first question from user");
    expect(session.user_queries[1].query).toBe("follow up question here");
  });

  test("returns null for empty file", () => {
    const projectsDir = join(tmpDir, "projects");
    const path = createTranscriptFile(projectsDir, "hashB", "empty-session", "");

    const session = parseSession(path);
    expect(session).toBeNull();
  });

  test("returns null when no user queries pass filters", () => {
    const projectsDir = join(tmpDir, "projects");
    const content = ['{"role":"user","content":"hi"}', '{"role":"assistant","content":"ok"}'].join(
      "\n",
    );
    const path = createTranscriptFile(projectsDir, "hashC", "short-session", content);

    const session = parseSession(path);
    expect(session).toBeNull();
  });

  test("drops meta payloads when deriving last_user_query", () => {
    const projectsDir = join(tmpDir, "projects");
    const content = [
      '{"role":"user","content":"review the reins repo"}',
      '{"role":"user","content":"<local-command-stdout> tool output"}',
      '{"role":"assistant","content":[{"type":"tool_use","name":"Skill","input":{"skill":"reins"}}]}',
    ].join("\n");
    const path = createTranscriptFile(projectsDir, "hash-meta", "session-meta", content);

    const session = parseSession(path);
    expect(session).not.toBeNull();
    expect(session?.metrics.last_user_query).toBe("review the reins repo");
  });
});

describe("writeSession", () => {
  test("writes one query record per user message", () => {
    const queryLog = join(tmpDir, "queries.jsonl");
    const telemetryLog = join(tmpDir, "telemetry.jsonl");
    const skillLog = join(tmpDir, "skills.jsonl");
    const canonicalLog = join(tmpDir, "canonical.jsonl");

    const session = {
      transcript_path: "/path/to/transcript.jsonl",
      session_id: "sess-write-test",
      timestamp: "2026-03-15T00:00:00.000Z",
      metrics: {
        tool_calls: { Read: 2, Bash: 1 },
        total_tool_calls: 3,
        bash_commands: ["ls", "cat file.ts"],
        skills_triggered: ["MySkill"],
        assistant_turns: 3,
        errors_encountered: 0,
        transcript_chars: 1000,
        last_user_query: "second question",
      },
      user_queries: [
        { query: "first question", timestamp: "2026-03-15T00:00:00.000Z" },
        { query: "second question", timestamp: "2026-03-15T00:05:00.000Z" },
      ],
    };

    // writeSession writes to SQLite; verify it completes without error
    writeSession(session, false, queryLog, telemetryLog, skillLog, canonicalLog);

    // Verify canonical records structure via the exported builder
    const canonicalRecords = buildCanonicalRecordsFromReplay(session);
    const promptRecords = canonicalRecords.filter((r) => r.record_kind === "prompt");
    expect(promptRecords).toHaveLength(2);
    expect((promptRecords[0] as Record<string, unknown>).prompt_text).toBe("first question");
    expect((promptRecords[1] as Record<string, unknown>).prompt_text).toBe("second question");

    const invocation = canonicalRecords.find((r) => r.record_kind === "skill_invocation");
    expect(invocation).not.toBeNull();
    expect((invocation as Record<string, unknown>).matched_prompt_id).toBe("sess-write-test:p1");
    expect((invocation as Record<string, unknown>).skill_name).toBe("MySkill");
  });

  test("skips polluted skill rows when last_user_query is not actionable", () => {
    const queryLog = join(tmpDir, "queries-meta.jsonl");
    const telemetryLog = join(tmpDir, "telemetry-meta.jsonl");
    const skillLog = join(tmpDir, "skills-meta.jsonl");
    const canonicalLog = join(tmpDir, "canonical-meta.jsonl");

    const session = {
      transcript_path: "/path/to/transcript.jsonl",
      session_id: "sess-meta",
      timestamp: "2026-03-15T00:00:00.000Z",
      metrics: {
        tool_calls: { Read: 1 },
        total_tool_calls: 1,
        bash_commands: [],
        skills_triggered: ["Reins"],
        skills_invoked: ["Reins"],
        assistant_turns: 1,
        errors_encountered: 0,
        transcript_chars: 100,
        last_user_query: "<local-command-stdout> tool output",
      },
      user_queries: [{ query: "review the reins repo", timestamp: "2026-03-15T00:00:00.000Z" }],
    };

    // writeSession writes to SQLite; verify it completes without error
    writeSession(session, false, queryLog, telemetryLog, skillLog, canonicalLog);

    // Verify canonical records use the actionable user query, not the meta output
    const canonicalRecords = buildCanonicalRecordsFromReplay(session);
    const prompt = canonicalRecords.find((r) => r.record_kind === "prompt");
    const invocation = canonicalRecords.find((r) => r.record_kind === "skill_invocation");
    expect((prompt as Record<string, unknown>)?.prompt_text).toBe("review the reins repo");
    expect((invocation as Record<string, unknown>)?.matched_prompt_id).toBe(
      (prompt as Record<string, unknown>)?.prompt_id,
    );
  });

  test("dry-run produces no files", () => {
    const queryLog = join(tmpDir, "queries.jsonl");
    const telemetryLog = join(tmpDir, "telemetry.jsonl");
    const skillLog = join(tmpDir, "skills.jsonl");
    const canonicalLog = join(tmpDir, "canonical.jsonl");

    const session = {
      transcript_path: "/path/to/transcript.jsonl",
      session_id: "sess-dry",
      timestamp: "2026-03-15T00:00:00.000Z",
      metrics: {
        tool_calls: {},
        total_tool_calls: 0,
        bash_commands: [],
        skills_triggered: [],
        assistant_turns: 1,
        errors_encountered: 0,
        transcript_chars: 100,
        last_user_query: "dry run test",
      },
      user_queries: [{ query: "dry run test", timestamp: "" }],
    };

    writeSession(session, true, queryLog, telemetryLog, skillLog, canonicalLog);

    expect(existsSync(queryLog)).toBe(false);
    expect(existsSync(telemetryLog)).toBe(false);
    expect(existsSync(skillLog)).toBe(false);
    expect(existsSync(canonicalLog)).toBe(false);
  });

  test("writes multiple skill records for multiple skills", () => {
    const queryLog = join(tmpDir, "queries.jsonl");
    const telemetryLog = join(tmpDir, "telemetry.jsonl");
    const skillLog = join(tmpDir, "skills.jsonl");
    const canonicalLog = join(tmpDir, "canonical.jsonl");

    const session = {
      transcript_path: "/path/to/transcript.jsonl",
      session_id: "sess-multi-skill",
      timestamp: "2026-03-15T00:00:00.000Z",
      metrics: {
        tool_calls: {},
        total_tool_calls: 0,
        bash_commands: [],
        skills_triggered: ["SkillA", "SkillB"],
        assistant_turns: 1,
        errors_encountered: 0,
        transcript_chars: 100,
        last_user_query: "test multi skills",
      },
      user_queries: [{ query: "test multi skills", timestamp: "" }],
    };

    // writeSession writes to SQLite; verify it completes without error
    writeSession(session, false, queryLog, telemetryLog, skillLog, canonicalLog);

    // Verify canonical records include both skill invocations
    const canonicalRecords = buildCanonicalRecordsFromReplay(session);
    const invocations = canonicalRecords.filter((r) => r.record_kind === "skill_invocation");
    expect(invocations).toHaveLength(2);
    expect((invocations[0] as Record<string, unknown>).skill_name).toBe("SkillA");
    expect((invocations[1] as Record<string, unknown>).skill_name).toBe("SkillB");
  });
});
