import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  adaptCloudImproveRun,
  adaptLocalSourceMerge,
  buildRunPackage,
  parseRunPackage,
  RunReviewSurface,
  summarizeRunReview,
} from "./index";

const localDecision = {
  approval_id: "approval-local",
  status: "pending",
  skill_name: "research",
  source: "example/skills",
  harness_id: "codex",
  model: "gpt-5",
  installed_hash: "old-hash",
  latest_hash: "new-hash",
  created_at: "2026-07-16T10:00:00.000Z",
  updated_at: "2026-07-16T10:00:00.000Z",
  expires_at: "2026-07-17T10:00:00.000Z",
  receipt: null,
  failure: null,
  targets: [
    {
      target_path: "/Users/alice/project/.agents/skills/research",
      summary: "Preserved local guidance while adopting upstream fixes.",
      merged_diff:
        "--- /Users/alice/project/SKILL.md\n+++ /Users/alice/project/SKILL.md\n@@ -1 +1 @@\n-token=secret-value\n+safe",
      conflict_files: ["SKILL.md"],
    },
  ],
};

const cloudRun = {
  id: "run-cloud",
  status: "succeeded",
  phase: "review",
  applyTarget: "github_pr",
  createdAt: "2026-07-16T09:00:00.000Z",
  updatedAt: "2026-07-16T09:30:00.000Z",
  completedAt: "2026-07-16T09:30:00.000Z",
  orgId: "org-secret",
};

const cloudCandidate = {
  id: "candidate-cloud",
  status: "winner",
  mutationSurface: "body",
  diffText: "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-old\n+better",
  currentSkillScore: 0.6,
  candidateSkillScore: 0.85,
  noSkillScore: 0.1,
  improvementPct: 41.7,
  summaryJson: { rationale: "Held-out score improved." },
  archiveUrl: "https://api.selftune.dev/artifacts/candidate?signature=secret-sig",
  orgId: "org-secret",
};

describe("portable run review", () => {
  it("adapts the real Local decision without requiring Cloud-only fields", () => {
    const view = adaptLocalSourceMerge(localDecision);

    expect(view.intent.title).toBe("Merge research source update");
    expect(view.candidate.diffText).toContain("token=secret-value");
    expect(view.decision.state).toBe("pending");
    expect(view.validation.state).toBe("pending");
    expect(view.outcome.state).toBe("pending");
    expect("orgId" in view).toBe(false);
  });

  it("adapts the real Cloud winner while retaining authorized artifact access only in memory", () => {
    const view = adaptCloudImproveRun({
      run: cloudRun,
      winner: cloudCandidate,
      latestApplyAttempt: null,
      skillName: "research",
    });

    expect(view.intent.title).toBe("Improve research");
    expect(view.validation.state).toBe("passed");
    expect(view.evidence.map((item) => item.label)).toEqual([
      "Current score",
      "Candidate score",
      "No-skill score",
      "Improvement",
    ]);
    expect(view.candidate.artifact?.href).toBe(cloudCandidate.archiveUrl);

    const portable = buildRunPackage(view);
    expect(JSON.stringify(portable)).not.toContain("signature");
    expect(JSON.stringify(portable)).not.toContain("org-secret");
  });

  it("renders both producers through one review surface", () => {
    const localHtml = renderToStaticMarkup(
      <RunReviewSurface review={adaptLocalSourceMerge(localDecision)} />,
    );
    const cloudHtml = renderToStaticMarkup(
      <RunReviewSurface
        review={adaptCloudImproveRun({
          run: cloudRun,
          winner: cloudCandidate,
          latestApplyAttempt: null,
          skillName: "research",
        })}
      />,
    );

    for (const html of [localHtml, cloudHtml]) {
      expect(html).toContain("Evidence");
      expect(html).toContain("Candidate diff");
      expect(html).toContain("Decision");
      expect(html).toContain("Validation");
      expect(html).toContain("Outcome");
    }
  });

  it("serializes version 1, redacts credentials and absolute paths, and parses compatibly", () => {
    const portable = buildRunPackage(adaptLocalSourceMerge(localDecision));
    const encoded = JSON.stringify(portable);

    expect(portable.schema_version).toBe(1);
    expect(encoded).not.toContain("/Users/alice");
    expect(encoded).not.toContain("secret-value");
    expect(encoded).toContain("[local-path]");
    expect(encoded).toContain("[redacted]");
    expect(parseRunPackage(JSON.parse(encoded))).toEqual(portable);
    expect(() => parseRunPackage({ ...portable, schema_version: 2 })).toThrow(
      "Unsupported Run Package schema version",
    );
  });

  it("derives the agent summary from the same adapter view", () => {
    const view = adaptCloudImproveRun({
      run: cloudRun,
      winner: cloudCandidate,
      latestApplyAttempt: { success: true, prUrl: "https://github.com/example/repo/pull/7" },
      skillName: "research",
    });

    expect(summarizeRunReview(view)).toEqual({
      run_id: "run-cloud",
      producer: "cloud_improve",
      intent: "Improve research",
      decision: "applied",
      validation: "passed",
      outcome: "applied",
      summary: "Winning body candidate improved the score from 0.600 to 0.850.",
    });
  });
});
