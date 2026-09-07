import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import type { Database } from "bun:sqlite";
import * as Effect from "effect/Effect";

import { openDb } from "@selftune/local-store";
import {
  createHarnessSourceRegistry,
  type HarnessSourceAdapter,
} from "@selftune/harness-core/source-adapter";

import {
  type SyncOptions,
  type SyncProgressCallback,
  type SyncStepResult,
  syncSources,
} from "@selftune/orchestration/sync";

const baseOptions: SyncOptions = {
  projectsDir: "/tmp/claude-projects",
  codexHome: "/tmp/codex",
  opencodeDataDir: "/tmp/opencode",
  openclawAgentsDir: "/tmp/openclaw",
  piSessionsDir: "/tmp/pi",
  skillLogPath: "/tmp/skill-log.jsonl",
  repairedSkillLogPath: "/tmp/repaired-skill-log.jsonl",
  repairedSessionsPath: "/tmp/repaired-sessions.json",
  dryRun: true,
  force: false,
  syncClaude: true,
  syncCodex: true,
  syncOpenCode: true,
  syncOpenClaw: true,
  syncPi: true,
  rebuildSkillUsage: true,
};

let database: Database;

beforeEach(() => {
  database = openDb(":memory:");
});

afterEach(() => {
  database.close();
});

function step(overrides: Partial<SyncStepResult> = {}): SyncStepResult {
  return {
    available: true,
    scanned: 0,
    synced: 0,
    skipped: 0,
    ...overrides,
  };
}

function sourceAdapter(
  id: string,
  phase: string,
  result: SyncStepResult = step(),
  onSync?: () => void,
): HarnessSourceAdapter {
  return {
    id,
    phase,
    sync: () => {
      onSync?.();
      return Effect.succeed(result);
    },
  };
}

function disabledAdapterCalled(): never {
  throw new Error("disabled adapters must not run");
}

function contributionStage(
  overrides: Partial<{
    eligible_skills: number;
    built_signals: number;
    staged_signals: number;
  }> = {},
) {
  return {
    eligible_skills: 0,
    built_signals: 0,
    staged_signals: 0,
    ...overrides,
  };
}

