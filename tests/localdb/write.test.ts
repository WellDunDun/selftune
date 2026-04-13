import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type {
  CanonicalExecutionFactRecord,
  CanonicalPromptRecord,
  CanonicalSessionRecord,
  CanonicalSkillInvocationRecord,
} from "@selftune/telemetry-contract";

import type { OrchestrateRunReport } from "../../cli/selftune/dashboard-contract.js";
import { _setTestDb, openDb } from "../../cli/selftune/localdb/db.js";
import type { SkillInvocationWriteInput } from "../../cli/selftune/localdb/direct-write.js";
import {
  updateSignalConsumed,
  writeCanonicalBatchToDb,
  writeCanonicalToDb,
  writeEvolutionAuditToDb,
  writeEvolutionEvidenceToDb,
  writeImprovementSignalToDb,
  writeOrchestrateRunToDb,
  writeQueryToDb,
  writeSessionTelemetryToDb,
  writeSkillCheckToDb,
  writeSkillUsageToDb,
} from "../../cli/selftune/localdb/direct-write.js";
import type {
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Helpers — reusable canonical record builders
// ---------------------------------------------------------------------------

const BASE_CANONICAL = {
  schema_version: "2.0" as const,
  normalizer_version: "1.0.0",
  normalized_at: "2026-03-17T10:00:00Z",
  platform: "claude_code" as const,
  capture_mode: "hook" as const,
  raw_source_ref: {},
  source_session_kind: "interactive" as const,
};

function makeSession(overrides: Partial<CanonicalSessionRecord> = {}): CanonicalSessionRecord {
  return {
    ...BASE_CANONICAL,
    record_kind: "session",
    session_id: "sess-001",
    started_at: "2026-03-17T10:00:00Z",
    ended_at: "2026-03-17T10:30:00Z",
    model: "opus-4",
    completion_status: "completed",
    ...overrides,
  };
}

function makePrompt(overrides: Partial<CanonicalPromptRecord> = {}): CanonicalPromptRecord {
  return {
    ...BASE_CANONICAL,
    record_kind: "prompt",
    session_id: "sess-001",
    prompt_id: "prompt-001",
    occurred_at: "2026-03-17T10:01:00Z",
    prompt_text: "do some research",
    prompt_kind: "user",
    is_actionable: true,
    prompt_index: 0,
    ...overrides,
  };
}

function makeSkillInvocation(
  overrides: Partial<CanonicalSkillInvocationRecord> = {},
): CanonicalSkillInvocationRecord {
  return {
    ...BASE_CANONICAL,
    record_kind: "skill_invocation",
    session_id: "sess-001",
    skill_invocation_id: "si-001",
    occurred_at: "2026-03-17T10:02:00Z",
    skill_name: "Research",
    invocation_mode: "explicit",
    triggered: true,
    confidence: 0.95,
    ...overrides,
  };
}

function makeExecutionFact(
  overrides: Partial<CanonicalExecutionFactRecord> = {},
): CanonicalExecutionFactRecord {
  return {
    ...BASE_CANONICAL,
    record_kind: "execution_fact",
    execution_fact_id: "exec-001",
    session_id: "sess-001",
    occurred_at: "2026-03-17T10:05:00Z",
    tool_calls_json: { Read: 3, Bash: 2 },
    total_tool_calls: 5,
    bash_commands_redacted: ["ls", "git status"],
    assistant_turns: 4,
    errors_encountered: 0,
    input_tokens: 1000,
    output_tokens: 500,
    duration_ms: 30000,
    completion_status: "completed",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// writeCanonicalToDb tests
// ---------------------------------------------------------------------------

describe("writeCanonicalToDb", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
    _setTestDb(db);
  });

  afterEach(() => {
    _setTestDb(null);
    db.close();
  });

  it("inserts a session record", () => {
    const session = makeSession();
    const ok = writeCanonicalToDb(session);
    expect(ok).toBe(true);

    const rows = db.query("SELECT * FROM sessions WHERE session_id = ?").all("sess-001") as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0].platform).toBe("claude_code");
    expect(rows[0].model).toBe("opus-4");
    expect(rows[0].started_at).toBe("2026-03-17T10:00:00Z");
    expect(rows[0].completion_status).toBe("completed");
  });

  it("inserts a prompt record", () => {
    // Need session first for FK
    writeCanonicalToDb(makeSession());
    const ok = writeCanonicalToDb(makePrompt());
    expect(ok).toBe(true);

    const rows = db.query("SELECT * FROM prompts WHERE prompt_id = ?").all("prompt-001") as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("sess-001");
    expect(rows[0].prompt_kind).toBe("user");
    expect(rows[0].prompt_text).toBe("do some research");
    expect(rows[0].is_actionable).toBe(1);
    expect(rows[0].prompt_index).toBe(0);
  });

  it("inserts a skill_invocation record and creates session stub for FK", () => {
    // No session pre-inserted — the insert function should create a stub
    const ok = writeCanonicalToDb(makeSkillInvocation({ session_id: "sess-new" }));
    expect(ok).toBe(true);

    // Verify session stub exists
    const sessionRows = db
      .query("SELECT * FROM sessions WHERE session_id = ?")
      .all("sess-new") as Array<Record<string, unknown>>;
    expect(sessionRows).toHaveLength(1);

    // Verify skill invocation
    const siRows = db
      .query("SELECT * FROM skill_invocations WHERE skill_invocation_id = ?")
      .all("si-001") as Array<Record<string, unknown>>;
    expect(siRows).toHaveLength(1);
    expect(siRows[0].skill_name).toBe("Research");
    expect(siRows[0].triggered).toBe(1);
    expect(siRows[0].confidence).toBe(0.95);
    expect(siRows[0].invocation_mode).toBe("explicit");
  });

  it("inserts an execution_fact record", () => {
    writeCanonicalToDb(makeSession());
    const ok = writeCanonicalToDb(makeExecutionFact());
    expect(ok).toBe(true);

    const rows = db
      .query("SELECT * FROM execution_facts WHERE session_id = ?")
      .all("sess-001") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].total_tool_calls).toBe(5);
    expect(rows[0].assistant_turns).toBe(4);
    expect(rows[0].errors_encountered).toBe(0);
    expect(rows[0].input_tokens).toBe(1000);
    expect(rows[0].output_tokens).toBe(500);
    expect(rows[0].duration_ms).toBe(30000);

    // tool_calls_json should be a valid JSON string
    const toolCalls = JSON.parse(rows[0].tool_calls_json as string);
    expect(toolCalls.Read).toBe(3);
    expect(toolCalls.Bash).toBe(2);
  });

  it("dispatches by record_kind to correct tables", () => {
    writeCanonicalToDb(makeSession());
    writeCanonicalToDb(makePrompt());
    writeCanonicalToDb(makeSkillInvocation());
    writeCanonicalToDb(makeExecutionFact());

    expect((db.query("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c).toBe(1);
    expect((db.query("SELECT COUNT(*) as c FROM prompts").get() as { c: number }).c).toBe(1);
    expect((db.query("SELECT COUNT(*) as c FROM skill_invocations").get() as { c: number }).c).toBe(
      1,
    );
    expect((db.query("SELECT COUNT(*) as c FROM execution_facts").get() as { c: number }).c).toBe(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// writeCanonicalBatchToDb tests
// ---------------------------------------------------------------------------

describe("writeCanonicalBatchToDb", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
    _setTestDb(db);
  });

  afterEach(() => {
    _setTestDb(null);
    db.close();
  });

  it("inserts a batch of mixed record kinds", () => {
    const records = [makeSession(), makePrompt(), makeSkillInvocation(), makeExecutionFact()];
    const ok = writeCanonicalBatchToDb(records);
    expect(ok).toBe(true);

    expect((db.query("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c).toBe(1);
    expect((db.query("SELECT COUNT(*) as c FROM prompts").get() as { c: number }).c).toBe(1);
    expect((db.query("SELECT COUNT(*) as c FROM skill_invocations").get() as { c: number }).c).toBe(
      1,
    );
    expect((db.query("SELECT COUNT(*) as c FROM execution_facts").get() as { c: number }).c).toBe(
      1,
    );
  });

  it("returns true for empty array (no-op)", () => {
    const ok = writeCanonicalBatchToDb([]);
    expect(ok).toBe(true);

    // Tables should be empty
    expect((db.query("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Session upsert (COALESCE merge) tests
// ---------------------------------------------------------------------------

describe("session upsert dedup", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
    _setTestDb(db);
  });

  afterEach(() => {
    _setTestDb(null);
    db.close();
  });

  it("merges fields via COALESCE on duplicate session_id", () => {
    // First insert with model but no branch
    writeCanonicalToDb(
      makeSession({
        session_id: "sess-merge",
        model: "opus-4",
        branch: undefined,
        agent_cli: undefined,
      }),
    );

    // Second insert with branch but no model
    writeCanonicalToDb(
      makeSession({
        session_id: "sess-merge",
        model: undefined,
        branch: "main",
        agent_cli: "claude-code-1.0",
      }),
    );

    const rows = db.query("SELECT * FROM sessions WHERE session_id = ?").all("sess-merge") as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    // COALESCE keeps the first non-null value (existing row wins)
    expect(rows[0].model).toBe("opus-4");
    // branch was null, now set from second insert
    expect(rows[0].branch).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// Prompt dedup (INSERT OR IGNORE) tests
// ---------------------------------------------------------------------------

describe("prompt dedup", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
    _setTestDb(db);
  });

  afterEach(() => {
    _setTestDb(null);
    db.close();
  });

  it("ignores duplicate prompt_id — count stays 1", () => {
    writeCanonicalToDb(makeSession());
    writeCanonicalToDb(makePrompt({ prompt_id: "prompt-dup" }));
    writeCanonicalToDb(makePrompt({ prompt_id: "prompt-dup", prompt_text: "different text" }));

    const count = (db.query("SELECT COUNT(*) as c FROM prompts").get() as { c: number }).c;
    expect(count).toBe(1);

    // Original text preserved (INSERT OR IGNORE keeps the first)
    const row = db
      .query("SELECT prompt_text FROM prompts WHERE prompt_id = ?")
      .get("prompt-dup") as { prompt_text: string };
    expect(row.prompt_text).toBe("do some research");
  });
});

// ---------------------------------------------------------------------------
// writeSessionTelemetryToDb tests
// ---------------------------------------------------------------------------

describe("writeSessionTelemetryToDb", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
    _setTestDb(db);
  });

  afterEach(() => {
    _setTestDb(null);
    db.close();
  });

  it("inserts and round-trips JSON fields", () => {
    const record: SessionTelemetryRecord = {
      timestamp: "2026-03-17T10:00:00Z",
      session_id: "sess-tel-001",
      cwd: "/home/user/project",
      transcript_path: "/tmp/transcript.jsonl",
      tool_calls: { Read: 5, Bash: 3 },
      total_tool_calls: 8,
      bash_commands: ["git status", "ls -la"],
      skills_triggered: ["Research", "Browser"],
      skills_invoked: ["Research"],
      assistant_turns: 6,
      errors_encountered: 1,
      transcript_chars: 5000,
      last_user_query: "do research on tests",
      source: "hook",
      input_tokens: 2000,
      output_tokens: 1000,
    };
    const ok = writeSessionTelemetryToDb(record);
    expect(ok).toBe(true);

    const rows = db
      .query("SELECT * FROM session_telemetry WHERE session_id = ?")
      .all("sess-tel-001") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].total_tool_calls).toBe(8);
    expect(rows[0].assistant_turns).toBe(6);
    expect(rows[0].errors_encountered).toBe(1);
    expect(rows[0].transcript_chars).toBe(5000);
    expect(rows[0].last_user_query).toBe("do research on tests");
    expect(rows[0].source).toBe("hook");
    expect(rows[0].input_tokens).toBe(2000);
    expect(rows[0].output_tokens).toBe(1000);

    // JSON fields round-trip
    const toolCalls = JSON.parse(rows[0].tool_calls_json as string);
    expect(toolCalls.Read).toBe(5);
    const bashCmds = JSON.parse(rows[0].bash_commands_json as string);
    expect(bashCmds).toEqual(["git status", "ls -la"]);
    const skillsTriggered = JSON.parse(rows[0].skills_triggered_json as string);
    expect(skillsTriggered).toEqual(["Research", "Browser"]);
    const skillsInvoked = JSON.parse(rows[0].skills_invoked_json as string);
    expect(skillsInvoked).toEqual(["Research"]);
  });
});

// ---------------------------------------------------------------------------
// writeSkillUsageToDb tests
// ---------------------------------------------------------------------------

describe("writeSkillUsageToDb", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
    _setTestDb(db);
  });

  afterEach(() => {
    _setTestDb(null);
    db.close();
  });

  it("inserts and deduplicates on (session_id, skill_name, query, timestamp, triggered)", () => {
    const record: SkillUsageRecord = {
      timestamp: "2026-03-17T10:00:00Z",
      session_id: "sess-su-001",
      skill_name: "Research",
      skill_path: "/skills/Research/SKILL.md",
      query: "do research",
      triggered: true,
      source: "hook",
    };
    const ok1 = writeSkillUsageToDb(record);
    expect(ok1).toBe(true);

    // Duplicate insert should be ignored
    const ok2 = writeSkillUsageToDb(record);
    expect(ok2).toBe(true);

    const count = (db.query("SELECT COUNT(*) as c FROM skill_usage").get() as { c: number }).c;
    expect(count).toBe(1);

    // Verify triggered stored as integer
    const row = db.query("SELECT triggered FROM skill_usage").get() as { triggered: number };
    expect(row.triggered).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// writeSkillCheckToDb tests (unified skill_invocations with usage columns)
// ---------------------------------------------------------------------------

describe("writeSkillCheckToDb", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
    _setTestDb(db);
  });

  afterEach(() => {
    _setTestDb(null);
    db.close();
  });

  it("inserts into skill_invocations with extended usage columns", () => {
    const input: SkillInvocationWriteInput = {
      skill_invocation_id: "si-check-001",
      session_id: "sess-check-001",
      occurred_at: "2026-03-17T10:00:00Z",
      skill_name: "Research",
      invocation_mode: "explicit",
      triggered: true,
      confidence: 0.95,
      tool_name: "Skill",
      query: "do some research",
      skill_path: "/skills/Research/SKILL.md",
      skill_scope: "project",
      source: "claude_code",
    };
    const ok = writeSkillCheckToDb(input);
    expect(ok).toBe(true);

    const rows = db
      .query("SELECT * FROM skill_invocations WHERE skill_invocation_id = ?")
      .all("si-check-001") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].skill_name).toBe("Research");
    expect(rows[0].invocation_mode).toBe("explicit");
    expect(rows[0].triggered).toBe(1);
    expect(rows[0].confidence).toBe(0.95);
    expect(rows[0].tool_name).toBe("Skill");
    // Verify extended columns
    expect(rows[0].query).toBe("do some research");
    expect(rows[0].skill_path).toBe("/skills/Research/SKILL.md");
    expect(rows[0].skill_scope).toBe("project");
    expect(rows[0].source).toBe("claude_code");
  });

  it("stores null for optional extended columns when omitted", () => {
    const input: SkillInvocationWriteInput = {
      skill_invocation_id: "si-check-002",
      session_id: "sess-check-002",
      occurred_at: "2026-03-17T10:01:00Z",
      skill_name: "Browser",
      invocation_mode: "inferred",
      triggered: true,
      confidence: 0.7,
    };
    const ok = writeSkillCheckToDb(input);
    expect(ok).toBe(true);

    const rows = db
      .query("SELECT * FROM skill_invocations WHERE skill_invocation_id = ?")
      .all("si-check-002") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].query).toBeNull();
    expect(rows[0].skill_path).toBeNull();
    expect(rows[0].skill_scope).toBeNull();
    expect(rows[0].source).toBeNull();
  });

  it("deduplicates on skill_invocation_id", () => {
    const input: SkillInvocationWriteInput = {
      skill_invocation_id: "si-check-dup",
      session_id: "sess-check-003",
      occurred_at: "2026-03-17T10:02:00Z",
      skill_name: "Research",
      invocation_mode: "explicit",
      triggered: true,
      confidence: 0.9,
      query: "original query",
    };
    writeSkillCheckToDb(input);
    writeSkillCheckToDb({ ...input, query: "different query" });

    const count = (
      db
        .query("SELECT COUNT(*) as c FROM skill_invocations WHERE skill_invocation_id = ?")
        .get("si-check-dup") as { c: number }
    ).c;
    expect(count).toBe(1);

    // First insert wins (INSERT OR IGNORE)
    const row = db
      .query("SELECT query FROM skill_invocations WHERE skill_invocation_id = ?")
      .get("si-check-dup") as { query: string };
    expect(row.query).toBe("original query");
  });
});

