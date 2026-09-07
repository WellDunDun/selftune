import { expect, test } from "bun:test";
import { createAuditEntry } from "../../packages/runtime/evolution/evolve/output.js";

test("audit output omits absent optional evidence instead of creating undefined fields", () => {
  const entry = createAuditEntry("proposal", "created", "Created");
  expect(Object.keys(entry).sort()).toEqual(["action", "details", "proposal_id", "timestamp"]);
  const empty = createAuditEntry("proposal", "created", "Created", undefined, "", undefined, {
    validation_agent: "",
    validation_fixture_id: "",
    validation_evidence_ref: "",
  });
  expect(Object.keys(empty).sort()).toEqual(Object.keys(entry).sort());
});

test("audit output preserves measured zero values and complete validation provenance", () => {
  const snapshot = { total: 0, passed: 0, failed: 0, pass_rate: 0 };
  const entry = createAuditEntry("proposal", "validated", "Validated", snapshot, "research", 0, {
    validation_mode: "host_replay",
    validation_agent: "codex",
    validation_fixture_id: "fixture",
    validation_evidence_ref: "evidence",
  });
  expect(entry).toMatchObject({
    skill_name: "research",
    eval_snapshot: snapshot,
    iterations_used: 0,
    validation_mode: "host_replay",
    validation_agent: "codex",
    validation_fixture_id: "fixture",
    validation_evidence_ref: "evidence",
  });
});
