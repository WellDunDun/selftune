/**
 * Tests for evolution audit trail (TASK-06).
 *
 * Verifies appendAuditEntry, readAuditTrail, and getLastDeployedProposal
 * using temp files for full isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAuditEntry,
  getLastDeployedProposal,
  readAuditTrail,
} from "../../cli/selftune/evolution/audit.js";
import type { EvolutionAuditEntry } from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<EvolutionAuditEntry> = {}): EvolutionAuditEntry {
  return {
    timestamp: "2026-02-28T12:00:00Z",
    proposal_id: "evo-pptx-001",
    action: "created",
    details: "Proposal created for pptx skill evolution",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-audit-test-"));
  logPath = join(tmpDir, "evolution_audit_log.jsonl");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// appendAuditEntry
// ---------------------------------------------------------------------------

describe("appendAuditEntry", () => {
  test("writes entry as JSONL to temp file", () => {
    const entry = makeEntry();
    appendAuditEntry(entry, logPath);

    const content = readFileSync(logPath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.proposal_id).toBe("evo-pptx-001");
    expect(parsed.action).toBe("created");
    expect(parsed.details).toBe("Proposal created for pptx skill evolution");
  });

  test("creates parent directory if needed", () => {
    const nestedPath = join(tmpDir, "nested", "deep", "audit.jsonl");
    const entry = makeEntry();
    appendAuditEntry(entry, nestedPath);

    const content = readFileSync(nestedPath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.proposal_id).toBe("evo-pptx-001");
  });
});

// ---------------------------------------------------------------------------
// readAuditTrail
// ---------------------------------------------------------------------------

describe("readAuditTrail", () => {
  test("reads all entries from file", () => {
    appendAuditEntry(makeEntry({ proposal_id: "evo-001" }), logPath);
    appendAuditEntry(makeEntry({ proposal_id: "evo-002" }), logPath);
    appendAuditEntry(makeEntry({ proposal_id: "evo-003" }), logPath);

    const entries = readAuditTrail(undefined, logPath);
    expect(entries).toHaveLength(3);
    expect(entries[0].proposal_id).toBe("evo-001");
    expect(entries[2].proposal_id).toBe("evo-003");
  });

  test("filters by skill name in details (case-insensitive)", () => {
    appendAuditEntry(makeEntry({ details: "Proposal for pptx skill improvement" }), logPath);
    appendAuditEntry(makeEntry({ details: "Proposal for csv-parser skill fix" }), logPath);
    appendAuditEntry(makeEntry({ details: "Another PPTX evolution step" }), logPath);

    const pptxEntries = readAuditTrail("pptx", logPath);
    expect(pptxEntries).toHaveLength(2);

    const csvEntries = readAuditTrail("csv-parser", logPath);
    expect(csvEntries).toHaveLength(1);
  });

  test("returns empty array for missing log file (no crash)", () => {
    const missing = join(tmpDir, "does_not_exist.jsonl");
    const entries = readAuditTrail(undefined, missing);
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
      logPath,
    );
    appendAuditEntry(
      makeEntry({
        action: "deployed",
        proposal_id: "evo-pptx-001",
        details: "Deployed first version of pptx evolution",
        timestamp: "2026-02-28T11:00:00Z",
      }),
      logPath,
    );
    appendAuditEntry(
      makeEntry({
        action: "deployed",
        proposal_id: "evo-pptx-002",
        details: "Deployed second version of pptx evolution",
        timestamp: "2026-02-28T12:00:00Z",
      }),
      logPath,
    );

    const result = getLastDeployedProposal("pptx", logPath);
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
      logPath,
    );
    appendAuditEntry(
      makeEntry({
        action: "validated",
        details: "Validated pptx proposal",
      }),
      logPath,
    );

    const result = getLastDeployedProposal("pptx", logPath);
    expect(result).toBeNull();
  });

  test("returns null for missing log file", () => {
    const missing = join(tmpDir, "nope.jsonl");
    const result = getLastDeployedProposal("pptx", missing);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mixed scenarios
// ---------------------------------------------------------------------------

describe("mixed action filtering", () => {
  test("multiple entries with different actions, correct filtering", () => {
    // Seed entries for two different skills with various actions
    appendAuditEntry(
      makeEntry({
        proposal_id: "evo-pptx-001",
        action: "created",
        details: "Created proposal for pptx",
      }),
      logPath,
    );
    appendAuditEntry(
      makeEntry({
        proposal_id: "evo-csv-001",
        action: "created",
        details: "Created proposal for csv-parser",
      }),
      logPath,
    );
    appendAuditEntry(
      makeEntry({
        proposal_id: "evo-pptx-001",
        action: "validated",
        details: "Validated pptx proposal",
      }),
      logPath,
    );
    appendAuditEntry(
      makeEntry({
        proposal_id: "evo-pptx-001",
        action: "deployed",
        details: "Deployed pptx proposal",
      }),
      logPath,
    );
    appendAuditEntry(
      makeEntry({
        proposal_id: "evo-csv-001",
        action: "rejected",
        details: "Rejected csv-parser proposal",
      }),
      logPath,
    );

    // All entries
    const all = readAuditTrail(undefined, logPath);
    expect(all).toHaveLength(5);

    // pptx entries only
    const pptx = readAuditTrail("pptx", logPath);
    expect(pptx).toHaveLength(3);

    // csv entries only
    const csv = readAuditTrail("csv-parser", logPath);
    expect(csv).toHaveLength(2);

    // Last deployed for pptx
    const deployed = getLastDeployedProposal("pptx", logPath);
    expect(deployed).not.toBeNull();
    expect(deployed?.proposal_id).toBe("evo-pptx-001");
    expect(deployed?.action).toBe("deployed");

    // No deployed for csv-parser (it was rejected, not deployed)
    const csvDeployed = getLastDeployedProposal("csv-parser", logPath);
    expect(csvDeployed).toBeNull();
  });
});
