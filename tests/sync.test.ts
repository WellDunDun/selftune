import { describe, expect, test } from "bun:test";

import {
  type SyncOptions,
  type SyncProgressCallback,
  type SyncStepResult,
  syncSources,
} from "../cli/selftune/sync.js";

const baseOptions: SyncOptions = {
  projectsDir: "/tmp/claude-projects",
  codexHome: "/tmp/codex",
  opencodeDataDir: "/tmp/opencode",
  openclawAgentsDir: "/tmp/openclaw",
  skillLogPath: "/tmp/skill-log.jsonl",
  repairedSkillLogPath: "/tmp/repaired-skill-log.jsonl",
  repairedSessionsPath: "/tmp/repaired-sessions.json",
  dryRun: true,
  force: false,
  syncClaude: true,
  syncCodex: true,
  syncOpenCode: true,
  syncOpenClaw: true,
  rebuildSkillUsage: true,
};

function step(overrides: Partial<SyncStepResult> = {}): SyncStepResult {
  return {
    available: true,
    scanned: 0,
    synced: 0,
    skipped: 0,
    ...overrides,
  };
}

describe("syncSources", () => {
  test("aggregates enabled source-truth steps and repair summary", () => {
    const result = syncSources(baseOptions, {
      syncClaude: () => step({ scanned: 10, synced: 3, skipped: 1 }),
      syncCodex: () => step({ scanned: 4, synced: 2 }),
      syncOpenCode: () => step({ available: false }),
      syncOpenClaw: () => step({ scanned: 8, synced: 5 }),
      rebuildSkillUsage: () => ({
        repairedSessions: 7,
        repairedRecords: 12,
        codexRepairedRecords: 4,
      }),
    });

    expect(result.sources.claude).toEqual(step({ scanned: 10, synced: 3, skipped: 1 }));
    expect(result.sources.codex).toEqual(step({ scanned: 4, synced: 2 }));
    expect(result.sources.opencode).toEqual(step({ available: false }));
    expect(result.sources.openclaw).toEqual(step({ scanned: 8, synced: 5 }));
    expect(result.repair).toEqual({
      ran: true,
      repaired_sessions: 7,
      repaired_records: 12,
      codex_repaired_records: 4,
    });
  });

  test("respects disabled steps", () => {
    const result = syncSources(
      {
        ...baseOptions,
        syncCodex: false,
        syncOpenCode: false,
        rebuildSkillUsage: false,
      },
      {
        syncClaude: () => step({ scanned: 2, synced: 2 }),
        syncOpenClaw: () => step({ scanned: 1, synced: 1 }),
      },
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
  });

  test("includes per-phase timings", () => {
    const result = syncSources(baseOptions, {
      syncClaude: () => step({ scanned: 5 }),
      syncCodex: () => step({ scanned: 3 }),
      syncOpenCode: () => step({ scanned: 1 }),
      syncOpenClaw: () => step({ scanned: 2 }),
      rebuildSkillUsage: () => ({
        repairedSessions: 0,
        repairedRecords: 0,
        codexRepairedRecords: 0,
      }),
    });

    expect(result.timings).toBeArray();
    expect(result.timings.length).toBe(5);
    const phases = result.timings.map((t) => t.phase);
    expect(phases).toEqual(["claude", "codex", "opencode", "openclaw", "repair"]);
    for (const timing of result.timings) {
      expect(timing.elapsed_ms).toBeGreaterThanOrEqual(0);
    }
    expect(result.total_elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  test("timings only include enabled phases", () => {
    const result = syncSources(
      {
        ...baseOptions,
        syncCodex: false,
        syncOpenCode: false,
        syncOpenClaw: false,
        rebuildSkillUsage: false,
      },
      {
        syncClaude: () => step({ scanned: 1 }),
      },
    );

    expect(result.timings.length).toBe(1);
    expect(result.timings[0].phase).toBe("claude");
  });

  test("calls progress callback for each phase", () => {
    const messages: string[] = [];
    const onProgress: SyncProgressCallback = (msg) => messages.push(msg);

    syncSources(
      {
        ...baseOptions,
        syncCodex: false,
        syncOpenCode: false,
        syncOpenClaw: false,
        rebuildSkillUsage: false,
      },
      {
        syncClaude: () => step({ scanned: 2 }),
      },
      onProgress,
    );

    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]).toBe("starting sync...");
  });

  test("progress callback receives messages from real source steps", () => {
    // When deps are NOT provided, syncSources uses the real implementations
    // which call onProgress. We test by mocking just enough for the real
    // functions to hit the "not available" early return.
    const messages: string[] = [];
    const onProgress: SyncProgressCallback = (msg) => messages.push(msg);

    syncSources(
      {
        ...baseOptions,
        // Point at non-existent dirs so real implementations return early
        projectsDir: "/tmp/nonexistent-claude-test",
        codexHome: "/tmp/nonexistent-codex-test",
        opencodeDataDir: "/tmp/nonexistent-opencode-test",
        openclawAgentsDir: "/tmp/nonexistent-openclaw-test",
        rebuildSkillUsage: false,
      },
      {},
      onProgress,
    );

    // Should have at least "starting sync..." and scan attempts
    expect(messages[0]).toBe("starting sync...");
  });
});
