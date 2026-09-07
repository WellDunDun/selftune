import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolveOrchestrateRuntime } from "@selftune/orchestration/orchestrate/runtime";
import { readPendingSignals } from "@selftune/orchestration/orchestrate/signals";
import { appendEvidenceEntry, readEvidenceTrail } from "@selftune/runtime/evolution/evidence";
import { _setTestDb, getDb, openDb } from "@selftune/runtime/localdb/db";

beforeEach(() => _setTestDb(openDb(":memory:")));
afterEach(() => _setTestDb(null));

test("orchestration retains valid audit entries with damaged optional evidence", async () => {
  getDb()
    .run(`INSERT INTO evolution_audit (timestamp, proposal_id, skill_name, action, details, eval_snapshot_json)
    VALUES ('2026-09-07T00:00:00Z', 'valid', 'research', 'deployed', 'Deployed research', '42'),
           ('2026-09-07T00:00:01Z', 'invalid', 'research', 'unknown-action', '', '{}')`);
  const runtime = await resolveOrchestrateRuntime();
  const entries = runtime.readAuditEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ proposal_id: "valid", action: "deployed" });
  expect(entries[0]).not.toHaveProperty("eval_snapshot");
});

test("pending signals reject unknown kinds while retaining valid unconsumed rows", () => {
  getDb().run(`INSERT INTO improvement_signals (timestamp, session_id, query, signal_type, consumed)
    VALUES ('2026-09-07T00:00:00Z', 'valid', 'Please correct this', 'correction', 0),
           ('2026-09-07T00:00:01Z', 'invalid', 'Unrecognized signal', 'unknown-kind', 0),
           ('2026-09-07T00:00:02Z', 'consumed', 'Already handled', 'correction', 1)`);
  expect(readPendingSignals().map((signal) => signal.session_id)).toEqual(["valid"]);
});

test("evidence reads discard malformed optional artifacts without losing the proposal", () => {
  appendEvidenceEntry({
    timestamp: "2026-09-07T00:00:00Z",
    proposal_id: "valid",
    skill_name: "research",
    skill_path: "/skills/research/SKILL.md",
    target: "body",
    stage: "created",
  });
  getDb().run("UPDATE evolution_evidence SET eval_set_json = ?, validation_json = ?", [
    "[42]",
    '"broken"',
  ]);
  const entries = readEvidenceTrail();
  expect(entries).toHaveLength(1);
  expect(entries[0].proposal_id).toBe("valid");
  expect(entries[0].eval_set).toEqual([]);
  expect(entries[0]).not.toHaveProperty("validation");
});
