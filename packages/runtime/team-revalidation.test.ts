import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { makeTeamSkillSetRevalidationRuntime } from "./team-revalidation.js";

const sha = (digit: string) => digit.repeat(64);

describe("team skill set revalidation", () => {
  test("publishes only a bounded lifecycle state when status observes a change", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "selftune-revalidation-"));
    const published: unknown[] = [];
    const runtime = makeTeamSkillSetRevalidationRuntime({
      configRoot,
      now: () => 1_000,
      hosted: {
        publishRevalidationSummary: async (request) => {
          published.push(request);
          return {
            summary_id: "summary_01",
            ...request,
            recorded_at: 1_001,
            idempotent: false,
          };
        },
      },
    });

    const result = await runtime.status({
      assignmentId: "assignment_01",
      releaseId: "release_01",
      sourceRevisionSha256: sha("1"),
      dependencyFingerprint: sha("2"),
      harnessFingerprint: sha("3"),
      policyFingerprint: sha("4"),
    });

    expect(result.syncStatus).toBe("synced");
    expect(published).toEqual([
      {
        request_id: expect.stringMatching(/^revalidation_v1_[0-9a-f]{32}$/),
        assignment_id: "assignment_01",
        release_id: "release_01",
        lifecycle_sequence: 1_000,
        status: "needs_review",
        observed_at: 1_000,
      },
    ]);
    expect(JSON.stringify(published)).not.toContain("model");
    expect(JSON.stringify(published)).not.toContain("reason");
  });

  test("keeps an offline lifecycle summary pending and retries the same request", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "selftune-revalidation-"));
    const requests: Array<{ readonly request_id: string }> = [];
    let online = false;
    let now = 2_000;
    const runtime = makeTeamSkillSetRevalidationRuntime({
      configRoot,
      now: () => now,
      hosted: {
        publishRevalidationSummary: async (request) => {
          requests.push(request);
          if (!online) throw new Error("offline");
          return {
            summary_id: "summary_01",
            ...request,
            recorded_at: 2_001,
            idempotent: true,
          };
        },
      },
    });
    const context = {
      assignmentId: "assignment_01",
      releaseId: "release_01",
      sourceRevisionSha256: sha("1"),
      dependencyFingerprint: sha("2"),
      harnessFingerprint: sha("3"),
      policyFingerprint: sha("4"),
    };

    expect((await runtime.status(context)).syncStatus).toBe("pending");
    online = true;
    now = 3_000;
    expect((await runtime.status(context)).syncStatus).toBe("synced");
    expect(requests[0]?.request_id).toBe(requests[1]?.request_id);
    expect(requests[0]).toEqual(requests[1]);
  });

  test("records supported environments and keeps raw evidence local", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "selftune-revalidation-"));
    const runtime = makeTeamSkillSetRevalidationRuntime({
      configRoot,
      now: () => Date.parse("2026-08-31T10:00:00.000Z"),
    });

    const result = await runtime.recordValidation({
      assignmentId: "assignment_01",
      releaseId: "release_01",
      source: { kind: "team_release", revisionSha256: sha("1") },
      reviewBy: "2026-09-30T00:00:00.000Z",
      supportedEnvironments: [{ harness: "codex", models: ["gpt-5.6-sol", "gpt-5.6-terra"] }],
      dependencyFingerprint: sha("2"),
      harnessFingerprint: sha("3"),
      policyFingerprint: sha("4"),
      outcome: "passed",
      summary: "Validated on the supported Codex models.",
      rawEvidence: new TextEncoder().encode("private local trace /Users/person/project"),
    });

    expect(result.status).toBe("current");
    expect(result.hostedSummary).toEqual({
      assignment_id: "assignment_01",
      release_id: "release_01",
      status: "current",
      reason_codes: [],
      validated_at: Date.parse("2026-08-31T10:00:00.000Z"),
      review_by: Date.parse("2026-09-30T00:00:00.000Z"),
      supported_harnesses: ["codex"],
      supported_model_count: 2,
    });
    expect(JSON.stringify(result.hostedSummary)).not.toContain("private local trace");
    expect(result.localMetadata).toEqual({
      source: { kind: "team_release", revisionSha256: sha("1") },
      reviewBy: Date.parse("2026-09-30T00:00:00.000Z"),
      supportedEnvironments: [{ harness: "codex", models: ["gpt-5.6-sol", "gpt-5.6-terra"] }],
      outcome: "passed",
      summary: "Validated on the supported Codex models.",
    });
    expect(await readFile(result.rawEvidencePath, "utf8")).toContain("private local trace");
  });

  test("requires revalidation when a dependency, source, harness, or policy changes", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "selftune-revalidation-"));
    const runtime = makeTeamSkillSetRevalidationRuntime({ configRoot, now: () => 1_000 });
    const baseline = {
      assignmentId: "assignment_01",
      releaseId: "release_01",
      source: { kind: "team_release" as const, revisionSha256: sha("1") },
      reviewBy: "2026-09-30T00:00:00.000Z",
      supportedEnvironments: [{ harness: "codex", models: ["model-a"] }],
      dependencyFingerprint: sha("2"),
      harnessFingerprint: sha("3"),
      policyFingerprint: sha("4"),
      outcome: "passed" as const,
      summary: "Passed.",
      rawEvidence: new Uint8Array([1, 2, 3]),
    };
    await runtime.recordValidation(baseline);

    const changed = await runtime.status({
      assignmentId: baseline.assignmentId,
      releaseId: baseline.releaseId,
      sourceRevisionSha256: sha("5"),
      dependencyFingerprint: sha("6"),
      harnessFingerprint: sha("7"),
      policyFingerprint: sha("8"),
    });

    expect(changed.status).toBe("revalidation_required");
    expect(changed.reasonCodes).toEqual([
      "source_changed",
      "dependencies_changed",
      "harness_changed",
      "policy_changed",
    ]);
  });

  test("marks passed validation due after its review-by date", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "selftune-revalidation-"));
    let now = Date.parse("2026-08-31T10:00:00.000Z");
    const runtime = makeTeamSkillSetRevalidationRuntime({ configRoot, now: () => now });
    await runtime.recordValidation({
      assignmentId: "assignment_01",
      releaseId: "release_01",
      source: { kind: "team_release", revisionSha256: sha("1") },
      reviewBy: "2026-09-01T00:00:00.000Z",
      supportedEnvironments: [{ harness: "codex", models: ["model-a"] }],
      dependencyFingerprint: sha("2"),
      harnessFingerprint: sha("3"),
      policyFingerprint: sha("4"),
      outcome: "passed",
      summary: "Passed.",
      rawEvidence: new Uint8Array([1]),
    });
    now = Date.parse("2026-09-02T00:00:00.000Z");

    const status = await runtime.status({
      assignmentId: "assignment_01",
      releaseId: "release_01",
      sourceRevisionSha256: sha("1"),
      dependencyFingerprint: sha("2"),
      harnessFingerprint: sha("3"),
      policyFingerprint: sha("4"),
    });

    expect(status.status).toBe("revalidation_required");
    expect(status.reasonCodes).toEqual(["review_due"]);
  });

  test("bounds private evidence and compatibility metadata", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "selftune-revalidation-"));
    const runtime = makeTeamSkillSetRevalidationRuntime({ configRoot, now: () => 1_000 });
    await expect(
      runtime.recordValidation({
        assignmentId: "assignment_01",
        releaseId: "release_01",
        source: { kind: "team_release", revisionSha256: sha("1") },
        reviewBy: "2026-09-30T00:00:00.000Z",
        supportedEnvironments: [{ harness: "codex", models: ["model-a"] }],
        dependencyFingerprint: sha("2"),
        harnessFingerprint: sha("3"),
        policyFingerprint: sha("4"),
        outcome: "passed",
        summary: "Passed.",
        rawEvidence: new Uint8Array(10 * 1024 * 1024 + 1),
      }),
    ).rejects.toMatchObject({ code: "REVALIDATION_EVIDENCE_TOO_LARGE" });
  });
});
