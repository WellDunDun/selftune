/**
 * Tests for evolution audit trail (TASK-06).
 *
 * Verifies appendAuditEntry, readAuditTrail, and getLastDeployedProposal
 * using in-memory SQLite databases for full isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendAuditEntry,
  getLastDeployedProposal,
  readAuditTrail,
} from "../../cli/selftune/evolution/audit.js";
import { _setTestDb, openDb } from "../../cli/selftune/localdb/db.js";
import type { EvolutionAuditEntry } from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let counter = 0;

function makeEntry(overrides: Partial<EvolutionAuditEntry> = {}): EvolutionAuditEntry {
  counter += 1;
  return {
    timestamp: `2026-02-28T12:${String(counter).padStart(2, "0")}:00Z`,
    proposal_id: "evo-pptx-001",
    action: "created",
    details: "Proposal created for pptx skill evolution",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  counter = 0;
  const testDb = openDb(":memory:");
  _setTestDb(testDb);
});

afterEach(() => {
  _setTestDb(null);
});

// ---------------------------------------------------------------------------
// appendAuditEntry
// ---------------------------------------------------------------------------

describe("appendAuditEntry", () => {
  test("writes entry to SQLite", () => {
    const entry = makeEntry();
    appendAuditEntry(entry);

    const entries = readAuditTrail();
    expect(entries).toHaveLength(1);
    expect(entries[0].proposal_id).toBe("evo-pptx-001");
    expect(entries[0].action).toBe("created");
    expect(entries[0].details).toBe("Proposal created for pptx skill evolution");
  });
});

// ---------------------------------------------------------------------------
// readAuditTrail
// ---------------------------------------------------------------------------

describe("readAuditTrail", () => {
  test("reads all entries", () => {
    appendAuditEntry(makeEntry({ proposal_id: "evo-001" }));
    appendAuditEntry(makeEntry({ proposal_id: "evo-002" }));
    appendAuditEntry(makeEntry({ proposal_id: "evo-003" }));

    const entries = readAuditTrail();
    expect(entries).toHaveLength(3);
  });

  test("filters by skill name in details (case-insensitive)", () => {
    appendAuditEntry(
      makeEntry({ proposal_id: "evo-001", details: "Proposal for pptx skill improvement" }),
    );
    appendAuditEntry(
      makeEntry({ proposal_id: "evo-002", details: "Proposal for csv-parser skill fix" }),
    );
    appendAuditEntry(makeEntry({ proposal_id: "evo-003", details: "Another PPTX evolution step" }));

    const pptxEntries = readAuditTrail("pptx");
    expect(pptxEntries).toHaveLength(2);

    const csvEntries = readAuditTrail("csv-parser");
    expect(csvEntries).toHaveLength(1);
  });

  test("returns empty array for empty database (no crash)", () => {
    const entries = readAuditTrail();
    expect(entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getLastDeployedProposal
// ---------------------------------------------------------------------------

describe("getLastDeployedProposal", () => {
  test("returns most recent deployed entry for a skill", () => {
    appendAuditEntry(
      makeEntry({
        action: "created",
        details: "Proposal created for pptx skill",
        timestamp: "2026-02-28T10:00:00Z",
      }),
    );
    appendAuditEntry(
      makeEntry({
        action: "deployed",
        proposal_id: "evo-pptx-001",
        details: "Deployed first version of pptx evolution",
        timestamp: "2026-02-28T11:00:00Z",
      }),
    );
    appendAuditEntry(
      makeEntry({
        action: "deployed",
        proposal_id: "evo-pptx-002",
        details: "Deployed second version of pptx evolution",
        timestamp: "2026-02-28T12:00:00Z",
      }),
    );

    const result = getLastDeployedProposal("pptx");
    expect(result).not.toBeNull();
    expect(result?.proposal_id).toBe("evo-pptx-002");
    expect(result?.action).toBe("deployed");
    expect(result?.timestamp).toBe("2026-02-28T12:00:00Z");
  });

  test("returns null when no deployed entries exist", () => {
    appendAuditEntry(
      makeEntry({
        action: "created",
        details: "Proposal created for pptx skill",
      }),
    );
    appendAuditEntry(
      makeEntry({
        action: "validated",
        details: "Validated pptx proposal",
      }),
    );

    const result = getLastDeployedProposal("pptx");
    expect(result).toBeNull();
  });

  test("returns null for empty database", () => {
    const result = getLastDeployedProposal("pptx");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mixed scenarios
// ---------------------------------------------------------------------------

describe("mixed action filtering", () => {
  test("multiple entries with different actions, correct filtering", () => {
    appendAuditEntry(
      makeEntry({
        proposal_id: "evo-pptx-001",
        action: "created",
        details: "Created proposal for pptx",
      }),
    );
    appendAuditEntry(
      makeEntry({
        proposal_id: "evo-csv-001",
        action: "created",
        details: "Created proposal for csv-parser",
      }),
    );
    appendAuditEntry(
      makeEntry({
        proposal_id: "evo-pptx-001",
        action: "validated",
        details: "Validated pptx proposal",
      }),
    );
    appendAuditEntry(
      makeEntry({
        proposal_id: "evo-pptx-001",
        action: "deployed",
        details: "Deployed pptx proposal",
      }),
    );
    appendAuditEntry(
      makeEntry({
        proposal_id: "evo-csv-001",
        action: "rejected",
        details: "Rejected csv-parser proposal",
      }),
    );

    // All entries
    const all = readAuditTrail();
    expect(all).toHaveLength(5);

    // pptx entries only
    const pptx = readAuditTrail("pptx");
    expect(pptx).toHaveLength(3);

    // csv entries only
    const csv = readAuditTrail("csv-parser");
    expect(csv).toHaveLength(2);

    // Last deployed for pptx
    const deployed = getLastDeployedProposal("pptx");
    expect(deployed).not.toBeNull();
    expect(deployed?.proposal_id).toBe("evo-pptx-001");
    expect(deployed?.action).toBe("deployed");

    // No deployed for csv-parser (it was rejected, not deployed)
    const csvDeployed = getLastDeployedProposal("csv-parser");
    expect(csvDeployed).toBeNull();
  });
});
