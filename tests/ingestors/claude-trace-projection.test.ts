import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _setTestDb, getDb, openDb } from "@selftune/local-store";
import {
  LocalTraceImportFailure,
  LocalTraceImporter,
  type LocalTraceImporterService,
} from "@selftune/observability";
import { deriveSkillInvocationId } from "@selftune/runtime/normalization";
import { Effect, Layer } from "effect";

import { buildLocalTelemetryBatchFromSession } from "@selftune/harness-claude-code/ingestors/claude-trace-projection";
import type { ParsedSession } from "@selftune/harness-claude-code/ingestors/claude-replay";
import { makeClaudeCodeSourceAdapter } from "@selftune/harness-claude-code/source-sync";

let temporaryRoot = "";

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "selftune-claude-trace-"));
  _setTestDb(openDb(":memory:"));
});

afterEach(() => {
  _setTestDb(null);
  rmSync(temporaryRoot, { recursive: true, force: true });
});

const session: ParsedSession = {
  transcript_path: "/private/project/secret-session.jsonl",
  session_id: "claude-trace-session",
  timestamp: "2026-07-23T10:00:00.000Z",
  user_queries: [{ query: "private prompt text", timestamp: "2026-07-23T10:00:00.000Z" }],
  metrics: {
    tool_calls: { Skill: 1 },
    total_tool_calls: 3,
    bash_commands: ["cat /private/token"],
    skills_triggered: ["diagnose"],
    assistant_turns: 1,
    errors_encountered: 1,
    transcript_chars: 999,
    last_user_query: "private prompt text",
    input_tokens: 12,
    output_tokens: 7,
    started_at: "2026-07-23T10:00:00.000Z",
    ended_at: "2026-07-23T10:00:03.000Z",
    model: "claude-test",
    skill_invocation_events: [
      {
        skill_name: "diagnose",
        tool_name: "Skill",
        tool_call_id: "tool-call-42",
        source_event_index: 17,
        triggered: true,
      },
    ],
  },
};

describe("Claude metadata trace projection", () => {
  test("is private, session-bounded, and links canonical invocation IDs", () => {
    const batch = buildLocalTelemetryBatchFromSession(session);
    const serialized = JSON.stringify(batch);

    expect(batch.spans).toHaveLength(1);
    expect(batch.spans[0]).toMatchObject({
      platform: "claude_code",
      capture_mode: "transcript",
      source_authority: "source_truth",
      trace_boundary: "session",
      operation_name: "invoke_agent",
      input_tokens: 12,
      output_tokens: 7,
      error_count: 1,
      tool_call_count: 3,
    });
    expect(batch.links?.[0]?.skill_invocation_id).toBe(
      deriveSkillInvocationId("claude-trace-session", "diagnose", 17, "tool-call-42"),
    );
    expect(serialized).not.toContain("private prompt text");
    expect(serialized).not.toContain("/private/project");
    expect(serialized).not.toContain("cat /private/token");
  });

  test("returns no trace facts when the source interval is absent or unordered", () => {
    expect(
      buildLocalTelemetryBatchFromSession({
        ...session,
        metrics: { ...session.metrics, ended_at: undefined },
      }).spans,
    ).toEqual([]);
    expect(
      buildLocalTelemetryBatchFromSession({
        ...session,
        metrics: { ...session.metrics, ended_at: "2026-07-23T09:59:59.000Z" },
      }).spans,
    ).toEqual([]);
  });
});

function writeTranscript(): string {
  const path = join(temporaryRoot, "projects", "hash", "source-sync.jsonl");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    [
      JSON.stringify({
        role: "user",
        content: "Keep this trace importer ordering test private",
        timestamp: "2026-07-23T10:00:00.000Z",
      }),
      JSON.stringify({
        role: "assistant",
        timestamp: "2026-07-23T10:00:01.000Z",
        content: [{ type: "tool_use", name: "Skill", id: "tool-1", input: { skill: "diagnose" } }],
      }),
      JSON.stringify({
        role: "assistant",
        content: "private model output",
        timestamp: "2026-07-23T10:00:02.000Z",
      }),
    ].join("\n"),
  );
  return path;
}

function importerLayer(service: LocalTraceImporterService) {
  return Layer.succeed(LocalTraceImporter, LocalTraceImporter.of(service));
}

test("source sync imports after SQLite, keeps failures retryable, and bypasses import on dry run", async () => {
  const transcriptPath = writeTranscript();
  const markerPath = join(temporaryRoot, "marker.json");
  const sync = makeClaudeCodeSourceAdapter(markerPath).sync;
  const calls: string[] = [];
  const request = (dryRun: boolean) => ({
    sourceRoot: join(temporaryRoot, "projects"),
    dryRun,
    force: false,
    skillLogPath: join(temporaryRoot, "skills.jsonl"),
  });
  const failureLayer = importerLayer({
    importTrace: () => {
      calls.push(`sqlite=${getDb().query("SELECT COUNT(*) AS count FROM sessions").get().count}`);
      return Effect.fail(
        LocalTraceImportFailure.make({ operation: "fixture", message: "analytics unavailable" }),
      );
    },
  });
  const successLayer = importerLayer({
    importTrace: () => {
      calls.push("imported");
      return Effect.succeed({ skill_failure_signals: [] });
    },
  });

  await expect(
    Effect.runPromise(sync(request(true)).pipe(Effect.provide(failureLayer))),
  ).resolves.toMatchObject({ synced: 1 });
  expect(calls).toEqual([]);
  expect(existsSync(markerPath)).toBe(false);

  await expect(
    Effect.runPromise(sync(request(false)).pipe(Effect.provide(failureLayer))),
  ).rejects.toMatchObject({ operation: "import Claude Code analytical trace" });
  expect(calls).toEqual(["sqlite=1"]);
  expect(existsSync(markerPath)).toBe(false);

  await expect(
    Effect.runPromise(sync(request(false)).pipe(Effect.provide(successLayer))),
  ).resolves.toMatchObject({ synced: 1, authoritativeFiles: [transcriptPath] });
  expect(calls).toEqual(["sqlite=1", "imported"]);
  expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
    files: { [transcriptPath]: expect.anything() },
  });
});
