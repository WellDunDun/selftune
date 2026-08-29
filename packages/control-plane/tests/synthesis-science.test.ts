import { assert, describe, it } from "@effect/vitest";

import {
  buildCandidateSnapshot,
  buildCoverageGapCandidates,
  buildWorkflowCandidates,
  EvidenceSession,
  isCoverageIntentEligible,
} from "../src/index";

const session = (input: {
  id: string;
  skills: string[];
  successful?: boolean;
  project?: string | null;
  day?: number;
}) =>
  EvidenceSession.make({
    sessionId: input.id,
    projectId: input.project ?? `project-${input.id}`,
    occurredAt: `2026-07-${String(input.day ?? 10).padStart(2, "0")}T08:00:00.000Z`,
    successful: input.successful ?? true,
    outcomeScore: input.successful === false ? 0 : 1,
    orderedSkills: input.skills,
    query: `query ${input.id}`,
  });

describe("synthesis evidence science", () => {
  it("does not mistake an ubiquitous skill for positive co-usage lift", () => {
    const sessions = [
      session({ id: "1", skills: ["common", "rare"] }),
      session({ id: "2", skills: ["common", "rare"] }),
      session({ id: "3", skills: ["common", "rare"] }),
      session({ id: "4", skills: ["common"] }),
      session({ id: "5", skills: ["common"] }),
      session({ id: "6", skills: ["common"] }),
    ];
    assert.deepStrictEqual(buildWorkflowCandidates(sessions), []);
  });

  it("requires consistent ordering for a consolidation candidate", () => {
    const sessions = [
      session({ id: "1", skills: ["research", "write"] }),
      session({ id: "2", skills: ["research", "write"] }),
      session({ id: "3", skills: ["write", "research"] }),
      session({ id: "4", skills: ["write", "research"] }),
    ];
    const candidates = buildWorkflowCandidates(sessions, {
      minSupport: 2,
      minLift: 0,
      minSequenceConsistency: 0.65,
      minOutcomeQuality: 0.6,
    });
    assert.deepStrictEqual(candidates, []);
  });

  it("never turns repeated failed sessions into a positive skill candidate", () => {
    const sessions = [
      session({ id: "1", skills: ["research", "write"], successful: false }),
      session({ id: "2", skills: ["research", "write"], successful: false }),
      session({ id: "3", skills: ["research", "write"], successful: false }),
      session({ id: "4", skills: ["diagnose"] }),
    ];
    assert.deepStrictEqual(buildWorkflowCandidates(sessions), []);
  });

  it("counts failed executions in workflow completion evidence", () => {
    const sessions = [
      session({ id: "success-1", skills: ["research", "write"] }),
      session({ id: "success-2", skills: ["research", "write"] }),
      session({ id: "success-3", skills: ["research", "write"] }),
      session({ id: "failure-1", skills: ["research", "write"], successful: false }),
      session({ id: "failure-2", skills: ["research", "write"], successful: false }),
      session({ id: "failure-3", skills: ["research", "write"], successful: false }),
    ];
    assert.deepStrictEqual(
      buildWorkflowCandidates(sessions, {
        minSupport: 3,
        minLift: 0,
        minSequenceConsistency: 0,
        minOutcomeQuality: 0.6,
        minCompletionRate: 0.6,
      }),
      [],
    );
  });

  it("finds repeated successful uncovered work without promoting failure loops", () => {
    const sessions = [
      EvidenceSession.make({ ...session({ id: "1", skills: [] }), query: "prepare release notes" }),
      EvidenceSession.make({ ...session({ id: "2", skills: [] }), query: "prepare release notes" }),
      EvidenceSession.make({ ...session({ id: "3", skills: [] }), query: "prepare release notes" }),
      EvidenceSession.make({
        ...session({ id: "4", skills: [], successful: false }),
        query: "failed loop",
      }),
      EvidenceSession.make({
        ...session({ id: "5", skills: [], successful: false }),
        query: "failed loop",
      }),
      EvidenceSession.make({
        ...session({ id: "6", skills: [], successful: false }),
        query: "failed loop",
      }),
    ];
    const candidates = buildCoverageGapCandidates(sessions);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0]?.kind, "coverage_gap");
    assert.strictEqual(candidates[0]?.evidence.supportSessions, 3);
  });

  it("excludes conversational controls and SelfTune evaluation scaffolding", () => {
    assert.strictEqual(isCoverageIntentEligible("proceed"), false);
    assert.strictEqual(isCoverageIntentEligible("reply with exactly OK"), false);
    assert.strictEqual(
      isCoverageIntentEligible("- You are agent CEO. Continue your Paperclip work."),
      false,
    );
    assert.strictEqual(
      isCoverageIntentEligible(
        "environment context cwd path cwd approval policy on request sandbox mode workspace write",
      ),
      false,
    );
    assert.strictEqual(
      isCoverageIntentEligible(
        "You are a test engineer generating skill unit tests given a skill name and content.",
      ),
      false,
    );
    assert.strictEqual(
      isCoverageIntentEligible(
        "You are an evaluation assistant. For each numbered query, respond yes or no.",
      ),
      false,
    );
    assert.strictEqual(
      isCoverageIntentEligible("Prepare release notes for the desktop distribution"),
      true,
    );

    const sessions = ["1", "2", "3"].flatMap((id) => [
      EvidenceSession.make({
        ...session({ id: `control-${id}`, skills: [] }),
        query: "continue",
      }),
      EvidenceSession.make({
        ...session({ id: `eval-${id}`, skills: [] }),
        query: "You are a rigorous skill session evaluator. Grade this trace.",
      }),
    ]);
    assert.deepStrictEqual(buildCoverageGapCandidates(sessions), []);
  });

  it("does not count unavailable workflow metrics as positive confidence evidence", () => {
    const coverage = buildCoverageGapCandidates([
      EvidenceSession.make({
        ...session({ id: "1", skills: [], project: "a", day: 1 }),
        query: "prepare release notes",
      }),
      EvidenceSession.make({
        ...session({ id: "2", skills: [], project: "b", day: 8 }),
        query: "prepare release notes",
      }),
      EvidenceSession.make({
        ...session({ id: "3", skills: [], project: "c", day: 15 }),
        query: "prepare release notes",
      }),
    ])[0]!;
    assert.strictEqual(coverage.evidence.coUsageLift, null);
    assert.strictEqual(coverage.evidence.sequenceConsistency, null);
    assert.strictEqual(coverage.evidence.confidence, 0.8333);
  });

  it("deduplicates session evidence before counting support", () => {
    const duplicate = session({ id: "same", skills: ["research", "write"] });
    assert.deepStrictEqual(buildWorkflowCandidates([duplicate, duplicate, duplicate]), []);
  });

  it("does not count correlated fan-out sessions as independent support", () => {
    const sessions = [1, 2, 3].map((index) =>
      EvidenceSession.make({
        ...session({ id: `child-${index}`, skills: [], project: "same-project", day: 10 }),
        occurredAt: `2026-07-10T08:00:00.${String(index).padStart(3, "0")}Z`,
        query: "prepare release notes",
      }),
    );
    assert.deepStrictEqual(buildCoverageGapCandidates(sessions), []);
  });

  it("ranks a fixed evidence snapshot deterministically and holds sessions out", () => {
    const sessions = [
      session({ id: "1", skills: ["research", "write"], project: "a", day: 1 }),
      session({ id: "2", skills: ["research", "write"], project: "b", day: 8 }),
      session({ id: "3", skills: ["research", "write"], project: "c", day: 15 }),
      session({ id: "4", skills: ["deploy"], project: "a", day: 2 }),
      session({ id: "5", skills: ["review"], project: "b", day: 9 }),
      session({ id: "6", skills: ["test"], project: "c", day: 14 }),
    ];
    const first = buildCandidateSnapshot(sessions);
    // oxlint-disable-next-line unicorn/no-array-reverse -- Reverse a copy to prove input-order invariance on the ES2022 target.
    const second = buildCandidateSnapshot([...sessions].reverse());
    assert.deepStrictEqual(first, second);
    assert.strictEqual(first.candidates.length, 1);
    const candidate = first.candidates[0]!;
    assert.strictEqual(candidate.evidence.coUsageLift, 2);
    assert.strictEqual(candidate.evidence.exploratory, false);
    assert.strictEqual(candidate.heldOutSessionIds.length, 1);
    assert.strictEqual(
      candidate.supportingSessionIds.some((id) => candidate.heldOutSessionIds.includes(id)),
      false,
    );
  });
});