describe("syncSources", () => {
  test("aggregates enabled source-truth steps and repair summary", async () => {
    const syncedInOrder: string[] = [];
    const result = await Effect.runPromise(
      syncSources(
        baseOptions,
        {
          sourceRegistry: createHarnessSourceRegistry([
            sourceAdapter(
              "claude_code",
              "claude",
              step({ scanned: 10, synced: 3, skipped: 1 }),
              () => syncedInOrder.push("claude_code"),
            ),
            sourceAdapter("codex", "codex", step({ scanned: 4, synced: 2 }), () =>
              syncedInOrder.push("codex"),
            ),
            sourceAdapter("opencode", "opencode", step({ available: false }), () =>
              syncedInOrder.push("opencode"),
            ),
            sourceAdapter("openclaw", "openclaw", step({ scanned: 8, synced: 5 }), () =>
              syncedInOrder.push("openclaw"),
            ),
            sourceAdapter("pi", "pi", step(), () => syncedInOrder.push("pi")),
          ]),
          rebuildSkillUsage: () => ({
            repairedSessions: 7,
            repairedRecords: 12,
            codexRepairedRecords: 4,
          }),
          stageCreatorContributions: () => contributionStage(),
        },
        undefined,
        database,
      ),
    );

    expect(result.sources.claude).toEqual(step({ scanned: 10, synced: 3, skipped: 1 }));
    expect(result.sources.codex).toEqual(step({ scanned: 4, synced: 2 }));
    expect(result.sources.opencode).toEqual(step({ available: false }));
    expect(result.sources.openclaw).toEqual(step({ scanned: 8, synced: 5 }));
    expect(syncedInOrder).toEqual(["claude_code", "codex", "opencode", "openclaw", "pi"]);
    expect(result.repair).toEqual({
      ran: true,
      repaired_sessions: 7,
      repaired_records: 12,
      codex_repaired_records: 4,
    });
    expect(result.creator_contributions).toEqual({
      ran: true,
      eligible_skills: 0,
      built_signals: 0,
      staged_signals: 0,
    });
  });

  test("respects disabled steps", async () => {
    const result = await Effect.runPromise(
      syncSources(
        {
          ...baseOptions,
          syncCodex: false,
          syncOpenCode: false,
          rebuildSkillUsage: false,
        },
        {
          sourceRegistry: createHarnessSourceRegistry([
            sourceAdapter("claude_code", "claude", step({ scanned: 2, synced: 2 })),
            sourceAdapter("codex", "codex", step(), disabledAdapterCalled),
            sourceAdapter("opencode", "opencode", step(), disabledAdapterCalled),
            sourceAdapter("openclaw", "openclaw", step({ scanned: 1, synced: 1 })),
            sourceAdapter("pi", "pi", step()),
          ]),
          stageCreatorContributions: () => contributionStage(),
        },
        undefined,
        database,
      ),
    );

    expect(result.sources.claude).toEqual(step({ scanned: 2, synced: 2 }));
    expect(result.sources.codex).toEqual({
      available: false,
      scanned: 0,
      synced: 0,
      skipped: 0,
    });
    expect(result.sources.opencode).toEqual({
      available: false,
      scanned: 0,
      synced: 0,
      skipped: 0,
    });
    expect(result.sources.openclaw).toEqual(step({ scanned: 1, synced: 1 }));
    expect(result.repair).toEqual({
      ran: false,
      repaired_sessions: 0,
      repaired_records: 0,
      codex_repaired_records: 0,
    });
    expect(result.creator_contributions).toEqual({
      ran: true,
      eligible_skills: 0,
      built_signals: 0,
      staged_signals: 0,
    });
  });

  test("fails through the typed adapter channel when a configured source is missing", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        syncSources(
          {
            ...baseOptions,
            syncCodex: false,
            syncOpenCode: false,
            syncOpenClaw: false,
            syncPi: false,
            rebuildSkillUsage: false,
          },
          {
            sourceRegistry: createHarnessSourceRegistry([]),
            stageCreatorContributions: () => contributionStage(),
          },
          undefined,
          database,
        ),
      ),
    );

    assert.equal(failure._tag, "HarnessSourceSyncFailure");
    expect(failure.adapter_id).toBe("claude_code");
    expect(failure.operation).toBe("resolve source adapter");
  });

  test("fails through the typed orchestration channel when a post-ingest phase throws", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        syncSources(
          {
            ...baseOptions,
            syncClaude: false,
            syncCodex: false,
            syncOpenCode: false,
            syncOpenClaw: false,
            syncPi: false,
          },
          {
            sourceRegistry: createHarnessSourceRegistry([]),
            rebuildSkillUsage: () => {
              throw new Error("repair unavailable");
            },
          },
          undefined,
          database,
        ),
      ),
    );

    expect(failure).toMatchObject({
      _tag: "SyncInternalFailure",
      operation: "rebuild skill usage",
      message: "repair unavailable",
    });
  });

  test("includes per-phase timings", async () => {
    const result = await Effect.runPromise(
      syncSources(
        baseOptions,
        {
          sourceRegistry: createHarnessSourceRegistry([
            sourceAdapter("claude_code", "claude", step({ scanned: 5 })),
            sourceAdapter("codex", "codex", step({ scanned: 3 })),
            sourceAdapter("opencode", "opencode", step({ scanned: 1 })),
            sourceAdapter("openclaw", "openclaw", step({ scanned: 2 })),
            sourceAdapter("pi", "pi", step({ scanned: 4 })),
          ]),
          rebuildSkillUsage: () => ({
            repairedSessions: 0,
            repairedRecords: 0,
            codexRepairedRecords: 0,
          }),
          stageCreatorContributions: () => contributionStage(),
        },
        undefined,
        database,
      ),
    );

    expect(result.timings).toBeArray();
    expect(result.timings.length).toBe(7);
    const phases = result.timings.map((t) => t.phase);
    expect(phases).toEqual([
      "claude",
      "codex",
      "opencode",
      "openclaw",
      "pi",
      "repair",
      "creator_contributions",
    ]);
    for (const timing of result.timings) {
      expect(timing.elapsed_ms).toBeGreaterThanOrEqual(0);
    }
    expect(result.total_elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  test("timings only include enabled phases", async () => {
    const result = await Effect.runPromise(
      syncSources(
        {
          ...baseOptions,
          syncCodex: false,
          syncOpenCode: false,
          syncOpenClaw: false,
          syncPi: false,
          rebuildSkillUsage: false,
        },
        {
          sourceRegistry: createHarnessSourceRegistry([
            sourceAdapter("claude_code", "claude", step({ scanned: 1 })),
          ]),
          stageCreatorContributions: () => contributionStage(),
        },
        undefined,
        database,
      ),
    );

    expect(result.timings.length).toBe(2);
    expect(result.timings[0].phase).toBe("claude");
    expect(result.timings[1].phase).toBe("creator_contributions");
  });

  test("emits a start event when adapters have no progress messages", async () => {
    const messages: string[] = [];
    const onProgress: SyncProgressCallback = (msg) => messages.push(msg);

    await Effect.runPromise(
      syncSources(
        {
          ...baseOptions,
          syncCodex: false,
          syncOpenCode: false,
          syncOpenClaw: false,
          rebuildSkillUsage: false,
        },
        {
          sourceRegistry: createHarnessSourceRegistry([
            sourceAdapter("claude_code", "claude", step({ scanned: 2 })),
            sourceAdapter("pi", "pi", step()),
          ]),
          stageCreatorContributions: () => contributionStage(),
        },
        onProgress,
        database,
      ),
    );

    expect(messages).toEqual(["starting sync..."]);
  });

  test("forwards source-adapter progress messages", async () => {
    // The registry keeps source adapters injectible while preserving their
    // progress callback boundary.
    const messages: string[] = [];
    const onProgress: SyncProgressCallback = (msg) => messages.push(msg);

    await Effect.runPromise(
      syncSources(
        {
          ...baseOptions,
          projectsDir: "/tmp/nonexistent-claude-test",
          codexHome: "/tmp/nonexistent-codex-test",
          opencodeDataDir: "/tmp/nonexistent-opencode-test",
          openclawAgentsDir: "/tmp/nonexistent-openclaw-test",
          rebuildSkillUsage: false,
        },
        {
          sourceRegistry: createHarnessSourceRegistry([
            {
              ...sourceAdapter("claude_code", "claude", step({ available: false })),
              sync: (_request, onSourceProgress) => {
                onSourceProgress?.("scanning Claude transcripts...");
                return Effect.succeed(step({ available: false }));
              },
            },
            sourceAdapter("codex", "codex", step({ available: false })),
            sourceAdapter("opencode", "opencode", step({ available: false })),
            sourceAdapter("openclaw", "openclaw", step({ available: false })),
            sourceAdapter("pi", "pi", step({ available: false })),
          ]),
          stageCreatorContributions: () => contributionStage(),
        },
        onProgress,
        database,
      ),
    );

    expect(messages).toEqual(["starting sync...", "scanning Claude transcripts..."]);
  });
});