// ---------------------------------------------------------------------------
// writeEvolutionAuditToDb tests
// ---------------------------------------------------------------------------

describe("writeEvolutionAuditToDb", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
    _setTestDb(db);
  });

  afterEach(() => {
    _setTestDb(null);
    db.close();
  });

  it("inserts with eval_snapshot JSON", () => {
    const record: EvolutionAuditEntry = {
      timestamp: "2026-03-17T10:00:00Z",
      proposal_id: "prop-audit-001",
      skill_name: "Research",
      action: "created",
      details: "Initial proposal for Research",
      eval_snapshot: { total: 10, passed: 8, failed: 2, pass_rate: 0.8 },
      validation_mode: "host_replay",
      validation_agent: "claude",
      validation_fixture_id: "fixture-001",
      validation_evidence_ref: "evolution_evidence:prop-audit-001:validated",
    };
    const ok = writeEvolutionAuditToDb(record);
    expect(ok).toBe(true);

    const rows = db
      .query("SELECT * FROM evolution_audit WHERE proposal_id = ?")
      .all("prop-audit-001") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("created");
    expect(rows[0].details).toBe("Initial proposal for Research");
    expect(rows[0].skill_name).toBe("Research");
    expect(rows[0].validation_mode).toBe("host_replay");
    expect(rows[0].validation_agent).toBe("claude");
    expect(rows[0].validation_fixture_id).toBe("fixture-001");
    expect(rows[0].validation_evidence_ref).toBe("evolution_evidence:prop-audit-001:validated");

    const snapshot = JSON.parse(rows[0].eval_snapshot_json as string);
    expect(snapshot.pass_rate).toBe(0.8);
    expect(snapshot.total).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// writeEvolutionEvidenceToDb tests
// ---------------------------------------------------------------------------

describe("writeEvolutionEvidenceToDb", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
    _setTestDb(db);
  });

  afterEach(() => {
    _setTestDb(null);
    db.close();
  });

  it("inserts all 13 columns including JSON fields", () => {
    const record: EvolutionEvidenceEntry = {
      timestamp: "2026-03-17T10:00:00Z",
      proposal_id: "prop-ev-001",
      skill_name: "Research",
      skill_path: "/skills/Research/SKILL.md",
      target: "description",
      stage: "validated",
      rationale: "Improves trigger accuracy",
      confidence: 0.85,
      details: "Detailed analysis of changes",
      original_text: "Old description",
      proposed_text: "New description",
      eval_set: [
        { query: "do research", should_trigger: true },
        { query: "write code", should_trigger: false },
      ],
      validation: {
        improved: true,
        before_pass_rate: 0.6,
        after_pass_rate: 0.85,
        net_change: 0.25,
      },
    };
    const ok = writeEvolutionEvidenceToDb(record);
    expect(ok).toBe(true);

    const rows = db
      .query("SELECT * FROM evolution_evidence WHERE proposal_id = ?")
      .all("prop-ev-001") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].skill_name).toBe("Research");
    expect(rows[0].target).toBe("description");
    expect(rows[0].stage).toBe("validated");
    expect(rows[0].rationale).toBe("Improves trigger accuracy");
    expect(rows[0].confidence).toBe(0.85);
    expect(rows[0].details).toBe("Detailed analysis of changes");
    expect(rows[0].original_text).toBe("Old description");
    expect(rows[0].proposed_text).toBe("New description");

    const evalSet = JSON.parse(rows[0].eval_set_json as string);
    expect(evalSet).toHaveLength(2);
    expect(evalSet[0].query).toBe("do research");

    const validation = JSON.parse(rows[0].validation_json as string);
    expect(validation.improved).toBe(true);
    expect(validation.net_change).toBe(0.25);
  });
});

