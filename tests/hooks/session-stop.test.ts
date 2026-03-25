import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processPrompt } from "../../cli/selftune/hooks/prompt-log.js";
import {
  maybeSpawnReactiveOrchestrate,
  processSessionStop,
} from "../../cli/selftune/hooks/session-stop.js";
import {
  _setTestDb,
  getDb,
  openDb,
} from "../../cli/selftune/localdb/db.js";
import { writeImprovementSignalToDb } from "../../cli/selftune/localdb/direct-write.js";

let tmpDir: string;
let canonicalLogPath: string;
let promptStatePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-session-stop-"));
  canonicalLogPath = join(tmpDir, "canonical.jsonl");
  promptStatePath = join(tmpDir, "canonical-session-state.json");

  const testDb = openDb(":memory:");
  _setTestDb(testDb);
});

afterEach(() => {
  _setTestDb(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper to count session telemetry rows in the test database. */
function telemetryCount(): number {
  const db = getDb();
  const row = db.query("SELECT COUNT(*) as cnt FROM session_telemetry").get() as { cnt: number };
  return row.cnt;
}

/** Helper to read session telemetry from the test database. */
function querySessionTelemetry(): Array<{ session_id: string }> {
  const db = getDb();
  return db.query("SELECT session_id FROM session_telemetry ORDER BY timestamp").all() as Array<{
    session_id: string;
  }>;
}

describe("session-stop hook", () => {
  test("extracts metrics from transcript", async () => {
    const transcriptPath = join(tmpDir, "transcript.jsonl");
    const lines = [
      JSON.stringify({ role: "user", content: "Fix the login bug" }),
      JSON.stringify({
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "/src/auth.ts" } },
          { type: "tool_use", name: "Edit", input: { file_path: "/src/auth.ts" } },
        ],
      }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }],
      }),
    ];
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    const result = await processSessionStop(
      {
        session_id: "sess-abc",
        transcript_path: transcriptPath,
        cwd: "/project",
      },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );

    expect(result).not.toBeNull();
    expect(result?.session_id).toBe("sess-abc");
    expect(result?.cwd).toBe("/project");
    expect(result?.tool_calls.Read).toBe(1);
    expect(result?.tool_calls.Edit).toBe(1);
    expect(result?.tool_calls.Bash).toBe(1);
    expect(result?.total_tool_calls).toBe(3);
    expect(result?.bash_commands).toEqual(["bun test"]);
    expect(result?.assistant_turns).toBe(2);
    expect(result?.last_user_query).toBe("Fix the login bug");

    const records = querySessionTelemetry();
    expect(records).toHaveLength(1);
    expect(records[0].session_id).toBe("sess-abc");
  });

  test("handles missing transcript gracefully", async () => {
    const result = await processSessionStop(
      {
        session_id: "sess-missing",
        transcript_path: join(tmpDir, "nonexistent.jsonl"),
        cwd: "/project",
      },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );

    expect(result).not.toBeNull();
    expect(result?.total_tool_calls).toBe(0);
    expect(result?.assistant_turns).toBe(0);
    expect(result?.bash_commands).toEqual([]);
    expect(result?.last_user_query).toBe("");

    expect(telemetryCount()).toBe(1);
  });

  test("writes correct telemetry record with skills triggered", async () => {
    const transcriptPath = join(tmpDir, "transcript2.jsonl");
    const lines = [
      JSON.stringify({ role: "user", content: "Create a PDF report" }),
      JSON.stringify({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "/skills/pdf/SKILL.md" },
          },
        ],
      }),
    ];
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    const result = await processSessionStop(
      {
        session_id: "sess-skills",
        transcript_path: transcriptPath,
        cwd: "/project",
      },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );

    expect(result).not.toBeNull();
    expect(result?.skills_triggered).toEqual(["pdf"]);
    expect(result?.transcript_path).toBe(transcriptPath);
    expect(result?.timestamp).toBeTruthy();
  });

  test("defaults missing payload fields", async () => {
    const result = await processSessionStop({}, undefined, canonicalLogPath, promptStatePath);

    expect(result).not.toBeNull();
    expect(result?.session_id).toBe("unknown");
    expect(result?.cwd).toBe("");
    expect(result?.transcript_path).toBe("");
  });

  test("links execution facts to the latest actionable prompt via state file", async () => {
    await processPrompt(
      { user_prompt: "First prompt", session_id: "sess-link" },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );
    await processPrompt(
      { user_prompt: "Second prompt", session_id: "sess-link" },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );

    // Verify prompt state tracks the second prompt as the last actionable
    const state = JSON.parse(readFileSync(promptStatePath, "utf-8"));
    expect(state.last_actionable_prompt_id).toBe("sess-link:p1");

    const transcriptPath = join(tmpDir, "transcript-linked.jsonl");
    writeFileSync(transcriptPath, `${JSON.stringify({ role: "assistant", content: [] })}\n`);

    const result = await processSessionStop(
      {
        session_id: "sess-link",
        transcript_path: transcriptPath,
        cwd: "/project",
      },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );

    // Session stop result should be valid
    expect(result).not.toBeNull();
    expect(result?.session_id).toBe("sess-link");
  });

  test("reactive orchestrate spawns when signals exist and no fresh lock is held", async () => {
    writeImprovementSignalToDb({
      timestamp: new Date().toISOString(),
      session_id: "sess-reactive",
      query: "why didn't you use selftune",
      signal_type: "correction",
      mentioned_skill: "selftune",
      consumed: false,
    });

    let spawned = 0;
    const lockPath = join(tmpDir, "orchestrate.lock");
    const result = await maybeSpawnReactiveOrchestrate(lockPath, {
      spawnOrchestrate: () => {
        spawned++;
        return true;
      },
    });

    expect(result).toBe(true);
    expect(spawned).toBe(1);
  });

  test("reactive orchestrate does not spawn when a fresh orchestrate lock exists", async () => {
    writeImprovementSignalToDb({
      timestamp: new Date().toISOString(),
      session_id: "sess-locked",
      query: "why didn't you use selftune",
      signal_type: "correction",
      mentioned_skill: "selftune",
      consumed: false,
    });

    const lockPath = join(tmpDir, "orchestrate.lock");
    writeFileSync(lockPath, JSON.stringify({ timestamp: new Date().toISOString(), pid: 1234 }));

    let spawned = 0;
    const result = await maybeSpawnReactiveOrchestrate(lockPath, {
      spawnOrchestrate: () => {
        spawned++;
        return true;
      },
    });

    expect(result).toBe(false);
    expect(spawned).toBe(0);
  });
});
