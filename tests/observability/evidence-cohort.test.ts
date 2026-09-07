import { expect, test } from "bun:test";

import {
  buildEvidencePayloadPreview,
  EvidenceCohortFailure,
  materializeEvidenceCohort,
  type EvidenceCohortCandidate,
} from "@selftune/observability/evidence-cohort";
import * as Effect from "effect/Effect";

const target = {
  skill_id: "diagnose",
  skill_name: "Diagnose",
  skill_path: "/skills/diagnose/SKILL.md",
  revision: "sha256:current",
};

const pattern = {
  pattern_id: "execution-pattern-diagnose",
  kind: "repeated_correlated_errors" as const,
  skill_id: "diagnose",
  skill_name: "Diagnose",
};

function candidate(index: number, errorCount: number): EvidenceCohortCandidate {
  return {
    trace_id: index.toString(16).padStart(32, "0"),
    span_id: (index + 100).toString(16).padStart(16, "0"),
    skill_invocation_id: `invocation-${index}`,
    source_id: `rollout-${index % 4}`,
    source_revision: `revision-${index}`,
    model: index % 2 === 0 ? "gpt-5" : "gpt-5-mini",
    duration_ms: 1_000 + index,
    input_tokens: 100 + index,
    output_tokens: 20 + index,
    error_count: errorCount,
    tool_call_count: index % 3,
    source_excerpt:
      index === 0
        ? "Read /Users/alice/private.txt with sk-abcdefghijklmnopqrstuvwxyz0123456789"
        : `selected source record ${index}`,
  };
}

test("materializes a bounded, contrastive, deterministic cohort without exposing holdout", async () => {
  const input = {
    schema_version: "1.0.0" as const,
    selector_version: "evidence-cohort-v1",
    pattern,
    target_skill: target,
    source_allowlist: ["rollout-0", "rollout-1", "rollout-2", "rollout-3"],
    excerpt_limit_bytes: 120,
    request_limit_bytes: 2_000,
    candidates: [
      ...Array.from({ length: 8 }, (_, index) => candidate(index, index % 3 === 0 ? 2 : 1)),
      ...Array.from({ length: 8 }, (_, index) => candidate(index + 20, 0)),
    ],
  };

  const first = await Effect.runPromise(materializeEvidenceCohort(input));
  const second = await Effect.runPromise(materializeEvidenceCohort(input));
  const preview = buildEvidencePayloadPreview(first);

  expect(first.fingerprint).toBe(second.fingerprint);
  // Fingerprints hash serialized entries, including their established key order.
  expect(Object.keys(first.entries[0]!)).toEqual([
    "role",
    "source",
    "model",
    "duration_ms",
    "input_tokens",
    "output_tokens",
    "error_count",
    "tool_call_count",
    "redacted_excerpt",
  ]);
  expect(first.entries.filter((entry) => entry.role === "calibration_failure")).toHaveLength(5);
  expect(first.entries.filter((entry) => entry.role === "calibration_success")).toHaveLength(5);
  expect(first.entries.some((entry) => entry.role === "heldout_failure")).toBe(true);
  expect(first.entries.some((entry) => entry.role === "heldout_success")).toBe(true);
  expect(first.entries.some((entry) => entry.role === "counterexample")).toBe(true);
  expect(preview.entries.every((entry) => !entry.role.startsWith("heldout"))).toBe(true);
  expect(preview.total_bytes).toBeLessThanOrEqual(2_000);
  expect(JSON.stringify(first)).not.toContain("/Users/alice/private.txt");
  expect(JSON.stringify(first)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
});

test("returns a typed diagnostic failure when comparable successes are unavailable", async () => {
  const exit = await Effect.runPromiseExit(
    materializeEvidenceCohort({
      schema_version: "1.0.0",
      selector_version: "evidence-cohort-v1",
      pattern,
      target_skill: target,
      source_allowlist: ["rollout-0"],
      excerpt_limit_bytes: 120,
      request_limit_bytes: 600,
      candidates: [candidate(0, 1), candidate(4, 2)],
    }),
  );

  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    expect(exit.cause.toString()).toContain(
      EvidenceCohortFailure.make({
        reason: "insufficient_contrast",
        message: "",
      })._tag,
    );
  }
});

test("rejects source records outside the explicit allowlist", async () => {
  const exit = await Effect.runPromiseExit(
    materializeEvidenceCohort({
      schema_version: "1.0.0",
      selector_version: "evidence-cohort-v1",
      pattern,
      target_skill: target,
      source_allowlist: ["rollout-0"],
      excerpt_limit_bytes: 120,
      request_limit_bytes: 600,
      candidates: [candidate(0, 1), candidate(1, 0)],
    }),
  );

  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure")
    expect(exit.cause.toString()).toContain("not in the evidence allowlist");
});

test("fails safely when the provider request limit cannot carry contrast", async () => {
  const exit = await Effect.runPromiseExit(
    materializeEvidenceCohort({
      schema_version: "1.0.0",
      selector_version: "evidence-cohort-v1",
      pattern,
      target_skill: target,
      source_allowlist: ["rollout-0", "rollout-1"],
      excerpt_limit_bytes: 120,
      request_limit_bytes: 1,
      candidates: [candidate(0, 1), candidate(1, 0)],
    }),
  );

  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") expect(exit.cause.toString()).toContain("request-byte limit");
});
