import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { _setTestDb, openDb } from "../../cli/selftune/localdb/db.js";
import {
  getOrchestrateRuns,
  getOverviewPayload,
  getPendingProposals,
  getSkillReportPayload,
  getSkillsList,
  queryEvolutionAudit,
  queryEvolutionEvidence,
  queryImprovementSignals,
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "../../cli/selftune/localdb/queries.js";

// ---------------------------------------------------------------------------
// Helpers — seed via direct SQL (isolate reads from writes)
// ---------------------------------------------------------------------------

function seedSessionTelemetry(db: Database, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    session_id: "sess-001",
    timestamp: "2026-03-17T10:00:00Z",
    cwd: "/home/user/project",
    transcript_path: "/tmp/t.jsonl",
    tool_calls_json: JSON.stringify({ Read: 3, Bash: 2 }),
    total_tool_calls: 5,
    bash_commands_json: JSON.stringify(["git status"]),
    skills_triggered_json: JSON.stringify(["Research"]),
    skills_invoked_json: JSON.stringify(["Research"]),
    assistant_turns: 4,
    errors_encountered: 0,
    transcript_chars: 2000,
    last_user_query: "do research",
    source: "hook",
    input_tokens: 1000,
    output_tokens: 500,
    ...overrides,
  };
  db.run(
    `INSERT INTO session_telemetry
      (session_id, timestamp, cwd, transcript_path, tool_calls_json,
       total_tool_calls, bash_commands_json, skills_triggered_json,
       skills_invoked_json, assistant_turns, errors_encountered,
       transcript_chars, last_user_query, source, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      defaults.session_id,
      defaults.timestamp,
      defaults.cwd,
      defaults.transcript_path,
      defaults.tool_calls_json,
      defaults.total_tool_calls,
      defaults.bash_commands_json,
      defaults.skills_triggered_json,
      defaults.skills_invoked_json,
      defaults.assistant_turns,
      defaults.errors_encountered,
      defaults.transcript_chars,
      defaults.last_user_query,
      defaults.source,
      defaults.input_tokens,
      defaults.output_tokens,
    ],
  );
}

let _seedSkillCounter = 0;
function seedSkillUsage(db: Database, overrides: Record<string, unknown> = {}): void {
  _seedSkillCounter++;
  const defaults = {
    skill_invocation_id: `si-seed-${_seedSkillCounter}`,
    occurred_at: "2026-03-17T10:00:00Z",
    session_id: "sess-001",
    skill_name: "Research",
    skill_path: "/skills/Research/SKILL.md",
    skill_scope: null,
    query: "do research",
    triggered: 1,
    source: "hook",
    invocation_mode: null,
    confidence: null,
    tool_name: null,
    matched_prompt_id: null,
    agent_type: null,
    ...overrides,
  };
  // Override occurred_at with timestamp if provided in overrides for backward compat
  if (overrides.timestamp && !overrides.occurred_at) {
    defaults.occurred_at = overrides.timestamp as string;
  }
  // Ensure session stub for FK satisfaction
  db.run(
    `INSERT OR IGNORE INTO sessions (session_id, platform, schema_version, normalized_at)
     VALUES (?, ?, ?, ?)`,
    [defaults.session_id, "claude_code", "2.0", defaults.occurred_at],
  );
  db.run(
    `INSERT INTO skill_invocations
      (skill_invocation_id, session_id, occurred_at, skill_name, invocation_mode,
       triggered, confidence, tool_name, matched_prompt_id, agent_type,
       query, skill_path, skill_scope, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      defaults.skill_invocation_id,
      defaults.session_id,
      defaults.occurred_at,
      defaults.skill_name,
      defaults.invocation_mode,
      defaults.triggered,
      defaults.confidence,
      defaults.tool_name,
      defaults.matched_prompt_id,
      defaults.agent_type,
      defaults.query,
      defaults.skill_path,
      defaults.skill_scope,
      defaults.source,
    ],
  );
}

