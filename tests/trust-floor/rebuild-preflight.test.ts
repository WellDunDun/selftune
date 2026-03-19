/**
 * Tests for the rebuild preflight guard in materializeFull.
 *
 * Verifies that materializeFull throws when SQLite has rows newer than
 * the corresponding JSONL file, unless `force` is set.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../cli/selftune/localdb/db.js";
import { materializeFull } from "../../cli/selftune/localdb/materialize.js";

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "selftune-preflight-"));
  return dir;
}

describe("rebuild preflight guard", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        /* best-effort */
      }
    }
    cleanups.length = 0;
  });

  it("throws when SQLite has newer evolution_audit rows than JSONL", () => {
    const tmp = makeTempDir();
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

    // Create empty JSONL files
    const auditLog = join(tmp, "evolution_audit_log.jsonl");
    const evidenceLog = join(tmp, "evolution_evidence_log.jsonl");
    const orchestrateLog = join(tmp, "orchestrate_runs.jsonl");
    const telemetryLog = join(tmp, "session_telemetry_log.jsonl");
    const canonicalLog = join(tmp, "canonical_telemetry_log.jsonl");

    writeFileSync(auditLog, "");
    writeFileSync(evidenceLog, "");
    writeFileSync(orchestrateLog, "");
    writeFileSync(telemetryLog, "");
    writeFileSync(canonicalLog, "");

    // Create in-memory DB and insert a row into evolution_audit
    const db = openDb(":memory:");

    db.run(
      `INSERT INTO evolution_audit (timestamp, proposal_id, skill_name, action, details)
       VALUES (?, ?, ?, ?, ?)`,
      ["2026-03-18T12:00:00Z", "prop-1", "test-skill", "created", "test details"],
    );

    // materializeFull should throw because SQLite has data JSONL doesn't
    expect(() =>
      materializeFull(db, {
        evolutionAuditPath: auditLog,
        evolutionEvidencePath: evidenceLog,
        orchestrateRunLogPath: orchestrateLog,
        telemetryLogPath: telemetryLog,
        canonicalLogPath: canonicalLog,
      }),
    ).toThrow(/Rebuild blocked/);

    db.close();
  });

  it("allows rebuild when force is set", () => {
    const tmp = makeTempDir();
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

    const auditLog = join(tmp, "evolution_audit_log.jsonl");
    const evidenceLog = join(tmp, "evolution_evidence_log.jsonl");
    const orchestrateLog = join(tmp, "orchestrate_runs.jsonl");
    const telemetryLog = join(tmp, "session_telemetry_log.jsonl");
    const canonicalLog = join(tmp, "canonical_telemetry_log.jsonl");

    writeFileSync(auditLog, "");
    writeFileSync(evidenceLog, "");
    writeFileSync(orchestrateLog, "");
    writeFileSync(telemetryLog, "");
    writeFileSync(canonicalLog, "");

    const db = openDb(":memory:");

    db.run(
      `INSERT INTO evolution_audit (timestamp, proposal_id, skill_name, action, details)
       VALUES (?, ?, ?, ?, ?)`,
      ["2026-03-18T12:00:00Z", "prop-1", "test-skill", "created", "test details"],
    );

    // Should NOT throw with force: true
    expect(() =>
      materializeFull(db, {
        force: true,
        evolutionAuditPath: auditLog,
        evolutionEvidencePath: evidenceLog,
        orchestrateRunLogPath: orchestrateLog,
        telemetryLogPath: telemetryLog,
        canonicalLogPath: canonicalLog,
      }),
    ).not.toThrow();

    db.close();
  });

  it("allows rebuild when SQLite tables are empty", () => {
    const tmp = makeTempDir();
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

    const auditLog = join(tmp, "evolution_audit_log.jsonl");
    const evidenceLog = join(tmp, "evolution_evidence_log.jsonl");
    const orchestrateLog = join(tmp, "orchestrate_runs.jsonl");
    const telemetryLog = join(tmp, "session_telemetry_log.jsonl");
    const canonicalLog = join(tmp, "canonical_telemetry_log.jsonl");

    writeFileSync(auditLog, "");
    writeFileSync(evidenceLog, "");
    writeFileSync(orchestrateLog, "");
    writeFileSync(telemetryLog, "");
    writeFileSync(canonicalLog, "");

    const db = openDb(":memory:");

    // No rows in any table — should not throw
    expect(() =>
      materializeFull(db, {
        evolutionAuditPath: auditLog,
        evolutionEvidencePath: evidenceLog,
        orchestrateRunLogPath: orchestrateLog,
        telemetryLogPath: telemetryLog,
        canonicalLogPath: canonicalLog,
      }),
    ).not.toThrow();

    db.close();
  });
});
