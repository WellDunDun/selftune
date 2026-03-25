/**
 * Tests for V2 canonical push payload builder (staging-based).
 *
 * Validates that buildV2PushPayload correctly reads from the
 * canonical_upload_staging table using a single monotonic cursor
 * and assembles records into a V2 push payload.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildV2PushPayload } from "../../cli/selftune/alpha-upload/build-payloads.js";
import { ALL_DDL, MIGRATIONS, POST_MIGRATION_INDEXES } from "../../cli/selftune/localdb/schema.js";

// -- Test helpers -------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:");
  for (const ddl of ALL_DDL) db.run(ddl);
  for (const m of MIGRATIONS) {
    try {
      db.run(m);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("duplicate column")) {
        throw error;
      }
    }
  }
  for (const idx of POST_MIGRATION_INDEXES) {
    db.run(idx);
  }
  return db;
}

function stageRecord(
  db: Database,
  opts: {
    record_kind: string;
    record_id: string;
    record_json: unknown;
    session_id?: string;
    prompt_id?: string;
    normalized_at?: string;
  },
): void {
  db.run(
    `INSERT OR IGNORE INTO canonical_upload_staging
      (record_kind, record_id, record_json, session_id, prompt_id, normalized_at, staged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.record_kind,
      opts.record_id,
      typeof opts.record_json === "string" ? opts.record_json : JSON.stringify(opts.record_json),
      opts.session_id ?? null,
      opts.prompt_id ?? null,
      opts.normalized_at ?? new Date().toISOString(),
      new Date().toISOString(),
    ],
  );
}

function makeSessionJson(sessionId: string) {
  return {
    record_kind: "session",
    schema_version: "2.0",
    normalizer_version: "1.0.0",
    normalized_at: "2026-03-18T10:00:00.000Z",
    platform: "claude_code",
    capture_mode: "replay",
    source_session_kind: "interactive",
    raw_source_ref: { path: "/some/transcript.jsonl" },
    session_id: sessionId,
    started_at: "2026-03-18T09:00:00.000Z",
    ended_at: "2026-03-18T09:30:00.000Z",
    model: "opus",
    completion_status: "completed",
  };
}

function makePromptJson(promptId: string, sessionId: string) {
  return {
    record_kind: "prompt",
    schema_version: "2.0",
    normalizer_version: "1.0.0",
    normalized_at: "2026-03-18T10:00:00.000Z",
    platform: "claude_code",
    capture_mode: "replay",
    source_session_kind: "interactive",
    raw_source_ref: {},
    session_id: sessionId,
    prompt_id: promptId,
    occurred_at: "2026-03-18T09:01:00.000Z",
    prompt_text: "improve my skills",
    prompt_kind: "user",
    is_actionable: true,
    prompt_index: 0,
  };
}

function makeInvocationJson(invId: string, sessionId: string) {
  return {
    record_kind: "skill_invocation",
    schema_version: "2.0",
    normalizer_version: "1.0.0",
    normalized_at: "2026-03-18T10:00:00.000Z",
    platform: "claude_code",
    capture_mode: "replay",
    source_session_kind: "interactive",
    raw_source_ref: {},
    session_id: sessionId,
    skill_invocation_id: invId,
    occurred_at: "2026-03-18T09:02:00.000Z",
    skill_name: "selftune",
    invocation_mode: "implicit",
    triggered: true,
    confidence: 0.95,
  };
}

function makeExecutionFactJson(sessionId: string) {
  return {
    record_kind: "execution_fact",
    schema_version: "2.0",
    normalizer_version: "1.0.0",
    normalized_at: "2026-03-18T10:00:00.000Z",
    platform: "claude_code",
    capture_mode: "replay",
    source_session_kind: "interactive",
    raw_source_ref: {},
    session_id: sessionId,
    execution_fact_id: `ef-${sessionId}`,
    occurred_at: "2026-03-18T09:03:00.000Z",
    tool_calls_json: { Read: 3, Edit: 2 },
    total_tool_calls: 5,
    assistant_turns: 3,
    errors_encountered: 0,
  };
}

function makeEvolutionEvidenceJson(proposalId: string) {
  return {
    timestamp: "2026-03-18T10:10:00.000Z",
    skill_name: "selftune",
    proposal_id: proposalId,
    target: "description",
    stage: "deployed",
    rationale: "improved routing accuracy",
    confidence: 0.85,
    original_text: "old description",
    proposed_text: "new description",
  };
}

// -- Tests --------------------------------------------------------------------

describe("buildV2PushPayload (staging-based)", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  test("returns null when staging table is empty", () => {
    const result = buildV2PushPayload(db);
    expect(result).toBeNull();
  });

  test("returns null when all records are past cursor", () => {
    stageRecord(db, {
      record_kind: "session",
      record_id: "sess-1",
      record_json: makeSessionJson("sess-1"),
      session_id: "sess-1",
    });
    const result = buildV2PushPayload(db, 999999);
    expect(result).toBeNull();
  });

  test("builds V2 payload with correct schema_version", () => {
    stageRecord(db, {
      record_kind: "session",
      record_id: "sess-1",
      record_json: makeSessionJson("sess-1"),
      session_id: "sess-1",
    });

    const result = buildV2PushPayload(db);
    expect(result).not.toBeNull();

    const payload = result?.payload;
    expect(payload.schema_version).toBe("2.0");
    expect(payload.push_id).toBeDefined();
    expect(typeof payload.push_id).toBe("string");
  });

  test("includes sessions in canonical.sessions", () => {
    stageRecord(db, {
      record_kind: "session",
      record_id: "sess-map",
      record_json: makeSessionJson("sess-map"),
      session_id: "sess-map",
    });

    const result = buildV2PushPayload(db);
    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    const sessions = canonical.sessions;

    expect(sessions).toHaveLength(1);
    const s = sessions[0] as Record<string, unknown>;
    expect(s.record_kind).toBe("session");
    expect(s.schema_version).toBe("2.0");
    expect(s.session_id).toBe("sess-map");
    expect(s.platform).toBe("claude_code");
    expect(s.model).toBe("opus");
    expect(s.started_at).toBe("2026-03-18T09:00:00.000Z");
    expect(s.ended_at).toBe("2026-03-18T09:30:00.000Z");
  });

  test("includes prompts in canonical.prompts", () => {
    stageRecord(db, {
      record_kind: "prompt",
      record_id: "p-1",
      record_json: makePromptJson("p-1", "sess-1"),
      session_id: "sess-1",
      prompt_id: "p-1",
    });

    const result = buildV2PushPayload(db);
    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    const prompts = canonical.prompts;

    expect(prompts).toHaveLength(1);
    const p = prompts[0] as Record<string, unknown>;
    expect(p.record_kind).toBe("prompt");
    expect(p.prompt_id).toBe("p-1");
    expect(p.prompt_text).toBe("improve my skills");
  });

  test("includes skill_invocations in canonical.skill_invocations", () => {
    stageRecord(db, {
      record_kind: "skill_invocation",
      record_id: "inv-1",
      record_json: makeInvocationJson("inv-1", "sess-1"),
      session_id: "sess-1",
    });

    const result = buildV2PushPayload(db);
    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    const invocations = canonical.skill_invocations;

    expect(invocations).toHaveLength(1);
    const inv = invocations[0] as Record<string, unknown>;
    expect(inv.record_kind).toBe("skill_invocation");
    expect(inv.skill_name).toBe("selftune");
    expect(inv.triggered).toBe(true);
    expect(inv.confidence).toBe(0.95);
  });

  test("includes execution_facts in canonical.execution_facts", () => {
    stageRecord(db, {
      record_kind: "execution_fact",
      record_id: "ef-1",
      record_json: makeExecutionFactJson("sess-1"),
      session_id: "sess-1",
    });

    const result = buildV2PushPayload(db);
    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    const facts = canonical.execution_facts;

    expect(facts).toHaveLength(1);
    const f = facts[0] as Record<string, unknown>;
    expect(f.record_kind).toBe("execution_fact");
    expect(f.total_tool_calls).toBe(5);
    expect(f.assistant_turns).toBe(3);
    expect(f.errors_encountered).toBe(0);
  });

  test("includes evolution_evidence in canonical.evolution_evidence", () => {
    stageRecord(db, {
      record_kind: "evolution_evidence",
      record_id: "prop-1:deployed:2026-03-18T10:10:00Z",
      record_json: makeEvolutionEvidenceJson("prop-1"),
    });

    const result = buildV2PushPayload(db);
    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    const evidence = canonical.evolution_evidence;

    expect(evidence).toHaveLength(1);
    const e = evidence[0] as Record<string, unknown>;
    expect(e.skill_name).toBe("selftune");
    expect(e.proposal_id).toBe("prop-1");
    expect(e.original_text).toBe("old description");
    expect(e.proposed_text).toBe("new description");
  });

  test("returns correct lastSeq for cursor advancement", () => {
    stageRecord(db, {
      record_kind: "session",
      record_id: "sess-1",
      record_json: makeSessionJson("sess-1"),
      session_id: "sess-1",
    });
    stageRecord(db, {
      record_kind: "session",
      record_id: "sess-2",
      record_json: makeSessionJson("sess-2"),
      session_id: "sess-2",
    });

    const first = buildV2PushPayload(db);
    expect(first).not.toBeNull();
    expect(first?.lastSeq).toBeGreaterThan(0);

    // Second call with cursor from first should get nothing
    const second = buildV2PushPayload(db, first?.lastSeq);
    expect(second).toBeNull();
  });

  test("handles mixed data -- some record types present, others not", () => {
    stageRecord(db, {
      record_kind: "session",
      record_id: "sess-1",
      record_json: makeSessionJson("sess-1"),
      session_id: "sess-1",
    });
    stageRecord(db, {
      record_kind: "skill_invocation",
      record_id: "inv-1",
      record_json: makeInvocationJson("inv-1", "sess-1"),
      session_id: "sess-1",
    });
    // No prompts, execution_facts, or evolution_evidence

    const result = buildV2PushPayload(db);
    expect(result).not.toBeNull();

    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    expect(canonical.sessions).toHaveLength(1);
    expect(canonical.skill_invocations).toHaveLength(1);
    expect(canonical.prompts).toHaveLength(0);
    expect(canonical.execution_facts).toHaveLength(0);
  });

  test("canonical records have preserved base fields (no hardcoding)", () => {
    const sessionJson = makeSessionJson("sess-fields");
    // Override with non-default values to prove they aren't hardcoded
    sessionJson.capture_mode = "hook";
    sessionJson.normalizer_version = "3.5.0";
    sessionJson.raw_source_ref = { path: "/custom.jsonl", raw_id: "xyz" };

    stageRecord(db, {
      record_kind: "session",
      record_id: "sess-fields",
      record_json: sessionJson,
      session_id: "sess-fields",
    });

    const result = buildV2PushPayload(db);
    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    const session = canonical.sessions[0] as Record<string, unknown>;

    expect(session.record_kind).toBe("session");
    expect(session.schema_version).toBe("2.0");
    expect(session.capture_mode).toBe("hook");
    expect(session.normalizer_version).toBe("3.5.0");
    expect(session.raw_source_ref).toEqual({ path: "/custom.jsonl", raw_id: "xyz" });
  });

  test("includes orchestrate_runs in canonical.orchestrate_runs", () => {
    const orchestrateRunJson = {
      run_id: "orch-bp-1",
      timestamp: "2026-03-18T11:00:00.000Z",
      elapsed_ms: 12000,
      dry_run: false,
      approval_mode: "auto",
      total_skills: 5,
      evaluated: 4,
      evolved: 1,
      deployed: 1,
      watched: 2,
      skipped: 1,
      skill_actions: [
        { skill: "selftune", action: "evolve", reason: "low pass rate", deployed: true },
        { skill: "commit", action: "watch", reason: "recently deployed" },
        { skill: "test-runner", action: "skip", reason: "insufficient data" },
      ],
    };

    stageRecord(db, {
      record_kind: "orchestrate_run",
      record_id: "orch-bp-1",
      record_json: orchestrateRunJson,
    });

    const result = buildV2PushPayload(db);
    expect(result).not.toBeNull();

    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    expect(canonical.orchestrate_runs).toBeDefined();
    expect(canonical.orchestrate_runs).toHaveLength(1);

    const run = canonical.orchestrate_runs[0] as Record<string, unknown>;
    expect(run.run_id).toBe("orch-bp-1");
    expect(run.dry_run).toBe(false);
    expect(run.approval_mode).toBe("auto");
    expect(run.total_skills).toBe(5);
    expect(run.elapsed_ms).toBe(12000);
    const actions = run.skill_actions as unknown[];
    expect(actions).toHaveLength(3);
  });

  test("returns payload with only orchestrate_runs (no canonical records)", () => {
    stageRecord(db, {
      record_kind: "orchestrate_run",
      record_id: "orch-only-1",
      record_json: {
        run_id: "orch-only-1",
        timestamp: "2026-03-18T11:00:00.000Z",
        elapsed_ms: 1000,
        dry_run: true,
        approval_mode: "review",
        total_skills: 1,
        evaluated: 1,
        evolved: 0,
        deployed: 0,
        watched: 0,
        skipped: 1,
        skill_actions: [{ skill: "test", action: "skip", reason: "dry run" }],
      },
    });

    const result = buildV2PushPayload(db);
    expect(result).not.toBeNull();

    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    expect(canonical.sessions).toHaveLength(0);
    expect(canonical.orchestrate_runs).toHaveLength(1);
  });

  test("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      stageRecord(db, {
        record_kind: "session",
        record_id: `sess-limit-${i}`,
        record_json: makeSessionJson(`sess-limit-${i}`),
        session_id: `sess-limit-${i}`,
      });
    }

    const result = buildV2PushPayload(db, undefined, 3);
    expect(result).not.toBeNull();

    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    expect(canonical.sessions).toHaveLength(3);
  });

  test("returns null when all staged rows have malformed record_json", () => {
    stageRecord(db, {
      record_kind: "session",
      record_id: "bad-json-1",
      record_json: "{not valid json",
      session_id: "bad-json-1",
    });

    const result = buildV2PushPayload(db);
    expect(result).toBeNull();
  });

  test("returns null when a malformed staged row blocks the front of the batch", () => {
    stageRecord(db, {
      record_kind: "session",
      record_id: "bad-json-2",
      record_json: "{not valid json",
      session_id: "bad-json-2",
    });
    stageRecord(db, {
      record_kind: "session",
      record_id: "sess-valid-1",
      record_json: makeSessionJson("sess-valid-1"),
      session_id: "sess-valid-1",
    });

    const result = buildV2PushPayload(db);
    expect(result).toBeNull();
  });

  test("does not advance the cursor past malformed staged rows", () => {
    stageRecord(db, {
      record_kind: "session",
      record_id: "sess-valid-before-bad",
      record_json: makeSessionJson("sess-valid-before-bad"),
      session_id: "sess-valid-before-bad",
    });
    stageRecord(db, {
      record_kind: "session",
      record_id: "bad-json-3",
      record_json: "{not valid json",
      session_id: "bad-json-3",
    });
    stageRecord(db, {
      record_kind: "session",
      record_id: "sess-valid-after-bad",
      record_json: makeSessionJson("sess-valid-after-bad"),
      session_id: "sess-valid-after-bad",
    });

    const result = buildV2PushPayload(db);
    expect(result).not.toBeNull();

    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    expect(canonical.sessions).toHaveLength(1);
    const session = canonical.sessions[0] as Record<string, unknown>;
    expect(session.session_id).toBe("sess-valid-before-bad");

    const second = buildV2PushPayload(db, result?.lastSeq);
    expect(second).toBeNull();
  });
});