function seedEvolutionAudit(db: Database, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    timestamp: "2026-03-17T10:00:00Z",
    proposal_id: "prop-001",
    skill_name: "Research",
    action: "created",
    details: "Initial proposal",
    eval_snapshot_json: null,
    ...overrides,
  };
  db.run(
    `INSERT INTO evolution_audit
      (timestamp, proposal_id, skill_name, action, details, eval_snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      defaults.timestamp,
      defaults.proposal_id,
      defaults.skill_name,
      defaults.action,
      defaults.details,
      defaults.eval_snapshot_json,
    ],
  );
}

function seedEvolutionEvidence(db: Database, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    timestamp: "2026-03-17T10:00:00Z",
    proposal_id: "prop-001",
    skill_name: "Research",
    skill_path: "/skills/Research/SKILL.md",
    target: "description",
    stage: "validated",
    rationale: "Improves accuracy",
    confidence: 0.85,
    details: "Analysis details",
    original_text: "Old text",
    proposed_text: "New text",
    eval_set_json: JSON.stringify([{ query: "test", should_trigger: true }]),
    validation_json: JSON.stringify({ improved: true, net_change: 0.2 }),
    ...overrides,
  };
  db.run(
    `INSERT INTO evolution_evidence
      (timestamp, proposal_id, skill_name, skill_path, target, stage,
       rationale, confidence, details, original_text, proposed_text,
       eval_set_json, validation_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      defaults.timestamp,
      defaults.proposal_id,
      defaults.skill_name,
      defaults.skill_path,
      defaults.target,
      defaults.stage,
      defaults.rationale,
      defaults.confidence,
      defaults.details,
      defaults.original_text,
      defaults.proposed_text,
      defaults.eval_set_json,
      defaults.validation_json,
    ],
  );
}

function seedImprovementSignal(db: Database, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    timestamp: "2026-03-17T10:00:00Z",
    session_id: "sess-001",
    query: "fix research",
    signal_type: "correction",
    mentioned_skill: "Research",
    consumed: 0,
    consumed_at: null,
    consumed_by_run: null,
    ...overrides,
  };
  db.run(
    `INSERT INTO improvement_signals
      (timestamp, session_id, query, signal_type, mentioned_skill, consumed, consumed_at, consumed_by_run)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      defaults.timestamp,
      defaults.session_id,
      defaults.query,
      defaults.signal_type,
      defaults.mentioned_skill,
      defaults.consumed,
      defaults.consumed_at,
      defaults.consumed_by_run,
    ],
  );
}

function seedOrchestrateRun(db: Database, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    run_id: "run-001",
    timestamp: "2026-03-17T10:00:00Z",
    elapsed_ms: 30000,
    dry_run: 0,
    approval_mode: "auto",
    total_skills: 2,
    evaluated: 2,
    evolved: 1,
    deployed: 1,
    watched: 0,
    skipped: 1,
    skill_actions_json: JSON.stringify([
      { skill: "Research", action: "evolve", reason: "Low pass rate" },
    ]),
    ...overrides,
  };
  db.run(
    `INSERT INTO orchestrate_runs
      (run_id, timestamp, elapsed_ms, dry_run, approval_mode,
       total_skills, evaluated, evolved, deployed, watched, skipped,
       skill_actions_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      defaults.run_id,
      defaults.timestamp,
      defaults.elapsed_ms,
      defaults.dry_run,
      defaults.approval_mode,
      defaults.total_skills,
      defaults.evaluated,
      defaults.evolved,
      defaults.deployed,
      defaults.watched,
      defaults.skipped,
      defaults.skill_actions_json,
    ],
  );
}

function seedQuery(db: Database, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    timestamp: "2026-03-17T10:00:00Z",
    session_id: "sess-001",
    query: "how to test",
    source: "hook",
    ...overrides,
  };
  db.run(`INSERT INTO queries (timestamp, session_id, query, source) VALUES (?, ?, ?, ?)`, [
    defaults.timestamp,
    defaults.session_id,
    defaults.query,
    defaults.source,
  ]);
}

// ---------------------------------------------------------------------------
// querySessionTelemetry tests
// ---------------------------------------------------------------------------