// ---------------------------------------------------------------------------
// writeOrchestrateRunToDb tests
// ---------------------------------------------------------------------------

describe("writeOrchestrateRunToDb", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
    _setTestDb(db);
  });

  afterEach(() => {
    _setTestDb(null);
    db.close();
  });

  it("inserts and round-trips skill_actions_json", () => {
    const record: OrchestrateRunReport = {
      run_id: "run-001",
      timestamp: "2026-03-17T10:00:00Z",
      elapsed_ms: 45000,
      dry_run: false,
      approval_mode: "auto",
      total_skills: 3,
      evaluated: 3,
      evolved: 1,
      deployed: 1,
      watched: 1,
      skipped: 1,
      skill_actions: [
        { skill: "Research", action: "evolve", reason: "Low pass rate", deployed: true },
        { skill: "Browser", action: "watch", reason: "Monitoring" },
        { skill: "Debug", action: "skip", reason: "Insufficient data" },
      ],
    };
    const ok = writeOrchestrateRunToDb(record);
    expect(ok).toBe(true);

    const rows = db
      .query("SELECT * FROM orchestrate_runs WHERE run_id = ?")
      .all("run-001") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].elapsed_ms).toBe(45000);
    expect(rows[0].dry_run).toBe(0);
    expect(rows[0].approval_mode).toBe("auto");
    expect(rows[0].total_skills).toBe(3);
    expect(rows[0].evolved).toBe(1);
    expect(rows[0].deployed).toBe(1);

    const actions = JSON.parse(rows[0].skill_actions_json as string);
    expect(actions).toHaveLength(3);
    expect(actions[0].skill).toBe("Research");
    expect(actions[0].deployed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeQueryToDb tests
// ---------------------------------------------------------------------------

describe("writeQueryToDb", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
    _setTestDb(db);
  });

  afterEach(() => {
    _setTestDb(null);
    db.close();
  });

  it("inserts and deduplicates on (session_id, query, timestamp)", () => {
    const record = {
      timestamp: "2026-03-17T10:00:00Z",
      session_id: "sess-q-001",
      query: "how do I test this?",
      source: "hook",
    };
    const ok1 = writeQueryToDb(record);
    expect(ok1).toBe(true);

    // Duplicate should be ignored
    const ok2 = writeQueryToDb(record);
    expect(ok2).toBe(true);

    const count = (db.query("SELECT COUNT(*) as c FROM queries").get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// writeImprovementSignalToDb tests
// ---------------------------------------------------------------------------

describe("writeImprovementSignalToDb", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
    _setTestDb(db);
  });

  afterEach(() => {
    _setTestDb(null);
    db.close();
  });

  it("inserts with consumed=0 default", () => {
    const ok = writeImprovementSignalToDb({
      timestamp: "2026-03-17T10:00:00Z",
      session_id: "sess-sig-001",
      query: "fix the research skill",
      signal_type: "correction",
      mentioned_skill: "Research",
      consumed: false,
    });
    expect(ok).toBe(true);

    const rows = db
      .query("SELECT * FROM improvement_signals WHERE session_id = ?")
      .all("sess-sig-001") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].consumed).toBe(0);
    expect(rows[0].signal_type).toBe("correction");
    expect(rows[0].mentioned_skill).toBe("Research");
    expect(rows[0].consumed_at).toBeNull();
    expect(rows[0].consumed_by_run).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateSignalConsumed tests
// ---------------------------------------------------------------------------

describe("updateSignalConsumed", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
    _setTestDb(db);
  });

  afterEach(() => {
    _setTestDb(null);
    db.close();
  });

  it("sets consumed=1 and consumed_at/consumed_by_run", () => {
    // Seed an unconsumed signal
    writeImprovementSignalToDb({
      timestamp: "2026-03-17T10:00:00Z",
      session_id: "sess-upd-001",
      query: "improve research",
      signal_type: "explicit_request",
      consumed: false,
    });

    const ok = updateSignalConsumed(
      "sess-upd-001",
      "improve research",
      "explicit_request",
      "run-abc",
    );
    expect(ok).toBe(true);

    const rows = db
      .query("SELECT * FROM improvement_signals WHERE session_id = ?")
      .all("sess-upd-001") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].consumed).toBe(1);
    expect(rows[0].consumed_by_run).toBe("run-abc");
    expect(rows[0].consumed_at).toBeTruthy();
    // consumed_at should be a valid ISO string
    expect(() => new Date(rows[0].consumed_at as string)).not.toThrow();
  });

  it("returns false when no rows were updated", () => {
    const ok = updateSignalConsumed(
      "sess-missing",
      "missing signal",
      "explicit_request",
      "run-noop",
    );

    expect(ok).toBe(false);
  });
});
