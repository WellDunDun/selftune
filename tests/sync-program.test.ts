import { describe, expect, test } from "bun:test";

import { Effect, Layer, Result } from "effect";

import type { SyncOptions, SyncProgramInput, SyncResult } from "@selftune/orchestration/sync/model";
import { runSyncProgram } from "@selftune/orchestration/sync/programs";
import {
  SyncAlphaUpload,
  SyncAudit,
  SyncCore,
  SyncInternalFailure,
  SyncProgress,
  SyncPreferences,
} from "@selftune/orchestration/sync/services";

const input: SyncProgramInput = {
  since: new Date("2026-01-01T00:00:00.000Z"),
  sinceArgument: "2026-01-01",
  dryRun: false,
  force: true,
  skipClaude: false,
  skipCodex: true,
  skipOpenCode: false,
  skipOpenClaw: false,
  skipPi: false,
  skipRepair: false,
  jsonOutput: false,
};

const syncResult: SyncResult = {
  since: "2026-01-01T00:00:00.000Z",
  dry_run: false,
  sources: {
    claude: { available: true, scanned: 3, synced: 2, skipped: 1 },
    codex: { available: false, scanned: 0, synced: 0, skipped: 0 },
    opencode: { available: true, scanned: 1, synced: 1, skipped: 0 },
    openclaw: { available: false, scanned: 0, synced: 0, skipped: 0 },
    pi: { available: false, scanned: 0, synced: 0, skipped: 0 },
  },
  repair: {
    ran: true,
    repaired_sessions: 2,
    repaired_records: 4,
    codex_repaired_records: 0,
  },
  creator_contributions: {
    ran: true,
    eligible_skills: 1,
    built_signals: 2,
    staged_signals: 1,
  },
  timings: [
    { phase: "claude", elapsed_ms: 12 },
    { phase: "repair", elapsed_ms: 1_200 },
    { phase: "creator_contributions", elapsed_ms: 4 },
  ],
  total_elapsed_ms: 1_500,
};

const defaults = {
  projectsDir: "/defaults/claude",
  codexHome: "/defaults/codex",
  opencodeDataDir: "/defaults/opencode",
  openclawAgentsDir: "/defaults/openclaw",
  piSessionsDir: "/defaults/pi",
  skillLogPath: "/defaults/skill-log.jsonl",
  repairedSkillLogPath: "/defaults/repaired.jsonl",
  repairedSessionsPath: "/defaults/repaired-sessions.json",
};

function preferencesLayer(events: string[]) {
  return Layer.succeed(SyncPreferences, {
    load: () => {
      events.push("preferences");
      return Effect.succeed({
        defaults,
        importSources: {
          claude_code: true,
          codex: true,
          opencode: false,
          openclaw: true,
          pi: true,
        },
      });
    },
  });
}

function progressLayer(events: string[]) {
  return Layer.succeed(SyncProgress, {
    report: (message) => events.push(`progress:${message}`),
  });
}

