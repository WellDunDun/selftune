import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openDb } from "../../packages/runtime/localdb/db";
import {
  getSkillReportPayload,
  queryEvolutionEvidence,
} from "../../packages/runtime/localdb/queries";

describe("dashboard evidence projection", () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  function seed(validationJson: string | null, evalSetJson = "[]") {
    db.run(
      `INSERT INTO evolution_evidence
      (timestamp, proposal_id, skill_name, skill_path, target, stage, validation_json, eval_set_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "2026-09-05T00:00:00Z",
        "proposal",
        "marketing",
        "/skills/marketing/SKILL.md",
        "description",
        "validated",
        validationJson,
        evalSetJson,
      ],
    );
  }

  it("normalizes historical display rows without changing stored or exported evidence", () => {
    const original = { improved: true, regressions: ["old query"], custom_metric: { score: 12 } };
    const serialized = JSON.stringify(original);
    seed(serialized, '[{"prompt":"old prompt","result":false}]');
    const evidence = getSkillReportPayload(db, "marketing").evidence[0];
    expect(evidence.validation?.regressions).toEqual([{ query: "old query" }]);
    expect(evidence.eval_set).toEqual([{ prompt: "old prompt", result: false }]);
    expect(evidence.evidence_error).toBeUndefined();
    expect(queryEvolutionEvidence(db, "marketing")[0].validation).toEqual(original);
    expect(
      db
        .query<{ validation_json: string }, []>("SELECT validation_json FROM evolution_evidence")
        .get()?.validation_json,
    ).toBe(serialized);
  });

  it.each(["{", '{"after_pass_rate":"bad"}', "[]"])(
    "reports malformed validation %s while retaining the row and source bytes",
    (json) => {
      seed(json);
      const evidence = getSkillReportPayload(db, "marketing").evidence[0];
      expect(evidence.proposal_id).toBe("proposal");
      expect(evidence.validation).toBeNull();
      expect(evidence.evidence_error).toContain("original evidence is still stored locally");
      expect(
        db
          .query<{ validation_json: string }, []>("SELECT validation_json FROM evolution_evidence")
          .get()?.validation_json,
      ).toBe(json);
    },
  );

  it("distinguishes absent validation from an unreadable eval set", () => {
    seed(null, '[{"query":{}}]');
    const evidence = getSkillReportPayload(db, "marketing").evidence[0];
    expect(evidence.validation).toBeNull();
    expect(evidence.eval_set).toEqual([]);
    expect(evidence.evidence_error).toBeDefined();
  });

  it("returns numeric zero counts for an evidence-only skill", () => {
    seed(null);
    const report = getSkillReportPayload(db, "marketing");
    expect(report.usage).toEqual({ total_checks: 0, triggered_count: 0, pass_rate: 0 });
    expect(report.sessions_with_skill).toBe(0);
    expect(report.evidence[0].evidence_error).toBeUndefined();
  });
});
