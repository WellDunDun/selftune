import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OverviewCleanupCheckpoint } from "./OverviewCleanupCheckpoint";

describe("OverviewCleanupCheckpoint", () => {
  it("turns evidence-backed inactivity into a reversible cleanup review", () => {
    const html = renderToStaticMarkup(
      <OverviewCleanupCheckpoint
        activeSkillCount={47}
        candidates={[
          {
            skillName: "agent-browser",
            reason: "No trusted invocation for 45 days across 31 subsequent sessions.",
            lastInvokedAt: "2026-06-07T00:00:00.000Z",
            inactiveDays: 45,
            sessionsSinceInvocation: 31,
          },
          {
            skillName: "old-deploy",
            reason: "No trusted invocation for 38 days across 25 subsequent sessions.",
            lastInvokedAt: "2026-06-14T00:00:00.000Z",
            inactiveDays: 38,
            sessionsSinceInvocation: 25,
          },
        ]}
        evidencePendingCount={3}
        archivedCount={4}
        reviewAction={<button>Review cleanup</button>}
        restoreAction={<button>Restore archived skills</button>}
      />,
    );

    expect(html).toContain("Cleanup ready");
    expect(html).toContain("2 of 47 active skills");
    expect(html).toContain("agent-browser");
    expect(html).toContain("45 days inactive");
    expect(html).toContain("31 later sessions");
    expect(html).toContain("3 skills still need more evidence");
    expect(html).toContain("No files will be deleted");
    expect(html).toContain("Review cleanup");
    expect(html).toContain("Restore archived skills");
  });

  it("surfaces duplicate-install cleanup even when no inactive skills are recommended", () => {
    const html = renderToStaticMarkup(
      <OverviewCleanupCheckpoint
        activeSkillCount={47}
        candidates={[]}
        evidencePendingCount={3}
        archivedCount={4}
        reviewAction={<button>Review inactive skills</button>}
        consolidationCandidates={[
          {
            skillName: "agent-browser",
            installedCount: 3,
            projectCount: 2,
            confidence: "source_current",
          },
          {
            skillName: "research",
            installedCount: 3,
            projectCount: 1,
            confidence: "review_required",
          },
        ]}
        consolidationAction={<button>Review duplicate installations</button>}
      />,
    );

    expect(html).toContain("Cleanup ready");
    expect(html).toContain("2 duplicate-install recommendations");
    expect(html).toContain("agent-browser");
    expect(html).toContain("3 installations");
    expect(html).toContain("2 project links");
    expect(html).toContain("Review duplicate installations");
    expect(html).not.toContain("Review inactive skills");
  });
});