describe("querySessionTelemetry", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns correct shape with parsed JSON fields", () => {
    seedSessionTelemetry(db);

    const results = querySessionTelemetry(db);
    expect(results).toHaveLength(1);

    const r = results[0];
    expect(r.session_id).toBe("sess-001");
    expect(r.tool_calls).toEqual({ Read: 3, Bash: 2 });
    expect(r.bash_commands).toEqual(["git status"]);
    expect(r.skills_triggered).toEqual(["Research"]);
    expect(r.skills_invoked).toEqual(["Research"]);
    expect(r.total_tool_calls).toBe(5);
    expect(r.assistant_turns).toBe(4);
    expect(r.input_tokens).toBe(1000);
    expect(r.output_tokens).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// querySkillUsageRecords tests
// ---------------------------------------------------------------------------

describe("querySkillUsageRecords", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("converts triggered integer to boolean", () => {
    seedSkillUsage(db, {
      triggered: 1,
      skill_name: "A",
      query: "q1",
      timestamp: "2026-03-17T10:00:00Z",
    });
    seedSkillUsage(db, {
      triggered: 0,
      skill_name: "B",
      query: "q2",
      timestamp: "2026-03-17T10:01:00Z",
    });

    const results = querySkillUsageRecords(db);
    expect(results).toHaveLength(2);

    // Ordered DESC by timestamp
    const first = results[0]; // B at 10:01
    const second = results[1]; // A at 10:00
    expect(first.triggered).toBe(false);
    expect(second.triggered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// queryQueryLog tests
// ---------------------------------------------------------------------------

describe("queryQueryLog", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns queries ordered DESC by timestamp", () => {
    seedQuery(db, { timestamp: "2026-03-17T09:00:00Z", query: "earlier" });
    seedQuery(db, { timestamp: "2026-03-17T11:00:00Z", query: "later" });

    const results = queryQueryLog(db);
    expect(results).toHaveLength(2);
    expect(results[0].query).toBe("later");
    expect(results[1].query).toBe("earlier");
  });
});

// ---------------------------------------------------------------------------
// queryEvolutionAudit tests
// ---------------------------------------------------------------------------

describe("queryEvolutionAudit", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns all entries when no skillName filter", () => {
    seedEvolutionAudit(db, {
      proposal_id: "p1",
      skill_name: "Research",
      timestamp: "2026-03-17T10:00:00Z",
    });
    seedEvolutionAudit(db, {
      proposal_id: "p2",
      skill_name: "Browser",
      timestamp: "2026-03-17T11:00:00Z",
    });

    const results = queryEvolutionAudit(db);
    expect(results).toHaveLength(2);
  });

  it("filters by skillName", () => {
    seedEvolutionAudit(db, {
      proposal_id: "p1",
      skill_name: "Research",
      timestamp: "2026-03-17T10:00:00Z",
    });
    seedEvolutionAudit(db, {
      proposal_id: "p2",
      skill_name: "Browser",
      timestamp: "2026-03-17T11:00:00Z",
    });

    const results = queryEvolutionAudit(db, "Research");
    expect(results).toHaveLength(1);
    expect(results[0].skill_name).toBe("Research");
  });

  it("parses eval_snapshot_json when present", () => {
    seedEvolutionAudit(db, {
      proposal_id: "p3",
      eval_snapshot_json: JSON.stringify({ pass_rate: 0.9 }),
      timestamp: "2026-03-17T12:00:00Z",
    });

    const results = queryEvolutionAudit(db);
    expect(results[0].eval_snapshot).toEqual({ pass_rate: 0.9 });
  });
});

// ---------------------------------------------------------------------------
// queryEvolutionEvidence tests
// ---------------------------------------------------------------------------

describe("queryEvolutionEvidence", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns all entries with parsed JSON fields", () => {
    seedEvolutionEvidence(db);

    const results = queryEvolutionEvidence(db);
    expect(results).toHaveLength(1);
    expect(results[0].eval_set).toEqual([{ query: "test", should_trigger: true }]);
    expect(results[0].validation).toEqual({ improved: true, net_change: 0.2 });
    expect(results[0].confidence).toBe(0.85);
  });

  it("filters by skillName", () => {
    seedEvolutionEvidence(db, {
      proposal_id: "p1",
      skill_name: "Research",
      timestamp: "2026-03-17T10:00:00Z",
    });
    seedEvolutionEvidence(db, {
      proposal_id: "p2",
      skill_name: "Browser",
      timestamp: "2026-03-17T11:00:00Z",
    });

    const results = queryEvolutionEvidence(db, "Browser");
    expect(results).toHaveLength(1);
    expect(results[0].skill_name).toBe("Browser");
  });
});

