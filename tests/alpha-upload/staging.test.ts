/**
 * Tests for the canonical upload staging pipeline.
 *
 * Covers:
 *  - stageCanonicalRecords() inserting from JSONL
 *  - Dedup behavior (staging same records twice)
 *  - buildV2PushPayload() reading from staging with cursor
 *  - Evolution evidence staged alongside canonical records
 *  - Output passing PushPayloadV2Schema validation
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildV2PushPayload } from "../../cli/selftune/alpha-upload/build-payloads.js";
import {
  generateEvidenceId,
  stageCanonicalRecords,
} from "../../cli/selftune/alpha-upload/stage-canonical.js";
import { ALL_DDL, MIGRATIONS, POST_MIGRATION_INDEXES } from "../../cli/selftune/localdb/schema.js";

// -- Test helpers -------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:");
  for (const ddl of ALL_DDL) db.run(ddl);
  for (const m of MIGRATIONS) {
    try {
      db.run(m);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("duplicate column")) throw e;
    }
  }
  for (const idx of POST_MIGRATION_INDEXES) {
    db.run(idx);
  }
  return db;
}

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "staging-test-"));
}

function makeCanonicalSessionRecord(sessionId: string, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function makeCanonicalPromptRecord(
  promptId: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
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
    ...overrides,
  };
}

function makeCanonicalInvocationRecord(
  invId: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
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
    ...overrides,
  };
}

function makeCanonicalExecutionFactRecord(
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
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
    execution_fact_id:
      overrides.execution_fact_id ?? `${sessionId}:2026-03-18T09:03:00.000Z:no-prompt`,
    occurred_at: "2026-03-18T09:03:00.000Z",
    tool_calls_json: { Read: 3, Edit: 2 },
    total_tool_calls: 5,
    assistant_turns: 3,
    errors_encountered: 0,
    ...overrides,
  };
}

function writeCanonicalJsonl(dir: string, records: unknown[]): string {
  const logPath = join(dir, "canonical_telemetry_log.jsonl");
  const content =
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
  writeFileSync(logPath, content, "utf-8");
  return logPath;
}

function insertEvolutionEvidence(
  db: Database,
  overrides: Partial<{
    timestamp: string;
    proposal_id: string;
    skill_name: string;
    skill_path: string;
    target: string;
    stage: string;
    rationale: string;
    confidence: number;
    details: string;
    original_text: string;
    proposed_text: string;
  }> = {},
): void {
  const e = {
    timestamp: overrides.timestamp ?? "2026-03-18T10:10:00Z",
    proposal_id: overrides.proposal_id ?? `prop-${Math.random().toString(36).slice(2)}`,
    skill_name: overrides.skill_name ?? "selftune",
    skill_path: overrides.skill_path ?? "/path/to/SKILL.md",
    target: overrides.target ?? "description",
    stage: overrides.stage ?? "deployed",
    rationale: overrides.rationale ?? "improved routing accuracy",
    confidence: overrides.confidence ?? 0.85,
    details: overrides.details ?? "pass rate improved",
    original_text: overrides.original_text ?? "old description",
    proposed_text: overrides.proposed_text ?? "new description",
  };
  db.run(
    `INSERT INTO evolution_evidence (timestamp, proposal_id, skill_name, skill_path, target, stage, rationale, confidence, details, original_text, proposed_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.timestamp,
      e.proposal_id,
      e.skill_name,
      e.skill_path,
      e.target,
      e.stage,
      e.rationale,
      e.confidence,
      e.details,
      e.original_text,
      e.proposed_text,
    ],
  );
}

// -- Tests --------------------------------------------------------------------

describe("stageCanonicalRecords", () => {
  let db: Database;
  let tempDir: string;

  beforeEach(() => {
    db = createTestDb();
    tempDir = createTempDir();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("stages canonical records from JSONL into staging table", () => {
    const logPath = writeCanonicalJsonl(tempDir, [
      makeCanonicalSessionRecord("sess-1"),
      makeCanonicalPromptRecord("p-1", "sess-1"),
      makeCanonicalInvocationRecord("inv-1", "sess-1"),
      makeCanonicalExecutionFactRecord("sess-1"),
    ]);

    const count = stageCanonicalRecords(db, logPath);
    expect(count).toBe(4);

    // Verify they're in the staging table
    const rows = db
      .query("SELECT * FROM canonical_upload_staging ORDER BY local_seq")
      .all() as Array<{
      local_seq: number;
      record_kind: string;
      record_id: string;
      record_json: string;
      session_id: string | null;
    }>;
    expect(rows).toHaveLength(4);
    expect(rows[0].record_kind).toBe("session");
    expect(rows[0].record_id).toBe("sess-1");
    expect(rows[1].record_kind).toBe("prompt");
    expect(rows[1].record_id).toBe("p-1");
    expect(rows[2].record_kind).toBe("skill_invocation");
    expect(rows[2].record_id).toBe("inv-1");
    expect(rows[3].record_kind).toBe("execution_fact");
  });

  test("dedup -- staging same records twice does not create duplicates", () => {
    const logPath = writeCanonicalJsonl(tempDir, [
      makeCanonicalSessionRecord("sess-1"),
      makeCanonicalPromptRecord("p-1", "sess-1"),
    ]);

    const first = stageCanonicalRecords(db, logPath);
    expect(first).toBe(2);

    const second = stageCanonicalRecords(db, logPath);
    expect(second).toBe(0); // no new records

    const total = db.query("SELECT COUNT(*) as cnt FROM canonical_upload_staging").get() as {
      cnt: number;
    };
    expect(total.cnt).toBe(2);
  });

  test("stages evolution evidence from SQLite", () => {
    // No canonical JSONL records
    const logPath = writeCanonicalJsonl(tempDir, []);

    // Insert evolution evidence into SQLite
    insertEvolutionEvidence(db, {
      proposal_id: "prop-1",
      skill_name: "selftune",
      stage: "deployed",
      timestamp: "2026-03-18T10:10:00Z",
    });

    const count = stageCanonicalRecords(db, logPath);
    expect(count).toBe(1);

    const rows = db.query("SELECT * FROM canonical_upload_staging").all() as Array<{
      record_kind: string;
      record_id: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].record_kind).toBe("evolution_evidence");
    // record_id is now the deterministic evidence_id (ev_ prefix + hash)
    expect(rows[0].record_id).toStartWith("ev_");
  });

  test("stages evolution evidence with deterministic evidence_id", () => {
    const logPath = writeCanonicalJsonl(tempDir, []);

    insertEvolutionEvidence(db, {
      proposal_id: "prop-ev-id",
      skill_name: "selftune",
      stage: "deployed",
      timestamp: "2026-03-18T10:10:00Z",
    });

    stageCanonicalRecords(db, logPath);

    const rows = db
      .query(
        "SELECT record_json, record_id FROM canonical_upload_staging WHERE record_kind = 'evolution_evidence'",
      )
      .all() as Array<{
      record_json: string;
      record_id: string;
    }>;
    expect(rows).toHaveLength(1);

    const parsed = JSON.parse(rows[0].record_json);
    // evidence_id must be present and start with ev_
    expect(parsed.evidence_id).toBeDefined();
    expect(typeof parsed.evidence_id).toBe("string");
    expect(parsed.evidence_id).toStartWith("ev_");

    // record_id in staging table should be the evidence_id
    expect(rows[0].record_id).toBe(parsed.evidence_id);
  });

  test("omits null optional evolution evidence fields while staging", () => {
    const logPath = writeCanonicalJsonl(tempDir, []);
    db.run(
      `INSERT INTO evolution_evidence
        (timestamp, proposal_id, skill_name, target, stage, original_text, proposed_text, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "2026-03-18T10:12:00Z",
        "prop-null-optionals",
        "selftune",
        "description",
        "deployed",
        null,
        null,
        null,
      ],
    );

    stageCanonicalRecords(db, logPath);

    const row = db
      .query(
        "SELECT record_json FROM canonical_upload_staging WHERE record_kind = 'evolution_evidence'",
      )
      .get() as { record_json: string };
    const parsed = JSON.parse(row.record_json);

    expect(parsed).not.toHaveProperty("original_text");
    expect(parsed).not.toHaveProperty("proposed_text");
    expect(parsed).not.toHaveProperty("details");
  });

  test("evidence_id is deterministic -- same evidence produces same ID", () => {
    const record1 = {
      proposal_id: "prop-det",
      stage: "validated",
      skill_name: "Research",
      timestamp: "2026-03-18T10:15:00Z",
    };

    const id1 = generateEvidenceId(record1);
    const id2 = generateEvidenceId(record1);

    expect(id1).toBe(id2);
    expect(id1).toStartWith("ev_");
  });

  test("evidence_id differs for same proposal+stage at different timestamps", () => {
    const record1 = {
      proposal_id: "prop-multi",
      stage: "validated",
      skill_name: "Research",
      timestamp: "2026-03-18T10:15:00Z",
    };
    const record2 = {
      ...record1,
      timestamp: "2026-03-18T11:00:00Z",
    };

    const id1 = generateEvidenceId(record1);
    const id2 = generateEvidenceId(record2);

    expect(id1).not.toBe(id2);
  });

  test("evidence_id handles null proposal_id gracefully", () => {
    const record = {
      proposal_id: null,
      stage: "proposed",
      skill_name: "selftune",
      timestamp: "2026-03-18T10:00:00Z",
    };

    const id = generateEvidenceId(record);
    expect(id).toStartWith("ev_");
    expect(id.length).toBeGreaterThan(3);
  });

  test("preserves full canonical record JSON losslessly", () => {
    const session = makeCanonicalSessionRecord("sess-lossless", {
      raw_source_ref: { path: "/transcripts/abc.jsonl", line: 42 },
      capture_mode: "hook",
      normalizer_version: "2.5.0",
    });
    const logPath = writeCanonicalJsonl(tempDir, [session]);

    stageCanonicalRecords(db, logPath);

    const row = db
      .query("SELECT record_json FROM canonical_upload_staging WHERE record_id = 'sess-lossless'")
      .get() as { record_json: string };
    const parsed = JSON.parse(row.record_json);

    // These fields should be preserved exactly as-is from the canonical log
    expect(parsed.raw_source_ref).toEqual({ path: "/transcripts/abc.jsonl", line: 42 });
    expect(parsed.capture_mode).toBe("hook");
    expect(parsed.normalizer_version).toBe("2.5.0");
    expect(parsed.schema_version).toBe("2.0");
  });

  test("uses execution_fact_id as record_id for execution facts", () => {
    const fact = makeCanonicalExecutionFactRecord("sess-efid", {
      execution_fact_id: "ef-custom-123",
    });

    const logPath = writeCanonicalJsonl(tempDir, [fact]);
    stageCanonicalRecords(db, logPath);

    const row = db
      .query("SELECT record_id FROM canonical_upload_staging WHERE record_kind = 'execution_fact'")
      .get() as { record_id: string };
    expect(row.record_id).toBe("ef-custom-123");
  });

  test("uses execution_fact_id directly as record_id (no fallback format)", () => {
    const fact = makeCanonicalExecutionFactRecord("sess-det", {
      execution_fact_id: "ef-explicit-id",
    });

    const logPath = writeCanonicalJsonl(tempDir, [fact]);
    stageCanonicalRecords(db, logPath);

    const row = db
      .query("SELECT record_id FROM canonical_upload_staging WHERE record_kind = 'execution_fact'")
      .get() as { record_id: string };
    expect(row.record_id).toBe("ef-explicit-id");
  });

  test("injects deterministic execution_fact_id when missing from record", () => {
    // Create a record WITHOUT execution_fact_id to simulate older canonical logs
    const factWithoutId = {
      record_kind: "execution_fact",
      schema_version: "2.0",
      normalizer_version: "1.0.0",
      normalized_at: "2026-03-18T10:00:00.000Z",
      platform: "claude_code",
      capture_mode: "replay",
      source_session_kind: "interactive",
      raw_source_ref: {},
      session_id: "sess-no-efid",
      occurred_at: "2026-03-18T09:03:00.000Z",
      tool_calls_json: { Read: 1 },
      total_tool_calls: 1,
      assistant_turns: 1,
      errors_encountered: 0,
      // NOTE: no execution_fact_id field at all
    };

    const logPath = writeCanonicalJsonl(tempDir, [factWithoutId]);
    stageCanonicalRecords(db, logPath);

    const row = db
      .query(
        "SELECT record_json FROM canonical_upload_staging WHERE record_kind = 'execution_fact'",
      )
      .get() as { record_json: string };
    const parsed = JSON.parse(row.record_json);

    // Must have execution_fact_id injected
    expect(parsed.execution_fact_id).toBeDefined();
    expect(typeof parsed.execution_fact_id).toBe("string");
    expect(parsed.execution_fact_id).toStartWith("ef_");
  });

  test("generated execution_fact_id is deterministic (same inputs produce same ID)", () => {
    // Two identical records should produce the same execution_fact_id
    const factWithoutId = {
      record_kind: "execution_fact",
      schema_version: "2.0",
      normalizer_version: "1.0.0",
      normalized_at: "2026-03-18T10:00:00.000Z",
      platform: "claude_code",
      capture_mode: "replay",
      source_session_kind: "interactive",
      raw_source_ref: {},
      session_id: "sess-deterministic",
      occurred_at: "2026-03-18T09:05:00.000Z",
      prompt_id: "p-det-1",
      tool_calls_json: { Read: 2 },
      total_tool_calls: 2,
      assistant_turns: 1,
      errors_encountered: 0,
    };

    // Stage once
    const logPath1 = writeCanonicalJsonl(tempDir, [factWithoutId]);
    stageCanonicalRecords(db, logPath1);

    const row1 = db
      .query(
        "SELECT record_json FROM canonical_upload_staging WHERE record_kind = 'execution_fact'",
      )
      .get() as { record_json: string };
    const id1 = JSON.parse(row1.record_json).execution_fact_id;

    // Stage again with a fresh DB -- same record should produce same ID
    const db2 = createTestDb();
    stageCanonicalRecords(db2, logPath1);

    const row2 = db2
      .query(
        "SELECT record_json FROM canonical_upload_staging WHERE record_kind = 'execution_fact'",
      )
      .get() as { record_json: string };
    const id2 = JSON.parse(row2.record_json).execution_fact_id;
    db2.close();

    expect(id1).toBe(id2);
    expect(id1).toStartWith("ef_");
  });

  test("execution facts WITH execution_fact_id are left unchanged", () => {
    const factWithId = makeCanonicalExecutionFactRecord("sess-has-id", {
      execution_fact_id: "ef-already-set-999",
    });

    const logPath = writeCanonicalJsonl(tempDir, [factWithId]);
    stageCanonicalRecords(db, logPath);

    const row = db
      .query(
        "SELECT record_json FROM canonical_upload_staging WHERE record_kind = 'execution_fact'",
      )
      .get() as { record_json: string };
    const parsed = JSON.parse(row.record_json);

    // Must preserve the original execution_fact_id exactly
    expect(parsed.execution_fact_id).toBe("ef-already-set-999");
  });

  test("returns 0 when JSONL file does not exist", () => {
    const count = stageCanonicalRecords(db, "/nonexistent/file.jsonl");
    expect(count).toBe(0);
  });

  test("stages orchestrate_runs from SQLite", () => {
    const logPath = writeCanonicalJsonl(tempDir, []);

    // Insert an orchestrate run into SQLite
    db.run(
      `INSERT INTO orchestrate_runs (run_id, timestamp, elapsed_ms, dry_run, approval_mode, total_skills, evaluated, evolved, deployed, watched, skipped, skill_actions_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "orch-run-1",
        "2026-03-18T11:00:00.000Z",
        5000,
        0,
        "auto",
        3,
        2,
        1,
        1,
        1,
        0,
        JSON.stringify([
          { skill: "selftune", action: "evolve", reason: "low pass rate", deployed: true },
          { skill: "commit", action: "watch", reason: "recently deployed" },
        ]),
      ],
    );

    const count = stageCanonicalRecords(db, logPath);
    expect(count).toBe(1);

    const rows = db.query("SELECT * FROM canonical_upload_staging").all() as Array<{
      record_kind: string;
      record_id: string;
      record_json: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].record_kind).toBe("orchestrate_run");
    expect(rows[0].record_id).toBe("orch-run-1");

    // Verify the staged JSON has correct types
    const parsed = JSON.parse(rows[0].record_json);
    expect(parsed.dry_run).toBe(false); // boolean, not integer
    expect(parsed.skill_actions).toBeArray();
    expect(parsed.skill_actions).toHaveLength(2);
    expect(parsed.skill_actions[0].skill).toBe("selftune");
  });

  test("orchestrate_run dedup by run_id", () => {
    const logPath = writeCanonicalJsonl(tempDir, []);

    db.run(
      `INSERT INTO orchestrate_runs (run_id, timestamp, elapsed_ms, dry_run, approval_mode, total_skills, evaluated, evolved, deployed, watched, skipped, skill_actions_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["orch-dup", "2026-03-18T11:00:00.000Z", 1000, 1, "review", 1, 1, 0, 0, 0, 1, "[]"],
    );

    const first = stageCanonicalRecords(db, logPath);
    expect(first).toBe(1);

    const second = stageCanonicalRecords(db, logPath);
    expect(second).toBe(0);
  });
});

describe("buildV2PushPayload (staging-based)", () => {
  let db: Database;
  let tempDir: string;

  beforeEach(() => {
    db = createTestDb();
    tempDir = createTempDir();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns null when staging table is empty", () => {
    const result = buildV2PushPayload(db);
    expect(result).toBeNull();
  });

  test("returns null when all records are past cursor", () => {
    const logPath = writeCanonicalJsonl(tempDir, [makeCanonicalSessionRecord("sess-1")]);
    stageCanonicalRecords(db, logPath);

    const result = buildV2PushPayload(db, 999999);
    expect(result).toBeNull();
  });

  test("builds payload from staged records", () => {
    const logPath = writeCanonicalJsonl(tempDir, [
      makeCanonicalSessionRecord("sess-1"),
      makeCanonicalPromptRecord("p-1", "sess-1"),
      makeCanonicalInvocationRecord("inv-1", "sess-1"),
      makeCanonicalExecutionFactRecord("sess-1"),
    ]);
    stageCanonicalRecords(db, logPath);

    const result = buildV2PushPayload(db);
    expect(result).not.toBeNull();

    expect(result).toBeDefined();
    const payload = result?.payload;
    expect(payload.schema_version).toBe("2.0");
    expect(payload.push_id).toBeDefined();

    const canonical = payload?.canonical as Record<string, unknown[]>;
    expect(canonical.sessions).toHaveLength(1);
    expect(canonical.prompts).toHaveLength(1);
    expect(canonical.skill_invocations).toHaveLength(1);
    expect(canonical.execution_facts).toHaveLength(1);
  });

  test("returns correct lastSeq for cursor advancement", () => {
    const logPath = writeCanonicalJsonl(tempDir, [
      makeCanonicalSessionRecord("sess-1"),
      makeCanonicalSessionRecord("sess-2"),
    ]);
    stageCanonicalRecords(db, logPath);

    const first = buildV2PushPayload(db);
    expect(first).not.toBeNull();
    expect(first).toBeDefined();
    expect(first?.lastSeq).toBeGreaterThan(0);

    // Second call with cursor from first should return null
    const second = buildV2PushPayload(db, first?.lastSeq);
    expect(second).toBeNull();
  });

  test("respects limit parameter", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeCanonicalSessionRecord(`sess-limit-${i}`),
    );
    const logPath = writeCanonicalJsonl(tempDir, records);
    stageCanonicalRecords(db, logPath);

    const result = buildV2PushPayload(db, undefined, 3);
    expect(result).not.toBeNull();
    expect(result).toBeDefined();

    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    expect(canonical.sessions).toHaveLength(3);
  });

  test("includes evolution evidence in payload", () => {
    const logPath = writeCanonicalJsonl(tempDir, []);
    insertEvolutionEvidence(db, {
      proposal_id: "prop-evo",
      skill_name: "selftune",
      stage: "deployed",
      timestamp: "2026-03-18T10:10:00Z",
    });
    stageCanonicalRecords(db, logPath);

    const result = buildV2PushPayload(db);
    expect(result).not.toBeNull();
    expect(result).toBeDefined();

    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    expect(canonical.evolution_evidence).toHaveLength(1);
    const ev = canonical.evolution_evidence[0] as Record<string, unknown>;
    expect(ev.skill_name).toBe("selftune");
    expect(ev.proposal_id).toBe("prop-evo");
  });

  test("payload passes structural validation", () => {
    const logPath = writeCanonicalJsonl(tempDir, [
      makeCanonicalSessionRecord("sess-v"),
      makeCanonicalPromptRecord("p-v", "sess-v"),
      makeCanonicalInvocationRecord("inv-v", "sess-v"),
      makeCanonicalExecutionFactRecord("sess-v", { execution_fact_id: "ef-v" }),
    ]);
    stageCanonicalRecords(db, logPath);

    insertEvolutionEvidence(db, {
      proposal_id: "prop-v",
      skill_name: "selftune",
      stage: "deployed",
      timestamp: "2026-03-18T10:10:00.000Z",
    });
    // Re-stage to pick up evolution evidence
    stageCanonicalRecords(db, logPath);

    const result = buildV2PushPayload(db);
    expect(result).not.toBeNull();
    expect(result).toBeDefined();

    if (!result) throw new Error("expected staged payload");
    const p = result.payload;
    // Envelope fields
    expect(p.schema_version).toBe("2.0");
    expect(typeof p.client_version).toBe("string");
    expect(typeof p.push_id).toBe("string");
    expect(p.push_id.length).toBeGreaterThan(0);
    expect(typeof p.normalizer_version).toBe("string");

    // Canonical arrays exist with correct lengths
    const c = p.canonical;
    expect(c.sessions).toHaveLength(1);
    expect(c.prompts).toHaveLength(1);
    expect(c.skill_invocations).toHaveLength(1);
    expect(c.execution_facts).toHaveLength(1);
    expect(c.evolution_evidence).toHaveLength(1);

    // Spot-check a session record
    const sess = c.sessions[0];
    expect(sess.record_kind).toBe("session");
    expect(sess.schema_version).toBe("2.0");
    expect(sess.session_id).toBe("sess-v");

    // Spot-check evolution evidence
    const ev = c.evolution_evidence?.[0];
    expect(ev).toBeDefined();
    expect(ev.skill_name).toBe("selftune");
    expect(ev.proposal_id).toBe("prop-v");
  });

  test("includes orchestrate_runs in payload from staging", () => {
    const logPath = writeCanonicalJsonl(tempDir, [makeCanonicalSessionRecord("sess-orch")]);

    // Insert orchestrate run
    db.run(
      `INSERT INTO orchestrate_runs (run_id, timestamp, elapsed_ms, dry_run, approval_mode, total_skills, evaluated, evolved, deployed, watched, skipped, skill_actions_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "orch-payload-1",
        "2026-03-18T11:00:00.000Z",
        8000,
        0,
        "auto",
        5,
        4,
        1,
        1,
        2,
        1,
        JSON.stringify([
          {
            skill: "selftune",
            action: "evolve",
            reason: "pass rate below threshold",
            deployed: true,
          },
        ]),
      ],
    );

    stageCanonicalRecords(db, logPath);
    const result = buildV2PushPayload(db);
    expect(result).not.toBeNull();
    expect(result).toBeDefined();

    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    expect(canonical.orchestrate_runs).toBeDefined();
    expect(canonical.orchestrate_runs).toHaveLength(1);

    const run = canonical.orchestrate_runs[0] as Record<string, unknown>;
    expect(run.run_id).toBe("orch-payload-1");
    expect(run.dry_run).toBe(false);
    expect(run.approval_mode).toBe("auto");
    expect(run.total_skills).toBe(5);
    expect((run.skill_actions as unknown[]).length).toBe(1);
  });

  test("default SQLite path: stages records written via direct-write (no JSONL)", () => {
    // Write canonical records directly into SQLite tables (simulating the runtime path
    // where hooks write via direct-write.ts, not via JSONL)
    db.run(
      `INSERT INTO sessions
        (session_id, started_at, ended_at, platform, model, completion_status,
         source_session_kind, schema_version, normalized_at,
         normalizer_version, capture_mode, raw_source_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "sqlite-sess-1",
        "2026-03-18T09:00:00.000Z",
        "2026-03-18T09:30:00.000Z",
        "claude_code",
        "opus",
        "completed",
        "interactive",
        "2.0",
        "2026-03-18T10:00:00.000Z",
        "1.0.0",
        "hook",
        JSON.stringify({ event_type: "SessionStop" }),
      ],
    );
    db.run(
      `INSERT INTO prompts
        (prompt_id, session_id, occurred_at, prompt_kind, is_actionable, prompt_index, prompt_text,
         schema_version, platform, normalized_at, normalizer_version, capture_mode, raw_source_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "sqlite-sess-1:p0",
        "sqlite-sess-1",
        "2026-03-18T09:01:00.000Z",
        "user",
        1,
        0,
        "improve my skills",
        "2.0",
        "claude_code",
        "2026-03-18T10:00:00.000Z",
        "1.0.0",
        "hook",
        JSON.stringify({ event_type: "UserPromptSubmit" }),
      ],
    );
    db.run(
      `INSERT INTO skill_invocations
        (skill_invocation_id, session_id, occurred_at, skill_name, invocation_mode,
         triggered, confidence,
         schema_version, platform, normalized_at, normalizer_version, capture_mode, raw_source_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "sqlite-sess-1:s:selftune:0",
        "sqlite-sess-1",
        "2026-03-18T09:02:00.000Z",
        "selftune",
        "implicit",
        1,
        0.95,
        "2.0",
        "claude_code",
        "2026-03-18T10:00:00.000Z",
        "1.0.0",
        "hook",
        JSON.stringify({}),
      ],
    );
    db.run(
      `INSERT INTO execution_facts
        (session_id, occurred_at, tool_calls_json, total_tool_calls,
         assistant_turns, errors_encountered,
         schema_version, platform, normalized_at, normalizer_version, capture_mode, raw_source_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "sqlite-sess-1",
        "2026-03-18T09:30:00.000Z",
        JSON.stringify({ Read: 2, Write: 1 }),
        3,
        4,
        0,
        "2.0",
        "claude_code",
        "2026-03-18T10:00:00.000Z",
        "1.0.0",
        "hook",
        JSON.stringify({}),
      ],
    );

    // Call stageCanonicalRecords with default logPath — this triggers the SQLite read path
    const staged = stageCanonicalRecords(db);
    expect(staged).toBe(4); // exactly session + prompt + invocation + execution_fact

    // Verify staged rows exist and contain valid canonical JSON
    const rows = db
      .query("SELECT * FROM canonical_upload_staging ORDER BY local_seq")
      .all() as Array<Record<string, unknown>>;
    const kinds = rows.map((r) => r.record_kind);
    expect(kinds).toContain("session");
    expect(kinds).toContain("prompt");
    expect(kinds).toContain("skill_invocation");
    expect(kinds).toContain("execution_fact");

    // Verify the staged JSON passes contract validation by building a payload
    const result = buildV2PushPayload(db);
    if (!result) throw new Error("expected staged payload");
    expect(result.payload.canonical.sessions).toHaveLength(1);
    expect(result.payload.canonical.prompts).toHaveLength(1);
    expect(result.payload.canonical.skill_invocations).toHaveLength(1);
    expect(result.payload.canonical.execution_facts).toHaveLength(1);

    // Spot-check envelope fields survived the round-trip
    const sess = result.payload.canonical.sessions[0] as Record<string, unknown>;
    expect(sess.normalizer_version).toBe("1.0.0");
    expect(sess.capture_mode).toBe("hook");
    expect(sess.raw_source_ref).toEqual({ event_type: "SessionStop" });
  });

  test("no hardcoded provenance fields -- canonical fields preserved from source", () => {
    const session = makeCanonicalSessionRecord("sess-prov", {
      capture_mode: "hook",
      normalizer_version: "3.0.0",
      raw_source_ref: { path: "/custom/path.jsonl", raw_id: "abc-123" },
    });
    const logPath = writeCanonicalJsonl(tempDir, [session]);
    stageCanonicalRecords(db, logPath);

    const result = buildV2PushPayload(db);
    expect(result).toBeDefined();
    const canonical = result?.payload.canonical as Record<string, unknown[]>;
    const s = canonical.sessions[0] as Record<string, unknown>;

    // These should come from the original record, NOT be hardcoded
    expect(s.capture_mode).toBe("hook");
    expect(s.normalizer_version).toBe("3.0.0");
    expect(s.raw_source_ref).toEqual({ path: "/custom/path.jsonl", raw_id: "abc-123" });
  });
});
