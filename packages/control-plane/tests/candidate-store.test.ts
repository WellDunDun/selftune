import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  buildCandidateSnapshot,
  CandidateSnapshot,
  CandidateStore,
  CandidateStoreMemory,
  decideCandidate,
  EvidenceSession,
  mergeCandidateSnapshot,
} from "../src/index";

const snapshot = buildCandidateSnapshot([
  EvidenceSession.make({
    sessionId: "one",
    projectId: "a",
    occurredAt: "2026-07-01T00:00:00.000Z",
    successful: true,
    outcomeScore: 1,
    orderedSkills: [],
    query: "prepare release notes",
  }),
  EvidenceSession.make({
    sessionId: "two",
    projectId: "b",
    occurredAt: "2026-07-08T00:00:00.000Z",
    successful: true,
    outcomeScore: 1,
    orderedSkills: [],
    query: "prepare release notes",
  }),
  EvidenceSession.make({
    sessionId: "three",
    projectId: "c",
    occurredAt: "2026-07-15T00:00:00.000Z",
    successful: true,
    outcomeScore: 1,
    orderedSkills: [],
    query: "prepare release notes",
  }),
]);

describe("CandidateStore", () => {
  it.layer(CandidateStoreMemory)("review decisions", (it) => {
    it.effect("retains rejection history and suppresses a repeated recommendation", () =>
      Effect.gen(function* () {
        yield* mergeCandidateSnapshot(snapshot);
        const candidateId = snapshot.candidates[0]!.candidateId;
        const rejected = yield* decideCandidate({
          candidateId,
          action: "reject",
          reason: "This procedure is intentionally project-specific.",
          decidedAt: "2026-07-15T01:00:00.000Z",
        });
        assert.strictEqual(rejected.status, "rejected");
        assert.strictEqual(rejected.decisionHistory.length, 1);

        yield* mergeCandidateSnapshot(snapshot);
        const stored = yield* (yield* CandidateStore).snapshot;
        assert.strictEqual(stored.candidates[0]?.status, "rejected");
        assert.strictEqual(stored.candidates[0]?.decision?.reason, rejected.decision?.reason);

        yield* mergeCandidateSnapshot(
          CandidateSnapshot.make({
            snapshotId: "new-science-version",
            evidenceVersion: 1,
            generatedAt: "2026-07-16T00:00:00.000Z",
            candidates: [],
          }),
        );
        const tombstone = yield* (yield* CandidateStore).snapshot;
        assert.strictEqual(tombstone.candidates[0]?.status, "rejected");
        assert.strictEqual(tombstone.candidates[0]?.decisionHistory.length, 1);
      }),
    );

    it.effect("fails with a typed error for an unknown candidate", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decideCandidate({
            candidateId: "missing",
            action: "accept",
            reason: "reviewed",
            decidedAt: "2026-07-15T01:00:00.000Z",
          }),
        );
        assert.strictEqual(error._tag, "CandidateNotFound");
      }),
    );

    it.effect("applies reviewed copy edits and keeps them across scans", () =>
      Effect.gen(function* () {
        yield* mergeCandidateSnapshot(snapshot);
        const candidateId = snapshot.candidates[0]!.candidateId;
        yield* decideCandidate({
          candidateId,
          action: "edit",
          reason: "Use language that describes the reusable procedure.",
          title: "Release notes workflow",
          summary: "Prepare verified release notes from merged changes.",
          decidedAt: "2026-07-15T01:00:00.000Z",
        });
        yield* decideCandidate({
          candidateId,
          action: "accept",
          reason: "The edited candidate is ready to draft.",
          decidedAt: "2026-07-15T01:05:00.000Z",
        });
        yield* mergeCandidateSnapshot(snapshot);
        const stored = yield* (yield* CandidateStore).snapshot;
        assert.strictEqual(stored.candidates[0]?.title, "Release notes workflow");
        assert.strictEqual(
          stored.candidates[0]?.summary,
          "Prepare verified release notes from merged changes.",
        );
      }),
    );
  });
});
