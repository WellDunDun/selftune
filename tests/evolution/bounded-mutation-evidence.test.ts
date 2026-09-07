import { afterEach, beforeEach, expect, test } from "bun:test";

import { extractMutationWeaknesses } from "../../packages/runtime/evolution/bounded-mutations.js";
import { openDb } from "../../packages/runtime/localdb/db.js";

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb(":memory:");
});
afterEach(() => {
  db.close();
});

function seedEvidence(saved: string, proposalId = "proposal-1") {
  db.run(
    `INSERT INTO evolution_evidence (timestamp, proposal_id, skill_name, validation_json)
     VALUES (?, ?, ?, ?)`,
    ["2026-09-06T10:00:00Z", proposalId, "example", saved],
  );
}

function seedGrading(
  expectations: string,
  feedback = "[]",
  passRate: number | string | null = 0.5,
  id = "grade-1",
) {
  db.run(
    `INSERT INTO grading_results (grading_id, session_id, skill_name, graded_at, pass_rate, expectations_json, failure_feedback_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      id,
      "example",
      id === "grade-1" ? "2026-09-06T10:00:00Z" : "2026-09-05T10:00:00Z",
      passRate,
      expectations,
      feedback,
    ],
  );
}

test("malformed replay entries cannot become evidence or erase valid neighbors", () => {
  seedEvidence(
    JSON.stringify({
      per_entry_results: [
        { query: "first miss", should_trigger: true, triggered: false },
        null,
        { query: 123, should_trigger: true, triggered: false },
        { query: "invalid trigger", should_trigger: "yes", triggered: false },
        { query: "invalid observed trigger", should_trigger: true, triggered: "no" },
        { query: "routing miss", should_trigger: true, triggered: true, passed: false },
        { query: "final miss", should_trigger: true },
        { query: "first miss", should_trigger: true, triggered: false },
      ],
    }),
  );
  const result = extractMutationWeaknesses("example", db);
  expect(result.replayFailureSamples).toEqual(["first miss", "final miss"]);
  expect(result.routingFailureSamples).toEqual(["routing miss"]);
});

test.each(["not-json", "null", "[]", '{"per_entry_results":{}}'])(
  "skips malformed validation %s without losing another row",
  (saved) => {
    seedEvidence(saved);
    seedEvidence(
      JSON.stringify({
        per_entry_results: [{ query: "valid miss", should_trigger: true, triggered: false }],
      }),
      "proposal-2",
    );
    expect(extractMutationWeaknesses("example", db).replayFailureSamples).toEqual(["valid miss"]);
  },
);

test("preserves pattern precedence and valid neighbors across malformed grading entries", () => {
  seedGrading(
    JSON.stringify([
      { passed: false, text: "first pattern", name: 42 },
      null,
      { passed: "false", text: "invalid passed" },
      { passed: false, text: 42, name: "must not fall back" },
      { passed: false, text: "", name: "must not fall back either" },
      { passed: false, text: null, name: "name fallback" },
      { passed: false, description: "description fallback" },
      { passed: true, text: "passed expectation" },
    ]),
    JSON.stringify([
      { improvement_hint: "first pattern" },
      null,
      { improvement_hint: 42, failure_reason: "must not fall back" },
      { improvement_hint: null, failure_reason: "reason fallback" },
      { query: "query fallback" },
      { improvement_hint: "final pattern", query: 42 },
    ]),
  );
  expect(extractMutationWeaknesses("example", db).gradingFailurePatterns).toEqual([
    "first pattern",
    "name fallback",
    "description fallback",
    "reason fallback",
    "query fallback",
    "final pattern",
  ]);
});

test("malformed expectations do not erase valid feedback", () => {
  seedGrading("not-json", JSON.stringify([{ improvement_hint: "usable feedback" }]));
  expect(extractMutationWeaknesses("example", db).gradingFailurePatterns).toEqual([
    "usable feedback",
  ]);
});

test("invalid SQLite grading values keep their fallback while zero remains evidence", () => {
  seedGrading("[]", "[]", "not-a-number");
  seedGrading("[]", "[]", 0, "grade-2");
  const result = extractMutationWeaknesses("example", db);
  expect(result.bodyQualityScore).toBe(1);
  expect(result.gradingPassRateDelta).toBe(1);
});

test("reads do not mutate the saved evidence or grading payloads", () => {
  const saved = '{"per_entry_results":[null,{"query":"miss","should_trigger":true}]}';
  const grading = '[null,{"passed":false,"text":"pattern"}]';
  seedEvidence(saved);
  seedGrading(grading);
  extractMutationWeaknesses("example", db);
  expect(
    db
      .query<{ validation_json: string }, []>("SELECT validation_json FROM evolution_evidence")
      .get()?.validation_json,
  ).toBe(saved);
  expect(
    db
      .query<{ expectations_json: string }, []>("SELECT expectations_json FROM grading_results")
      .get()?.expectations_json,
  ).toBe(grading);
});
