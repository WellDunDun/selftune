import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { Effect, Fiber, Layer } from "effect";

import { _setTestDb, getDrizzleDb, LocalDatabaseService, openDb } from "@selftune/local-store";
import type { WatchEvaluationResult } from "@selftune/runtime/monitoring/watch";
import type { MonitoringSnapshot } from "@selftune/runtime/types";
import { makeWatchLiveLayer } from "@selftune/orchestration/watch/live";
import type { WatchProgramInput } from "@selftune/orchestration/watch/model";
import { runWatchProgram } from "@selftune/orchestration/watch/programs";
import { WatchDiagnostics, watchInternalFailure } from "@selftune/orchestration/watch/services";

const input: WatchProgramInput = {
  skillName: "demo",
  skillPath: "skills/demo/SKILL.md",
  windowSessions: 20,
  regressionThreshold: 0.1,
  gradeRegressionThreshold: 0.15,
  enableGradeWatch: true,
  autoRollback: false,
  syncFirst: true,
  syncForce: false,
};

function stableEvaluation(): WatchEvaluationResult {
  const snapshot: MonitoringSnapshot = {
    timestamp: "2026-07-17T00:00:00.000Z",
    skill_name: "demo",
    window_sessions: 20,
    skill_checks: 3,
    pass_rate: 1,
    false_negative_rate: 0,
    by_invocation_type: {
      explicit: { passed: 0, total: 0 },
      implicit: { passed: 3, total: 3 },
      contextual: { passed: 0, total: 0 },
      negative: { passed: 0, total: 0 },
    },
    regression_detected: false,
    baseline_pass_rate: 0.5,
  };
  return {
    skillPath: input.skillPath,
    snapshot,
    alert: null,
    gradeAlert: null,
    gradeRegression: null,
    efficiencyAlert: null,
    efficiencyRegression: null,
  };
}

function unavailableSync() {
  const unavailable = { available: false, scanned: 0, synced: 0, skipped: 0 };
  return {
    since: null,
    dry_run: false,
    sources: {
      claude: unavailable,
      codex: unavailable,
      opencode: unavailable,
      openclaw: unavailable,
      pi: unavailable,
    },
    repair: {
      ran: true,
      repaired_sessions: 0,
      repaired_records: 0,
      codex_repaired_records: 0,
    },
    creator_contributions: {
      ran: true,
      eligible_skills: 0,
      built_signals: 0,
      staged_signals: 0,
    },
    timings: [],
    total_elapsed_ms: 0,
  };
}

function trackedDatabaseLayer(events: string[]) {
  return Layer.effect(
    LocalDatabaseService,
    Effect.acquireRelease(
      Effect.sync(() => {
        events.push("acquire");
        const sqlite = new Database(":memory:");
        return { sqlite, drizzle: getDrizzleDb(sqlite) };
      }),
      ({ sqlite }) =>
        Effect.sync(() => {
          events.push("release");
          sqlite.close();
        }),
    ),
  );
}

afterEach(() => {
  _setTestDb(null);
});

describe("watch live layer lifecycle", () => {
  test("does not close a singleton borrowed from an outer host", async () => {
    const borrowed = openDb(":memory:");
    _setTestDb(borrowed);
    const layer = makeWatchLiveLayer({
      sync: () => Effect.succeed(unavailableSync()),
      evaluate: () => Effect.succeed(stableEvaluation()),
      updateMemory: () => Effect.void,
    });

    await Effect.runPromise(
      runWatchProgram(input).pipe(
        Effect.provide(Layer.merge(layer, Layer.succeed(WatchDiagnostics, { report: () => {} }))),
      ),
    );

    expect(borrowed.query("SELECT 1 AS value").get()).toEqual({ value: 1 });
  });

  test("shares one database between source sync and evaluation and releases it on success", async () => {
    const events: string[] = [];
    let syncDatabase: Database | undefined;
    let evaluationDatabase: Database | undefined;
    const layer = makeWatchLiveLayer({
      databaseLayer: trackedDatabaseLayer(events),
      sync: (_force, database) => {
        syncDatabase = database;
        return Effect.succeed(unavailableSync());
      },
      evaluate: (_options, database) => {
        evaluationDatabase = database;
        return Effect.succeed(stableEvaluation());
      },
      updateMemory: () => Effect.void,
    });

    await Effect.runPromise(
      runWatchProgram(input).pipe(
        Effect.provide(Layer.merge(layer, Layer.succeed(WatchDiagnostics, { report: () => {} }))),
      ),
    );

    expect(syncDatabase).toBe(evaluationDatabase);
    expect(events).toEqual(["acquire", "release"]);
  });

  test("releases the database when evaluation fails", async () => {
    const events: string[] = [];
    const layer = makeWatchLiveLayer({
      databaseLayer: trackedDatabaseLayer(events),
      sync: () => Effect.succeed(unavailableSync()),
      evaluate: () => Effect.fail(watchInternalFailure("evaluation", "failed")),
      updateMemory: () => Effect.void,
    });

    const failure = await Effect.runPromise(
      runWatchProgram(input).pipe(
        Effect.provide(Layer.merge(layer, Layer.succeed(WatchDiagnostics, { report: () => {} }))),
        Effect.flip,
      ),
    );

    expect(failure).toMatchObject({ operation: "evaluation", message: "failed" });
    expect(events).toEqual(["acquire", "release"]);
  });

  test("releases the database when the program is interrupted", async () => {
    const events: string[] = [];
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const layer = makeWatchLiveLayer({
      databaseLayer: trackedDatabaseLayer(events),
      sync: () => Effect.succeed(unavailableSync()),
      evaluate: () => Effect.sync(() => markStarted?.()).pipe(Effect.andThen(Effect.never)),
      updateMemory: () => Effect.void,
    });
    const fiber = Effect.runFork(
      runWatchProgram(input).pipe(
        Effect.provide(Layer.merge(layer, Layer.succeed(WatchDiagnostics, { report: () => {} }))),
      ),
    );

    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(events).toEqual(["acquire", "release"]);
  });
});
