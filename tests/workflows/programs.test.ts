import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import * as Effect from "effect/Effect";

import { openDb } from "../../packages/runtime/localdb/db.js";
import {
  _setTestDb,
  getDb,
  LocalDatabaseError,
  LocalDatabaseService,
  makeLocalDatabaseLive,
} from "../../packages/local-store/src/db.js";
import {
  writeSessionTelemetryToDb,
  writeSkillCheckToDb,
} from "../../packages/runtime/localdb/direct-write.js";
import type { DiscoveredWorkflow, WorkflowDiscoveryReport } from "../../packages/runtime/types.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";
import {
  formatWorkflowResult,
  resolveWorkflowSelection,
  runWorkflowProgramWithDatabase,
  type WorkflowProgramInput,
} from "../../packages/runtime/workflows/programs.js";

const databases: Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDatabase(): Database {
  const database = openDb(":memory:");
  databases.push(database);
  return database;
}

function addWorkflowSession(database: Database): void {
  const sessionId = "workflow-program-session";
  writeSessionTelemetryToDb(
    {
      timestamp: "2026-07-16T12:00:00Z",
      session_id: sessionId,
      cwd: "/tmp/workflow-program",
      transcript_path: "/tmp/workflow-program/transcript.jsonl",
      tool_calls: {},
      total_tool_calls: 0,
      bash_commands: [],
      skills_triggered: ["Research", "Writing"],
      skills_invoked: ["Research", "Writing"],
      assistant_turns: 2,
      errors_encountered: 0,
      transcript_chars: 200,
      last_user_query: "research and write a brief",
      source: "test",
    },
    database,
  );
  writeSkillCheckToDb(
    {
      skill_invocation_id: `${sessionId}-research`,
      occurred_at: "2026-07-16T12:00:01Z",
      session_id: sessionId,
      skill_name: "Research",
      invocation_mode: "implicit",
      skill_path: "/tmp/skills/research/SKILL.md",
      confidence: 0.9,
      skill_scope: "global",
      query: "research and write a brief",
      triggered: true,
      platform: "codex",
      agent_type: "codex",
      source: "test",
    },
    database,
  );
  writeSkillCheckToDb(
    {
      skill_invocation_id: `${sessionId}-writing`,
      occurred_at: "2026-07-16T12:00:02Z",
      session_id: sessionId,
      skill_name: "Writing",
      invocation_mode: "implicit",
      skill_path: "/tmp/skills/writing/SKILL.md",
      confidence: 0.9,
      skill_scope: "global",
      query: "research and write a brief",
      triggered: true,
      platform: "codex",
      agent_type: "codex",
      source: "test",
    },
    database,
  );
}

function makeWorkflow(): DiscoveredWorkflow {
  return {
    workflow_id: "Research→Writing",
    skills: ["Research", "Writing"],
    occurrence_count: 3,
    avg_errors: 0,
    avg_errors_individual: 0,
    synergy_score: 0,
    representative_query: "research and write a brief",
    sequence_consistency: 1,
    completion_rate: 1,
    first_seen: "2026-07-16T12:00:00Z",
    last_seen: "2026-07-16T12:00:00Z",
    session_ids: ["workflow-program-session"],
  };
}

