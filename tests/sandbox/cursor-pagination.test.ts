/**
 * Tests for cursor-based pagination on dashboard queries.
 *
 * Covers: PaginationCursor, PaginatedResult types in dashboard-contract.ts,
 * getOverviewPayloadPaginated and getSkillReportPayloadPaginated in queries.ts
 */

import type { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach } from "bun:test";

import { openDb } from "../../cli/selftune/localdb/db.js";
import {
  getOverviewPayloadPaginated,
  getSkillReportPayloadPaginated,
} from "../../cli/selftune/localdb/queries.js";

function seedTelemetry(db: Database, count: number): void {
  const stmt = db.prepare(
    `INSERT INTO session_telemetry (session_id, timestamp, cwd, transcript_path, total_tool_calls, errors_encountered, skills_triggered_json, assistant_turns, transcript_chars)
     VALUES (?, ?, '/tmp', '/tmp/t', 5, 0, '[]', 3, 100)`,
  );
  for (let i = 0; i < count; i++) {
    const ts = new Date(Date.now() - (count - i) * 60_000).toISOString();
    stmt.run(`session-${String(i).padStart(4, "0")}`, ts);
  }
}

function seedSessions(db: Database, count: number): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO sessions (session_id, started_at) VALUES (?, ?)`);
  for (let i = 0; i < count; i++) {
    const ts = new Date(Date.now() - (count - i) * 60_000).toISOString();
    stmt.run(`session-${String(i).padStart(4, "0")}`, ts);
  }
}

function seedSkillInvocations(
  db: Database,
  count: number,
  skillName = "test-skill",
  idPrefix = "inv",
): void {
  seedSessions(db, count);
  const stmt = db.prepare(
    `INSERT INTO skill_invocations (skill_invocation_id, session_id, occurred_at, skill_name, triggered, query, skill_path, source)
     VALUES (?, ?, ?, ?, ?, ?, '/skills/test', 'hook')`,
  );
  for (let i = 0; i < count; i++) {
    const ts = new Date(Date.now() - (count - i) * 60_000).toISOString();
    stmt.run(
      `${idPrefix}-${String(i).padStart(4, "0")}`,
      `session-${String(i).padStart(4, "0")}`,
      ts,
      skillName,
      i % 3 === 0 ? 1 : 0,
      `query number ${i}`,
    );
  }
}

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

// ---------------------------------------------------------------------------
// Overview paginated telemetry
// ---------------------------------------------------------------------------
describe("getOverviewPayloadPaginated — telemetry cursor", () => {
  it("returns first page with next_cursor when more exist", () => {
    seedTelemetry(db, 10);
    const result = getOverviewPayloadPaginated(db, {
      telemetry_limit: 3,
    });
    expect(result.telemetry_page.items).toHaveLength(3);
    expect(result.telemetry_page.has_more).toBe(true);
    expect(result.telemetry_page.next_cursor).not.toBeNull();
  });

  it("returns subsequent page with cursor", () => {
    seedTelemetry(db, 10);
    const first = getOverviewPayloadPaginated(db, {
      telemetry_limit: 3,
    });
    expect(first.telemetry_page.next_cursor).not.toBeNull();
    const cursor = first.telemetry_page.next_cursor;
    if (!cursor) {
      throw new Error("expected telemetry cursor");
    }
    const second = getOverviewPayloadPaginated(db, {
      telemetry_limit: 3,
      telemetry_cursor: cursor,
    });
    expect(second.telemetry_page.items).toHaveLength(3);
    // Items should not overlap with first page
    const firstIds = new Set(first.telemetry_page.items.map((i) => i.session_id));
    for (const item of second.telemetry_page.items) {
      expect(firstIds.has(item.session_id)).toBe(false);
    }
  });

  it("last page has has_more=false and null cursor", () => {
    seedTelemetry(db, 5);
    const first = getOverviewPayloadPaginated(db, {
      telemetry_limit: 3,
    });
    expect(first.telemetry_page.next_cursor).not.toBeNull();
    const cursor = first.telemetry_page.next_cursor;
    if (!cursor) {
      throw new Error("expected telemetry cursor");
    }
    const second = getOverviewPayloadPaginated(db, {
      telemetry_limit: 3,
      telemetry_cursor: cursor,
    });
    expect(second.telemetry_page.items).toHaveLength(2);
    expect(second.telemetry_page.has_more).toBe(false);
    expect(second.telemetry_page.next_cursor).toBeNull();
  });

  it("default behavior (no cursor) returns items up to limit", () => {
    seedTelemetry(db, 5);
    const result = getOverviewPayloadPaginated(db, {
      telemetry_limit: 10,
    });
    expect(result.telemetry_page.items).toHaveLength(5);
    expect(result.telemetry_page.has_more).toBe(false);
    expect(result.telemetry_page.next_cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Overview paginated skill invocations
// ---------------------------------------------------------------------------
describe("getOverviewPayloadPaginated — skills cursor", () => {
  it("returns first page with next_cursor when more exist", () => {
    seedSkillInvocations(db, 10);
    const result = getOverviewPayloadPaginated(db, {
      skills_limit: 4,
    });
    expect(result.skills_page.items).toHaveLength(4);
    expect(result.skills_page.has_more).toBe(true);
    expect(result.skills_page.next_cursor).not.toBeNull();
  });

  it("paginates through all skill invocations without overlap", () => {
    seedSkillInvocations(db, 10);
    const first = getOverviewPayloadPaginated(db, { skills_limit: 4 });
    expect(first.skills_page.next_cursor).not.toBeNull();
    const firstCursor = first.skills_page.next_cursor;
    if (!firstCursor) {
      throw new Error("expected first skills cursor");
    }
    const second = getOverviewPayloadPaginated(db, {
      skills_limit: 4,
      skills_cursor: firstCursor,
    });
    expect(second.skills_page.next_cursor).not.toBeNull();
    const secondCursor = second.skills_page.next_cursor;
    if (!secondCursor) {
      throw new Error("expected second skills cursor");
    }
    const third = getOverviewPayloadPaginated(db, {
      skills_limit: 4,
      skills_cursor: secondCursor,
    });

    expect(first.skills_page.items).toHaveLength(4);
    expect(second.skills_page.items).toHaveLength(4);
    expect(third.skills_page.items).toHaveLength(2);
    expect(third.skills_page.has_more).toBe(false);
    expect(third.skills_page.next_cursor).toBeNull();

    // Verify no duplicates across pages
    const allIds = [
      ...first.skills_page.items,
      ...second.skills_page.items,
      ...third.skills_page.items,
    ].map((i) => i.session_id + i.timestamp);
    expect(new Set(allIds).size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Skill report paginated invocations
// ---------------------------------------------------------------------------
describe("getSkillReportPayloadPaginated — invocations cursor", () => {
  it("returns first page with next_cursor when more exist", () => {
    seedSkillInvocations(db, 15, "my-skill");
    const result = getSkillReportPayloadPaginated(db, "my-skill", {
      invocations_limit: 5,
    });
    expect(result.invocations_page.items).toHaveLength(5);
    expect(result.invocations_page.has_more).toBe(true);
    expect(result.invocations_page.next_cursor).not.toBeNull();
  });

  it("returns subsequent page using cursor", () => {
    seedSkillInvocations(db, 15, "my-skill");
    const first = getSkillReportPayloadPaginated(db, "my-skill", {
      invocations_limit: 5,
    });
    expect(first.invocations_page.next_cursor).not.toBeNull();
    const cursor = first.invocations_page.next_cursor;
    if (!cursor) {
      throw new Error("expected invocations cursor");
    }
    const second = getSkillReportPayloadPaginated(db, "my-skill", {
      invocations_limit: 5,
      invocations_cursor: cursor,
    });
    expect(second.invocations_page.items).toHaveLength(5);
    // No overlap
    const firstTimestamps = new Set(first.invocations_page.items.map((i) => i.timestamp));
    for (const item of second.invocations_page.items) {
      expect(firstTimestamps.has(item.timestamp)).toBe(false);
    }
  });

  it("last page has has_more=false and null cursor", () => {
    seedSkillInvocations(db, 7, "my-skill");
    const first = getSkillReportPayloadPaginated(db, "my-skill", {
      invocations_limit: 5,
    });
    expect(first.invocations_page.next_cursor).not.toBeNull();
    const cursor = first.invocations_page.next_cursor;
    if (!cursor) {
      throw new Error("expected invocations cursor");
    }
    const second = getSkillReportPayloadPaginated(db, "my-skill", {
      invocations_limit: 5,
      invocations_cursor: cursor,
    });
    expect(second.invocations_page.items).toHaveLength(2);
    expect(second.invocations_page.has_more).toBe(false);
    expect(second.invocations_page.next_cursor).toBeNull();
  });

  it("default behavior (no cursor) returns items up to limit", () => {
    seedSkillInvocations(db, 3, "my-skill");
    const result = getSkillReportPayloadPaginated(db, "my-skill", {
      invocations_limit: 10,
    });
    expect(result.invocations_page.items).toHaveLength(3);
    expect(result.invocations_page.has_more).toBe(false);
    expect(result.invocations_page.next_cursor).toBeNull();
  });

  it("filters by skill name and does not return other skills", () => {
    seedSkillInvocations(db, 5, "my-skill", "inv-a");
    seedSkillInvocations(db, 5, "other-skill", "inv-b");
    const result = getSkillReportPayloadPaginated(db, "my-skill", {
      invocations_limit: 100,
    });
    expect(result.invocations_page.items).toHaveLength(5);
    expect(result.invocations_page.has_more).toBe(false);
  });
});
