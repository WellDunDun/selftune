import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvidenceEntry, readEvidenceTrail } from "../../cli/selftune/evolution/evidence.js";
import type { EvolutionEvidenceEntry } from "../../cli/selftune/types.js";

let tempDir = "";

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

function makeEntry(overrides: Partial<EvolutionEvidenceEntry> = {}): EvolutionEvidenceEntry {
  return {
    timestamp: "2026-03-09T12:00:00Z",
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
    tempDir = mkdtempSync(join(tmpdir(), "selftune-evidence-test-"));
    const logPath = join(tempDir, "evidence.jsonl");

    appendEvidenceEntry(makeEntry(), logPath);
    appendEvidenceEntry(makeEntry({ proposal_id: "evo-test-002", stage: "validated" }), logPath);

    const entries = readEvidenceTrail(undefined, logPath);
    expect(entries).toHaveLength(2);
    expect(entries[0].proposal_id).toBe("evo-test-001");
    expect(entries[1].stage).toBe("validated");
  });

  test("filters by exact skill name", () => {
    tempDir = mkdtempSync(join(tmpdir(), "selftune-evidence-test-"));
    const logPath = join(tempDir, "evidence.jsonl");

    appendEvidenceEntry(makeEntry({ skill_name: "skill-a" }), logPath);
    appendEvidenceEntry(makeEntry({ proposal_id: "evo-test-002", skill_name: "skill-b" }), logPath);

    const filtered = readEvidenceTrail("skill-b", logPath);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].skill_name).toBe("skill-b");
  });

  test("returns empty when the evidence log does not exist", () => {
    tempDir = mkdtempSync(join(tmpdir(), "selftune-evidence-test-"));
    const logPath = join(tempDir, "missing.jsonl");

    expect(readEvidenceTrail(undefined, logPath)).toEqual([]);
  });

  test("skips malformed JSONL entries while preserving valid evidence", () => {
    tempDir = mkdtempSync(join(tmpdir(), "selftune-evidence-test-"));
    const logPath = join(tempDir, "evidence.jsonl");

    writeFileSync(
      logPath,
      `${JSON.stringify(makeEntry())}\n{"malformed"\n${JSON.stringify(makeEntry({ proposal_id: "evo-test-002" }))}\n`,
      "utf-8",
    );

    const entries = readEvidenceTrail(undefined, logPath);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.proposal_id)).toEqual(["evo-test-001", "evo-test-002"]);
  });
});
