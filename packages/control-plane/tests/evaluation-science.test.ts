import { assert, describe, it } from "@effect/vitest";

import {
  BaselineResult,
  buildCandidateSnapshot,
  evaluateReleaseGate,
  EvidenceSession,
  generateCandidateEvals,
  ReleaseGateInput,
} from "../src/index";

const baseline = (
  input: Partial<typeof BaselineResult.Type> & { baseline: typeof BaselineResult.Type.baseline },
) =>
  BaselineResult.make({
    caseCount: 4,
    activationAccuracy: 0.8,
    routingQuality: 0.8,
    outcomeQuality: 0.7,
    contextTokens: 400,
    regressions: [],
    ...input,
  });

const releaseInput = (overrides: Partial<typeof ReleaseGateInput.Type> = {}) =>
  ReleaseGateInput.make({
    candidateId: "candidate",
    evidenceSnapshotId: "snapshot",
    packageValid: true,
    replayPassed: true,
    draft: baseline({ baseline: "composite", outcomeQuality: 0.86, contextTokens: 250 }),
    baselines: [
      baseline({ baseline: "no_skill", outcomeQuality: 0.65 }),
      baseline({ baseline: "existing_skills", outcomeQuality: 0.7 }),
      baseline({ baseline: "sibling_bundle", outcomeQuality: 0.72, contextTokens: 600 }),
    ],
    minimumOutcomeLift: 0.05,
    maximumActivationRegression: 0.02,
    ...overrides,
  });

describe("scientific release gate", () => {
  it("generates positive, negative, boundary, and execution evals with provenance", () => {
    const sourceQueries = new Map([
      ["one", "Prepare release notes."],
      ["two", "prepare release notes!"],
      ["three", "PREPARE release notes"],
    ]);
    const snapshot = buildCandidateSnapshot(
      [...sourceQueries].map(([sessionId, query], index) =>
        EvidenceSession.make({
          sessionId,
          projectId: sessionId,
          occurredAt: `2026-07-0${index + 1}T00:00:00.000Z`,
          successful: true,
          outcomeScore: 1,
          orderedSkills: [],
          query,
        }),
      ),
    );
    const candidate = snapshot.candidates[0]!;
    const evals = generateCandidateEvals(snapshot.snapshotId, candidate);
    assert.deepStrictEqual(
      new Set(evals.map((item) => item.kind)),
      new Set(["positive", "negative", "boundary", "execution"]),
    );
    assert.ok(evals.every((item) => item.evidenceSnapshotId === snapshot.snapshotId));
    const positiveCases = evals.filter((item) => item.kind === "positive");
    const heldOutCases = evals.filter((item) => item.heldOut);
    assert.strictEqual(positiveCases.length, candidate.supportingSessionIds.length);
    assert.strictEqual(heldOutCases.length, candidate.heldOutSessionIds.length);
    for (const item of [...positiveCases, ...heldOutCases]) {
      assert.strictEqual(item.sourceSessionIds.length, 1);
      assert.strictEqual(item.query, sourceQueries.get(item.sourceSessionIds[0]!));
    }
    assert.deepStrictEqual(
      new Set(candidate.redactedExcerpts),
      new Set(candidate.supportingExamples?.map((example) => example.excerpt)),
    );
    assert.ok(
      candidate.heldOutExamples?.every(
        (example) => !candidate.redactedExcerpts.includes(example.excerpt),
      ),
    );
  });

  it("recommends a validated held-out improvement", () => {
    assert.strictEqual(evaluateReleaseGate(releaseInput()).recommended, true);
  });

  it("blocks recommendation when baseline lift fails", () => {
    const result = evaluateReleaseGate(
      releaseInput({
        draft: baseline({ baseline: "composite", outcomeQuality: 0.71 }),
      }),
    );
    assert.strictEqual(result.recommended, false);
    assert.ok(result.blockers.some((blocker) => blocker.includes("outcome lift")));
  });

  it("blocks recommendation on regressions or missing validation", () => {
    const result = evaluateReleaseGate(
      releaseInput({
        packageValid: false,
        draft: baseline({
          baseline: "composite",
          outcomeQuality: 0.9,
          regressions: ["negative case"],
        }),
      }),
    );
    assert.strictEqual(result.recommended, false);
    assert.ok(result.blockers.length >= 2);
  });
});