describe("workflow Effect program", () => {
  it("discovers from an injected SQLite service and formats at the boundary", async () => {
    const database = createDatabase();
    addWorkflowSession(database);

    const result = await Effect.runPromise(
      runWorkflowProgramWithDatabase({ operation: "discover", minOccurrences: 1 }, database),
    );

    assert(result.operation === "discover");
    expect(result.value.workflows).toHaveLength(1);
    expect(formatWorkflowResult(result, false)).toContain("Research → Writing");
    expect(JSON.parse(formatWorkflowResult(result, true)).workflows).toHaveLength(1);
    expect(database.query("SELECT 1 AS value").get()).toEqual({ value: 1 });
  });

  it("preserves parseInt-style one-based selection", () => {
    const report: WorkflowDiscoveryReport = {
      workflows: [makeWorkflow()],
      total_sessions_analyzed: 1,
      generated_at: "2026-07-16T12:00:00Z",
    };

    expect(resolveWorkflowSelection(report, "1trailing").workflow_id).toBe("Research→Writing");
  });

  it("saves once and reports an unchanged duplicate", async () => {
    const database = createDatabase();
    addWorkflowSession(database);
    const directory = mkdtempSync(join(tmpdir(), "selftune-workflow-program-"));
    temporaryDirectories.push(directory);
    const skillPath = join(directory, "SKILL.md");
    writeFileSync(skillPath, "# Research\n", "utf-8");
    const input: WorkflowProgramInput = {
      operation: "save",
      selection: "1",
      skillPath,
      minOccurrences: 1,
    };

    const saved = await Effect.runPromise(runWorkflowProgramWithDatabase(input, database));
    const unchanged = await Effect.runPromise(runWorkflowProgramWithDatabase(input, database));

    assert(saved.operation === "save");
    assert(unchanged.operation === "save");
    expect(saved.value.status).toBe("saved");
    expect(unchanged.value.status).toBe("unchanged");
    expect(readFileSync(skillPath, "utf-8")).toContain("## Workflows");
    expect(formatWorkflowResult(saved, true)).toContain("Saved workflow");
  });

  it("keeps scaffold preview, persistence, and collision handling explicit", async () => {
    const database = createDatabase();
    addWorkflowSession(database);
    const outputDir = mkdtempSync(join(tmpdir(), "selftune-workflow-scaffold-program-"));
    temporaryDirectories.push(outputDir);

    const result = await Effect.runPromise(
      runWorkflowProgramWithDatabase(
        {
          operation: "scaffold",
          selection: "1",
          outputDir,
          minOccurrences: 1,
          write: false,
          force: false,
        },
        database,
      ),
    );

    assert(result.operation === "scaffold");
    expect(result.value.written).toBe(false);
    expect(formatWorkflowResult(result, false)).toContain("Draft workflow skill:");
    expect(JSON.parse(formatWorkflowResult(result, true)).written).toBe(false);

    const written = await Effect.runPromise(
      runWorkflowProgramWithDatabase(
        {
          operation: "scaffold",
          selection: "1",
          outputDir,
          minOccurrences: 1,
          write: true,
          force: false,
        },
        database,
      ),
    );
    assert(written.operation === "scaffold");
    expect(written.value.written).toBe(true);
    expect(formatWorkflowResult(written, false)).toContain("Scaffolded skill package");

    await expect(
      Effect.runPromise(
        runWorkflowProgramWithDatabase(
          {
            operation: "scaffold",
            selection: "1",
            outputDir,
            minOccurrences: 1,
            write: true,
            force: false,
          },
          database,
        ),
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: "FILE_EXISTS" } satisfies Pick<CLIError, "code">),
    );
  });

  it("returns invalid numeric filters in the typed error channel", async () => {
    const database = createDatabase();

    await expect(
      Effect.runPromise(
        runWorkflowProgramWithDatabase({ operation: "discover", minOccurrences: -1 }, database),
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_FLAG" } satisfies Pick<CLIError, "code">),
    );
  });

  it("keeps live database acquisition typed and owns only its connection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "selftune-workflow-live-database-"));
    temporaryDirectories.push(directory);
    const notDirectory = join(directory, "not-a-directory");
    writeFileSync(notDirectory, "file", "utf-8");

    const acquisitionError = await Effect.runPromise(
      LocalDatabaseService.pipe(
        Effect.provide(makeLocalDatabaseLive(join(notDirectory, "selftune.db"))),
        Effect.flip,
      ),
    );
    expect(acquisitionError).toBeInstanceOf(LocalDatabaseError);

    const singleton = openDb(":memory:");
    _setTestDb(singleton);
    try {
      await Effect.runPromise(
        LocalDatabaseService.pipe(Effect.provide(makeLocalDatabaseLive(":memory:"))),
      );
      expect(getDb()).toBe(singleton);
      expect(singleton.query("SELECT 1 AS value").get()).toEqual({ value: 1 });
    } finally {
      _setTestDb(null);
    }
  });

  it("keeps process and runtime concerns out of the production program", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../packages/runtime/workflows/programs.ts"),
      "utf-8",
    );

    expect(source).not.toContain("Effect.run");
    expect(source).not.toContain("ManagedRuntime");
    expect(source).not.toContain("process.");
    expect(source).not.toContain("console.");
    expect(source).not.toContain("parseArgs");
    expect(source).not.toContain("LocalDatabaseLive");
  });
});
