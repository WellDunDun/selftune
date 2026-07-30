import { describe, expect, test } from "bun:test";

import { Effect, Layer } from "effect";

import type { WatchDiagnostic, WatchEvaluationResult } from "@selftune/runtime/monitoring/watch";
import type { SyncResult } from "@selftune/source-management/sync";
import type { MonitoringSnapshot } from "@selftune/runtime/types";
import type { WatchProgramInput } from "@selftune/orchestration/watch/model";
import { runWatchProgram } from "@selftune/orchestration/watch/programs";
import {
  WatchDiagnostics,
  WatchEvaluation,
  WatchMemory,
  WatchRollback,
  WatchSourceSync,
  watchInternalFailure,
} from "@selftune/orchestration/watch/services";

const input: WatchProgramInput = {
  skillName: "demo",
  skillPath: "skills/demo/SKILL.md",
  windowSessions: 20,
  regressionThreshold: 0.1,
  gradeRegressionThreshold: 0.15,
  enableGradeWatch: true,
  autoRollback: false,
  syncFirst: false,
  syncForce: false,
};

function snapshot(regressionDetected: boolean): MonitoringSnapshot {
  return {
    timestamp: "2026-07-17T00:00:00.000Z",
    skill_name: "demo",
    window_sessions: 20,
    skill_checks: 3,
    pass_rate: regressionDetected ? 0 : 1,
    false_negative_rate: regressionDetected ? 1 : 0,
    by_invocation_type: {
      explicit: { passed: 0, total: 0 },
      implicit: { passed: regressionDetected ? 0 : 3, total: 3 },
      contextual: { passed: 0, total: 0 },
      negative: { passed: 0, total: 0 },
    },
    regression_detected: regressionDetected,
    baseline_pass_rate: 0.5,
  };
}

function evaluation(alert: string | null): WatchEvaluationResult {
  return {
    skillPath: input.skillPath,
    snapshot: snapshot(alert !== null),
    alert,
    proposalId: "proposal-1",
    gradeAlert: null,
    gradeRegression: null,
    efficiencyAlert: null,
    efficiencyRegression: null,
  };
}

function syncResult(): SyncResult {
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

interface TestHandlers {
  readonly sync?: (force: boolean) => Effect.Effect<SyncResult, never>;
  readonly evaluate?: (
    onDiagnostic: (diagnostic: WatchDiagnostic) => void,
  ) => Effect.Effect<WatchEvaluationResult, never>;
  readonly rollback?: () => Effect.Effect<
    {
      rolledBack: boolean;
      restoredDescription: string;
      reason: string;
    },
    ReturnType<typeof watchInternalFailure>
  >;
  readonly memory?: () => Effect.Effect<void, ReturnType<typeof watchInternalFailure>>;
  readonly reportDiagnostic?: (message: string) => void;
}

function makeTestLayer(handlers: TestHandlers = {}) {
  return Layer.mergeAll(
    Layer.succeed(WatchSourceSync, {
      run: (force) => handlers.sync?.(force) ?? Effect.succeed(syncResult()),
    }),
    Layer.succeed(WatchEvaluation, {
      run: (_options, onDiagnostic) =>
        handlers.evaluate?.(onDiagnostic) ?? Effect.succeed(evaluation(null)),
    }),
    Layer.succeed(WatchRollback, {
      run: () =>
        handlers.rollback?.() ??
        Effect.succeed({ rolledBack: false, restoredDescription: "", reason: "not needed" }),
    }),
    Layer.succeed(WatchMemory, {
      update: () => handlers.memory?.() ?? Effect.void,
    }),
    Layer.succeed(WatchDiagnostics, {
      report: handlers.reportDiagnostic ?? (() => {}),
    }),
  );
}

describe("watch Effect program", () => {
  test("runs sync, evaluation, rollback, and memory in order on an alert", async () => {
    const order: string[] = [];
    const result = await Effect.runPromise(
      runWatchProgram({
        ...input,
        syncFirst: true,
        syncForce: true,
        autoRollback: true,
      }).pipe(
        Effect.provide(
          makeTestLayer({
            sync: (force) =>
              Effect.sync(() => {
                order.push(`sync:${force}`);
                return syncResult();
              }),
            evaluate: () =>
              Effect.sync(() => {
                order.push("evaluate");
                return evaluation("regression detected");
              }),
            rollback: () =>
              Effect.sync(() => {
                order.push("rollback");
                return { rolledBack: true, restoredDescription: "before", reason: "restored" };
              }),
            memory: () => Effect.sync(() => order.push("memory")),
          }),
        ),
      ),
    );

    expect(order).toEqual(["sync:true", "evaluate", "rollback", "memory"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([]);
    expect(result.watch).toMatchObject({
      alert: "regression detected",
      rolledBack: true,
      recommended_command: null,
      sync_result: { dry_run: false },
    });
    expect(JSON.parse(result.stdout[0])).toEqual(result.watch);
  });

  test("skips source sync and rollback when they are not requested", async () => {
    let syncCalls = 0;
    let rollbackCalls = 0;
    const result = await Effect.runPromise(
      runWatchProgram(input).pipe(
        Effect.provide(
          makeTestLayer({
            sync: () => Effect.sync(() => (syncCalls += 1)).pipe(Effect.as(syncResult())),
            rollback: () =>
              Effect.sync(() => (rollbackCalls += 1)).pipe(
                Effect.as({ rolledBack: true, restoredDescription: "", reason: "unexpected" }),
              ),
          }),
        ),
      ),
    );

    expect(syncCalls).toBe(0);
    expect(rollbackCalls).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.watch.sync_result).toBeUndefined();
  });

  test("returns fail-open diagnostics in evaluation then memory order", async () => {
    const diagnostics: string[] = [];
    const result = await Effect.runPromise(
      runWatchProgram(input).pipe(
        Effect.provide(
          makeTestLayer({
            evaluate: (onDiagnostic) =>
              Effect.sync(() => {
                onDiagnostic({
                  code: "grade_watch_failed",
                  message: 'Grade watch failed for "demo": grade database unavailable',
                });
                return evaluation(null);
              }),
            memory: () => Effect.fail(watchInternalFailure("memory", "disk full")),
            reportDiagnostic: (message) => diagnostics.push(message),
          }),
        ),
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(diagnostics).toEqual([
      JSON.stringify({
        level: "debug",
        code: "grade_watch_failed",
        message: 'Grade watch failed for "demo": grade database unavailable',
      }),
      JSON.stringify({
        level: "debug",
        code: "memory_write_failed",
        message: 'Failed to update memory after watch for "demo": disk full',
      }),
    ]);
  });

  test("emits evaluation diagnostics before a later rollback failure", async () => {
    const diagnostics: string[] = [];
    const failure = await Effect.runPromise(
      runWatchProgram({ ...input, autoRollback: true }).pipe(
        Effect.provide(
          makeTestLayer({
            evaluate: (onDiagnostic) =>
              Effect.sync(() => {
                onDiagnostic({
                  code: "grade_watch_failed",
                  message: 'Grade watch failed for "demo": unavailable',
                });
                return evaluation("trigger regression");
              }),
            rollback: () => Effect.fail(watchInternalFailure("rollback", "rollback failed")),
            reportDiagnostic: (message) => diagnostics.push(message),
          }),
        ),
        Effect.flip,
      ),
    );

    expect(failure).toMatchObject({ operation: "rollback", message: "rollback failed" });
    expect(diagnostics).toEqual([
      JSON.stringify({
        level: "debug",
        code: "grade_watch_failed",
        message: 'Grade watch failed for "demo": unavailable',
      }),
    ]);
  });
});
