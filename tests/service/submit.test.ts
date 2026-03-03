import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../service/config.js";
import { handleSubmitRoute } from "../../service/routes/submit.js";
import { Store } from "../../service/storage/store.js";

const TEST_DB = join(import.meta.dir, "../../.test-data/test-submit.db");

describe("handleSubmitRoute", () => {
  let store: Store;
  const config = { ...loadConfig(), dbPath: TEST_DB };

  const validBundle = {
    schema_version: "1.1",
    skill_name: "test-skill",
    contributor_id: "test-uuid-1234",
    created_at: "2026-01-15T00:00:00Z",
    selftune_version: "0.1.4",
    agent_type: "claude_code",
    sanitization_level: "conservative",
    positive_queries: [{ query: "test query", invocation_type: "explicit", source: "skill_log" }],
    eval_entries: [{ query: "test", should_trigger: true }],
    grading_summary: { total_sessions: 10, graded_sessions: 10, average_pass_rate: 0.85, expectation_count: 20 },
    evolution_summary: null,
    session_metrics: { total_sessions: 10, avg_assistant_turns: 5, avg_tool_calls: 10, avg_errors: 0, top_tools: [] },
  };

  beforeAll(() => {
    if (existsSync(TEST_DB)) rmSync(TEST_DB);
    store = new Store(TEST_DB);
  });

  afterAll(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix);
    }
  });

  it("accepts valid submission with 201", async () => {
    const req = new Request("http://localhost/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBundle),
    });
    const res = await handleSubmitRoute(req, store, config);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("accepted");
    expect(body.skill_name).toBe("test-skill");
    expect(body.badge_url).toContain("/badge/test-skill");
  });

  it("rejects invalid JSON with 400", async () => {
    const req = new Request("http://localhost/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await handleSubmitRoute(req, store, config);
    expect(res.status).toBe(400);
  });

  it("rejects invalid bundle with 400", async () => {
    const req = new Request("http://localhost/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bad: "data" }),
    });
    const res = await handleSubmitRoute(req, store, config);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details.length).toBeGreaterThan(0);
  });

  it("triggers re-aggregation after submission", async () => {
    const agg = store.getAggregation("test-skill");
    expect(agg).not.toBeNull();
    expect(agg!.weighted_pass_rate).toBeCloseTo(0.85, 2);
  });
});