// ---------------------------------------------------------------------------
// queryImprovementSignals tests
// ---------------------------------------------------------------------------

describe("queryImprovementSignals", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns all signals with consumed boolean conversion", () => {
    seedImprovementSignal(db, { consumed: 0, session_id: "s1", timestamp: "2026-03-17T10:00:00Z" });
    seedImprovementSignal(db, {
      consumed: 1,
      session_id: "s2",
      query: "q2",
      signal_type: "explicit_request",
      timestamp: "2026-03-17T11:00:00Z",
      consumed_at: "2026-03-17T11:05:00Z",
      consumed_by_run: "run-x",
    });

    const results = queryImprovementSignals(db);
    expect(results).toHaveLength(2);

    // DESC order — s2 first
    expect(results[0].consumed).toBe(true);
    expect(results[0].consumed_at).toBe("2026-03-17T11:05:00Z");
    expect(results[1].consumed).toBe(false);
  });

  it("filters by consumed=false", () => {
    seedImprovementSignal(db, { consumed: 0, session_id: "s1", timestamp: "2026-03-17T10:00:00Z" });
    seedImprovementSignal(db, {
      consumed: 1,
      session_id: "s2",
      query: "q2",
      signal_type: "explicit_request",
      timestamp: "2026-03-17T11:00:00Z",
    });

    const results = queryImprovementSignals(db, false);
    expect(results).toHaveLength(1);
    expect(results[0].consumed).toBe(false);
  });

  it("filters by consumed=true", () => {
    seedImprovementSignal(db, { consumed: 0, session_id: "s1", timestamp: "2026-03-17T10:00:00Z" });
    seedImprovementSignal(db, {
      consumed: 1,
      session_id: "s2",
      query: "q2",
      signal_type: "explicit_request",
      timestamp: "2026-03-17T11:00:00Z",
    });

    const results = queryImprovementSignals(db, true);
    expect(results).toHaveLength(1);
    expect(results[0].consumed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getOrchestrateRuns tests
// ---------------------------------------------------------------------------

describe("getOrchestrateRuns", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns runs with parsed skill_actions and respects limit", () => {
    seedOrchestrateRun(db, { run_id: "r1", timestamp: "2026-03-17T10:00:00Z" });
    seedOrchestrateRun(db, { run_id: "r2", timestamp: "2026-03-17T11:00:00Z" });
    seedOrchestrateRun(db, { run_id: "r3", timestamp: "2026-03-17T12:00:00Z" });

    // Limit to 2
    const results = getOrchestrateRuns(db, 2);
    expect(results).toHaveLength(2);
    // DESC order
    expect(results[0].run_id).toBe("r3");
    expect(results[1].run_id).toBe("r2");

    // Verify parsed fields
    expect(results[0].dry_run).toBe(false);
    expect(results[0].skill_actions).toHaveLength(1);
    expect(results[0].skill_actions[0].skill).toBe("Research");
  });
});

// ---------------------------------------------------------------------------
// getOverviewPayload tests
// ---------------------------------------------------------------------------

