import { afterEach, describe, expect, test } from "bun:test";

import { Effect, Layer } from "effect";

import { _setTestDb, openDb } from "@selftune/local-store";
import { createHarnessSourceRegistry } from "@selftune/harness-core/source-adapter";
import type { SyncProgramInput } from "@selftune/orchestration/sync/model";
import { makeSyncLiveLayer } from "@selftune/orchestration/sync/live";
import { makeSyncProgressLayer, runSyncProgram } from "@selftune/orchestration/sync/programs";
import { writeQueryToDb } from "@selftune/runtime/localdb/direct-write";

afterEach(() => {
  _setTestDb(null);
});

describe("sync live layer", () => {
  test("shares one scoped database across source writers, core staging, and cron audit", async () => {
    const database = openDb(":memory:");
    _setTestDb(database);
    let creatorDatabaseMatches = false;
    const liveLayer = makeSyncLiveLayer(
      {
        sourceRegistry: createHarnessSourceRegistry([
          {
            id: "opencode",
            phase: "opencode",
            sync: () =>
              Effect.sync(() => {
                writeQueryToDb({
                  timestamp: "2026-01-01T00:00:00.000Z",
                  session_id: "sync-live-session",
                  query: "sync from source",
                  source: "test",
                });
                return { available: true, scanned: 1, synced: 1, skipped: 0 };
              }),
          },
        ]),
        stageCreatorContributions: (coreDatabase) => {
          creatorDatabaseMatches = coreDatabase === database;
          return { eligible_skills: 0, built_signals: 0, staged_signals: 0 };
        },
      },
      {
        defaults: {
          projectsDir: "/defaults/claude",
          codexHome: "/defaults/codex",
          opencodeDataDir: "/defaults/opencode",
          openclawAgentsDir: "/defaults/openclaw",
          piSessionsDir: "/defaults/pi",
          skillLogPath: "/defaults/skill-log.jsonl",
          repairedSkillLogPath: "/defaults/repaired.jsonl",
          repairedSessionsPath: "/defaults/repaired-sessions.json",
        },
        importSources: {
          claude_code: true,
          codex: true,
          opencode: true,
          openclaw: true,
          pi: true,
        },
      },
    );
    const layer = Layer.merge(
      liveLayer,
      makeSyncProgressLayer(() => {}),
    );
    const input: SyncProgramInput = {
      dryRun: true,
      force: false,
      skipClaude: true,
      skipCodex: true,
      skipOpenCode: false,
      skipOpenClaw: true,
      skipPi: true,
      skipRepair: true,
      jsonOutput: true,
    };

    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* runSyncProgram(input);
        return {
          result,
          queryCount:
            database.query<{ count: number }, []>("SELECT count(*) AS count FROM queries").get()
              ?.count ?? 0,
          cronCount:
            database.query<{ count: number }, []>("SELECT count(*) AS count FROM cron_runs").get()
              ?.count ?? 0,
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(observed.result.sync.sources.opencode.synced).toBe(1);
    expect(observed.queryCount).toBe(1);
    expect(observed.cronCount).toBe(1);
    expect(creatorDatabaseMatches).toBe(true);
    expect(() => database.query("SELECT 1").get()).toThrow();
  });
});
