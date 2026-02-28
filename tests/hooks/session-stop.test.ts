import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processSessionStop } from "../../cli/selftune/hooks/session-stop.js";
import type { SessionTelemetryRecord } from "../../cli/selftune/types.js";
import { readJsonl } from "../../cli/selftune/utils/jsonl.js";

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-session-stop-"));
  logPath = join(tmpDir, "telemetry.jsonl");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("session-stop hook", () => {
  test("extracts metrics from transcript", () => {
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

    const result = processSessionStop(
      {
        session_id: "sess-abc",
        transcript_path: transcriptPath,
        cwd: "/project",
      },
      logPath,
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

    const records = readJsonl<SessionTelemetryRecord>(logPath);
    expect(records).toHaveLength(1);
    expect(records[0].session_id).toBe("sess-abc");
  });

  test("handles missing transcript gracefully", () => {
    const result = processSessionStop(
      {
        session_id: "sess-missing",
        transcript_path: join(tmpDir, "nonexistent.jsonl"),
        cwd: "/project",
      },
      logPath,
    );

    expect(result).not.toBeNull();
    expect(result?.total_tool_calls).toBe(0);
    expect(result?.assistant_turns).toBe(0);
    expect(result?.bash_commands).toEqual([]);
    expect(result?.last_user_query).toBe("");

    const records = readJsonl<SessionTelemetryRecord>(logPath);
    expect(records).toHaveLength(1);
  });

  test("writes correct telemetry record with skills triggered", () => {
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

    const result = processSessionStop(
      {
        session_id: "sess-skills",
        transcript_path: transcriptPath,
        cwd: "/project",
      },
      logPath,
    );

    expect(result).not.toBeNull();
    expect(result?.skills_triggered).toEqual(["pdf"]);
    expect(result?.transcript_path).toBe(transcriptPath);
    expect(result?.timestamp).toBeTruthy();
  });

  test("defaults missing payload fields", () => {
    const result = processSessionStop({}, logPath);

    expect(result).not.toBeNull();
    expect(result?.session_id).toBe("unknown");
    expect(result?.cwd).toBe("");
    expect(result?.transcript_path).toBe("");
  });
});
