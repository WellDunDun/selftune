import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

import { buildLocalTelemetryBatchFromPiSession } from "@selftune/harness-pi/ingestors/pi-trace-projection";
import {
  findPiSkillNames,
  parsePiSession,
  type ParsedSession,
} from "@selftune/harness-pi/ingestors/pi-ingest";
import { makePiSourceAdapter } from "@selftune/harness-pi/source-sync";

let temporaryRoot = "";

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "selftune-pi-trace-"));
  _setTestDb(openDb(":memory:"));
});

afterEach(() => {
  _setTestDb(null);
  rmSync(temporaryRoot, { recursive: true, force: true });
});

const session: ParsedSession = {
  timestamp: "2026-07-23T10:00:00.000Z",
  ended_at: "2026-07-23T10:00:03.000Z",
  session_id: "pi-trace-session",
  source: "pi",
  transcript_path: "/private/project/session.jsonl",
  cwd: "/private/project",
  last_user_query: "private prompt text",
  query: "private prompt text",
  tool_calls: { Bash: 2 },
  total_tool_calls: 2,
  bash_commands: ["cat /private/token"],
  skills_triggered: ["diagnose"],
  skill_detections: [{ skill_name: "diagnose", has_skill_md_read: true }],
  assistant_turns: 1,
  errors_encountered: 1,
  transcript_chars: 999,
  provider: "private-provider",
  model: "private-model",
  input_tokens: 12,
  output_tokens: 7,
};

test("projects Pi metadata privately with canonical skill correlation", () => {
  const batch = buildLocalTelemetryBatchFromPiSession(session);
  const serialized = JSON.stringify(batch);

  expect(batch.spans[0]).toMatchObject({
    platform: "pi",
    capture_mode: "session",
    source_authority: "source_truth",
    trace_boundary: "session",
    operation_name: "invoke_agent",
    input_tokens: 12,
    output_tokens: 7,
    error_count: 1,
    tool_call_count: 2,
  });
  expect(batch.links?.[0]?.skill_invocation_id).toBe(
    deriveSkillInvocationId("pi-trace-session", "diagnose", 0),
  );
  expect(serialized).not.toContain("private prompt text");
  expect(serialized).not.toContain("/private/project");
  expect(serialized).not.toContain("cat /private/token");
});

test("emits no Pi trace facts without an ordered source interval", () => {
  expect(buildLocalTelemetryBatchFromPiSession({ ...session, ended_at: undefined }).spans).toEqual(
    [],
  );
  expect(
    buildLocalTelemetryBatchFromPiSession({
      ...session,
      ended_at: "2026-07-23T09:59:59.000Z",
    }).spans,
  ).toEqual([]);
});

test("parses Pi's real lowercase read tool shape as an explicit skill invocation", () => {
  const skillRoot = join(temporaryRoot, "skills");
  const skillDirectory = join(skillRoot, "diagnose");
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(join(skillDirectory, "SKILL.md"), "# Diagnose", "utf8");

  const path = join(temporaryRoot, "real-pi-shape.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "session",
        id: "pi-real-shape",
        timestamp: "2026-07-23T10:00:00.000Z",
        cwd: "/private/workspace",
      }),
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-07-23T10:00:01.000Z",
        message: { role: "user", content: "Diagnose the issue" },
      }),
      JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-07-23T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "read",
              arguments: {
                path: join(skillDirectory, "SKILL.md"),
                offset: 1,
                limit: 200,
              },
            },
          ],
        },
      }),
    ].join("\n"),
    "utf8",
  );

  expect(findPiSkillNames([skillRoot])).toEqual(new Set(["diagnose"]));
  expect(parsePiSession(path, new Set())).toMatchObject({
    tool_calls: { read: 1 },
    total_tool_calls: 1,
    skills_triggered: ["diagnose"],
    skill_detections: [{ skill_name: "diagnose", has_skill_md_read: true }],
  });
});

function writeSession(): string {
  const path = join(temporaryRoot, "--workspace--", "source-sync.jsonl");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "session",
        id: "pi-source-sync-session",
        timestamp: "2026-07-23T10:00:00.000Z",
        cwd: "/private/workspace",
      }),
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-07-23T10:00:01.000Z",
        message: { role: "user", content: "private source sync prompt" },
      }),
      JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-07-23T10:00:02.000Z",
        message: { role: "assistant", content: "private model output" },
      }),
    ].join("\n"),
    "utf8",
  );
  return path;
}

function importerLayer(service: LocalTraceImporterService) {
  return Layer.succeed(LocalTraceImporter, LocalTraceImporter.of(service));
}

test("imports after SQLite and retains the file for retry when analytical import fails", async () => {
  const sessionPath = writeSession();
  const markerPath = join(temporaryRoot, "marker.json");
  const sync = makePiSourceAdapter(markerPath).sync;
  const calls: string[] = [];
  const request = (dryRun: boolean) => ({
    sourceRoot: temporaryRoot,
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
  ).resolves.toMatchObject({
    synced: 1,
  });
  expect(calls).toEqual([]);
  expect(existsSync(markerPath)).toBe(false);

  await expect(
    Effect.runPromise(sync(request(false)).pipe(Effect.provide(failureLayer))),
  ).rejects.toMatchObject({
    operation: "import Pi analytical trace",
  });
  expect(calls).toEqual(["sqlite=1"]);
  expect(existsSync(markerPath)).toBe(false);

  await expect(
    Effect.runPromise(sync(request(false)).pipe(Effect.provide(successLayer))),
  ).resolves.toMatchObject({
    synced: 1,
    authoritativeFiles: [sessionPath],
  });
  expect(calls).toEqual(["sqlite=1", "imported"]);
  expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
    files: { [sessionPath]: expect.anything() },
  });

  const firstMarker = readFileSync(markerPath, "utf8");
  appendFileSync(
    sessionPath,
    `\n${JSON.stringify({
      type: "message",
      id: "assistant-2",
      parentId: "assistant-1",
      timestamp: "2026-07-23T10:00:03.000Z",
      message: { role: "assistant", content: "revised private model output" },
    })}`,
    "utf8",
  );
  await expect(
    Effect.runPromise(sync(request(false)).pipe(Effect.provide(successLayer))),
  ).resolves.toMatchObject({
    synced: 1,
  });
  expect(calls).toEqual(["sqlite=1", "imported", "imported"]);
  expect(readFileSync(markerPath, "utf8")).not.toBe(firstMarker);
});