describe("getOverviewPayload", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns counts, telemetry, skills, and evolution arrays", () => {
    seedSessionTelemetry(db, { session_id: "s1", timestamp: "2026-03-17T10:00:00Z" });
    seedSessionTelemetry(db, { session_id: "s2", timestamp: "2026-03-17T11:00:00Z" });
    seedSkillUsage(db, {
      skill_name: "Research",
      triggered: 1,
      session_id: "s1",
      query: "q1",
      timestamp: "2026-03-17T10:00:00Z",
    });
    seedSkillUsage(db, {
      skill_name: "Browser",
      triggered: 0,
      session_id: "s2",
      query: "q2",
      timestamp: "2026-03-17T11:00:00Z",
    });
    seedEvolutionAudit(db, {
      proposal_id: "p1",
      action: "created",
      timestamp: "2026-03-17T10:00:00Z",
    });

    const payload = getOverviewPayload(db);
    expect(payload.counts.telemetry).toBe(2);
    expect(payload.counts.skills).toBe(2);
    expect(payload.counts.evolution).toBe(1);
    expect(payload.telemetry).toHaveLength(2);
    expect(payload.skills).toHaveLength(2);
    expect(payload.evolution).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getSkillReportPayload tests
// ---------------------------------------------------------------------------

describe("getSkillReportPayload", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns usage stats, recent_invocations, and evidence for a skill", () => {
    seedSkillUsage(db, {
      skill_name: "Research",
      triggered: 1,
      session_id: "s1",
      query: "q1",
      timestamp: "2026-03-17T10:00:00Z",
    });
    seedSkillUsage(db, {
      skill_name: "Research",
      triggered: 0,
      session_id: "s2",
      query: "q2",
      timestamp: "2026-03-17T11:00:00Z",
    });
    seedEvolutionEvidence(db, { skill_name: "Research", proposal_id: "p1" });

    const report = getSkillReportPayload(db, "Research");
    expect(report.skill_name).toBe("Research");
    expect(report.usage.total_checks).toBe(2);
    expect(report.usage.triggered_count).toBe(1);
    expect(report.usage.pass_rate).toBe(0.5);
    expect(report.recent_invocations).toHaveLength(2);
    expect(report.recent_invocations[0].triggered).toBeDefined();
    expect(report.evidence).toHaveLength(1);
    expect(report.sessions_with_skill).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getSkillsList tests
// ---------------------------------------------------------------------------

describe("getSkillsList", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns aggregated stats per skill with has_evidence flag", () => {
    seedSkillUsage(db, {
      skill_name: "Research",
      triggered: 1,
      session_id: "s1",
      query: "q1",
      timestamp: "2026-03-17T10:00:00Z",
    });
    seedSkillUsage(db, {
      skill_name: "Research",
      triggered: 0,
      session_id: "s2",
      query: "q2",
      timestamp: "2026-03-17T11:00:00Z",
    });
    seedSkillUsage(db, {
      skill_name: "Browser",
      triggered: 1,
      session_id: "s1",
      query: "q3",
      timestamp: "2026-03-17T10:01:00Z",
    });
    seedEvolutionEvidence(db, { skill_name: "Research" });

    const list = getSkillsList(db);
    expect(list).toHaveLength(2);

    const research = list.find((s) => s.skill_name === "Research");
    expect(research).toBeDefined();
    expect(research?.total_checks).toBe(2);
    expect(research?.triggered_count).toBe(1);
    expect(research?.pass_rate).toBe(0.5);
    expect(research?.has_evidence).toBe(true);

    const browser = list.find((s) => s.skill_name === "Browser");
    expect(browser).toBeDefined();
    expect(browser?.total_checks).toBe(1);
    expect(browser?.has_evidence).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getPendingProposals tests
// ---------------------------------------------------------------------------

describe("getPendingProposals", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns only proposals without terminal action", () => {
    // Pending proposal: created + validated, no deploy/reject/rollback
    seedEvolutionAudit(db, {
      proposal_id: "p-pending",
      action: "created",
      timestamp: "2026-03-17T10:00:00Z",
      skill_name: "Research",
    });
    seedEvolutionAudit(db, {
      proposal_id: "p-pending",
      action: "validated",
      timestamp: "2026-03-17T10:05:00Z",
      skill_name: "Research",
    });

    // Deployed proposal: created + deployed (terminal)
    seedEvolutionAudit(db, {
      proposal_id: "p-deployed",
      action: "created",
      timestamp: "2026-03-17T11:00:00Z",
      skill_name: "Browser",
    });
    seedEvolutionAudit(db, {
      proposal_id: "p-deployed",
      action: "deployed",
      timestamp: "2026-03-17T11:05:00Z",
      skill_name: "Browser",
    });

    // Rejected proposal: created + rejected (terminal)
    seedEvolutionAudit(db, {
      proposal_id: "p-rejected",
      action: "created",
      timestamp: "2026-03-17T12:00:00Z",
      skill_name: "Debug",
    });
    seedEvolutionAudit(db, {
      proposal_id: "p-rejected",
      action: "rejected",
      timestamp: "2026-03-17T12:05:00Z",
      skill_name: "Debug",
    });

    const pending = getPendingProposals(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].proposal_id).toBe("p-pending");
    expect(pending[0].action).toBe("validated");
  });
});
