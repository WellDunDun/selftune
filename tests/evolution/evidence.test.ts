import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { appendEvidenceEntry, readEvidenceTrail } from "../../cli/selftune/evolution/evidence.js";
import { _setTestDb, openDb } from "../../cli/selftune/localdb/db.js";
import type { EvolutionEvidenceEntry } from "../../cli/selftune/types.js";

let counter = 0;

beforeEach(() => {
  counter = 0;
  const testDb = openDb(":memory:");
  _setTestDb(testDb);
});

afterEach(() => {
  _setTestDb(null); // also closes previous DB via _setTestDb
});

function makeEntry(overrides: Partial<EvolutionEvidenceEntry> = {}): EvolutionEvidenceEntry {
  counter += 1;
  return {
    timestamp: `2026-03-09T12:${String(counter).padStart(2, "0")}:00Z`,
    proposal_id: "evo-test-001",
    skill_name: "test-skill",
    skill_path: "/tmp/test-skill/SKILL.md",
    target: "description",
    stage: "created",
    rationale: "Add broader trigger coverage",
    original_text: "Old description",
    proposed_text: "New description",
    eval_set: [{ query: "test query", should_trigger: true }],
    ...overrides,
  };
}

describe("evidence trail", () => {
  test("appends and reads evidence entries", () => {
    appendEvidenceEntry(makeEntry());
    appendEvidenceEntry(makeEntry({ proposal_id: "evo-test-002", stage: "validated" }));

    const entries = readEvidenceTrail();
    expect(entries).toHaveLength(2);
    // DESC order from SQLite — newest first
    expect(entries[0].proposal_id).toBe("evo-test-002");
    expect(entries[0].stage).toBe("validated");
    expect(entries[1].proposal_id).toBe("evo-test-001");
  });

  test("filters by exact skill name", () => {
    appendEvidenceEntry(makeEntry({ skill_name: "skill-a" }));
    appendEvidenceEntry(makeEntry({ proposal_id: "evo-test-002", skill_name: "skill-b" }));

    const filtered = readEvidenceTrail("skill-b");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].skill_name).toBe("skill-b");
  });

  test("returns empty when the database has no evidence entries", () => {
    expect(readEvidenceTrail()).toEqual([]);
  });

  test("handles multiple entries with same proposal_id but different stages", () => {
    appendEvidenceEntry(makeEntry({ stage: "created" }));
    appendEvidenceEntry(makeEntry({ stage: "validated" }));
    appendEvidenceEntry(makeEntry({ stage: "deployed" }));

    const entries = readEvidenceTrail();
    expect(entries).toHaveLength(3);
  });
});