describe("runSyncProgram", () => {
  test("orders core, success audit, and alpha while preserving output and preferences", async () => {
    const events: string[] = [];
    const optionsSeen: SyncOptions[] = [];
    const successAudits: unknown[] = [];
    const errorAudits: unknown[] = [];
    const layer = Layer.mergeAll(
      progressLayer(events),
      preferencesLayer(events),
      Layer.succeed(SyncCore, {
        run: (options, onProgress) => {
          events.push("core");
          optionsSeen.push(options);
          onProgress?.("starting sync...");
          onProgress?.("scanning Claude transcripts...");
          return Effect.succeed(syncResult);
        },
      }),
      Layer.succeed(SyncAudit, {
        recordSuccess: (audit) => {
          events.push("success-audit");
          successAudits.push(audit);
          return Effect.void;
        },
        recordError: (audit) => {
          events.push("error-audit");
          errorAudits.push(audit);
          return Effect.void;
        },
      }),
      Layer.succeed(SyncAlphaUpload, {
        run: () => {
          events.push("alpha");
          return Effect.succeed({ enrolled: true, prepared: 2, sent: 1, failed: 1, skipped: 0 });
        },
      }),
    );

    const result = await Effect.runPromise(runSyncProgram(input).pipe(Effect.provide(layer)));

    expect(events).toEqual([
      "progress:selftune sync --force --since 2026-01-01",
      "preferences",
      "core",
      "progress:  starting sync...",
      "progress:  scanning Claude transcripts...",
      "success-audit",
      "alpha",
    ]);
    expect(successAudits).toHaveLength(1);
    expect(errorAudits).toHaveLength(0);
    expect(optionsSeen[0]).toMatchObject({
      projectsDir: defaults.projectsDir,
      syncClaude: true,
      syncCodex: false,
      syncOpenCode: false,
      syncOpenClaw: true,
      syncPi: true,
      rebuildSkillUsage: true,
    });
    expect(result.stderr[0]).toBe("");
    expect(result.stderr).not.toContain("selftune sync --force --since 2026-01-01");
    expect(result.stderr).not.toContain("  starting sync...");
    expect(result.stderr).toContain("  Claude: scanned 3, synced 2, skipped 1 (12ms)");
    expect(result.stderr).toContain("Repair: 4 records, 2 sessions (1.2s)");
    expect(result.stderr.at(-1)).toBe("Alpha upload: prepared=2, sent=1, failed=1");
    expect(result.alphaUpload?.failed).toBe(1);
  });

  test("records one error audit and does not run alpha after core failure", async () => {
    const events: string[] = [];
    const failure = SyncInternalFailure.make({ operation: "sync", message: "source failed" });
    const layer = Layer.mergeAll(
      progressLayer(events),
      preferencesLayer(events),
      Layer.succeed(SyncCore, {
        run: (_options, onProgress) => {
          events.push("core");
          onProgress?.("scanning failed source...");
          return Effect.fail(failure);
        },
      }),
      Layer.succeed(SyncAudit, {
        recordSuccess: () => {
          events.push("success-audit");
          return Effect.void;
        },
        recordError: (audit) => {
          events.push(`error-audit:${audit.message}`);
          return Effect.void;
        },
      }),
      Layer.succeed(SyncAlphaUpload, {
        run: () => {
          events.push("alpha");
          return Effect.succeed(undefined);
        },
      }),
    );

    const outcome = await Effect.runPromise(
      runSyncProgram(input).pipe(Effect.provide(layer), Effect.result),
    );

    expect(Result.isFailure(outcome) && outcome.failure).toBe(failure);
    expect(events).toEqual([
      "progress:selftune sync --force --since 2026-01-01",
      "preferences",
      "core",
      "progress:  scanning failed source...",
      "error-audit:source failed",
    ]);
  });

  test("fails open when alpha throws after a successful audit", async () => {
    const events: string[] = [];
    const layer = Layer.mergeAll(
      progressLayer(events),
      preferencesLayer(events),
      Layer.succeed(SyncCore, { run: () => Effect.succeed(syncResult) }),
      Layer.succeed(SyncAudit, {
        recordSuccess: () => {
          events.push("success-audit");
          return Effect.void;
        },
        recordError: () => Effect.void,
      }),
      Layer.succeed(SyncAlphaUpload, {
        run: () => {
          events.push("alpha");
          return Effect.fail(
            SyncInternalFailure.make({ operation: "alpha-upload", message: "offline" }),
          );
        },
      }),
    );

    const result = await Effect.runPromise(runSyncProgram(input).pipe(Effect.provide(layer)));

    expect(events).toEqual([
      "progress:selftune sync --force --since 2026-01-01",
      "preferences",
      "success-audit",
      "alpha",
    ]);
    expect(result.alphaUpload).toBeUndefined();
    expect(result.stderr.some((line) => line.startsWith("Alpha upload:"))).toBe(false);
  });

  test("renders a returned failed alpha summary as a separate JSON event", async () => {
    const events: string[] = [];
    const layer = Layer.mergeAll(
      progressLayer(events),
      preferencesLayer(events),
      Layer.succeed(SyncCore, { run: () => Effect.succeed(syncResult) }),
      Layer.succeed(SyncAudit, {
        recordSuccess: () => Effect.void,
        recordError: () => Effect.void,
      }),
      Layer.succeed(SyncAlphaUpload, {
        run: () => Effect.succeed({ enrolled: true, prepared: 1, sent: 0, failed: 1, skipped: 0 }),
      }),
    );

    const result = await Effect.runPromise(
      runSyncProgram({ ...input, jsonOutput: true }).pipe(Effect.provide(layer)),
    );

    expect(result.stderr).toEqual([]);
    expect(JSON.parse(result.stdout[0] ?? "")).toEqual(syncResult);
    expect(JSON.parse(result.stdout[1] ?? "")).toEqual({
      code: "alpha_upload",
      enrolled: true,
      prepared: 1,
      sent: 0,
      failed: 1,
      skipped: 0,
    });
  });
});
