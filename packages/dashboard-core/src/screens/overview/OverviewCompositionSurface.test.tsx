import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./OverviewCoreSurface", () => ({
  OverviewCoreSurface: ({
    beforeHero,
    betweenHeroAndFeed,
    afterFeed,
  }: {
    beforeHero?: ReactNode;
    betweenHeroAndFeed?: ReactNode;
    afterFeed?: ReactNode;
  }) => (
    <div>
      <div data-slot="before-hero">{beforeHero}</div>
      <div data-slot="between-hero-feed">{betweenHeroAndFeed}</div>
      <div data-slot="after-feed">{afterFeed}</div>
    </div>
  ),
}));

vi.mock("./OverviewOnboardingBanner", () => ({
  OverviewOnboardingBanner: ({ skillCount }: { skillCount: number }) => (
    <div>Onboarding {skillCount}</div>
  ),
}));

vi.mock("./OverviewComparisonSurface", () => ({
  OverviewComparisonSurface: ({ rows }: { rows: Array<unknown> }) => (
    <div>Comparison {rows.length}</div>
  ),
}));

vi.mock("./OverviewRunSummary", () => ({
  OverviewRunSummary: ({ runCount }: { runCount: number }) => <div>Run Summary {runCount}</div>,
}));

import { OverviewCompositionSurface } from "./OverviewCompositionSurface";

describe("OverviewCompositionSurface", () => {
  it("renders the shared overview sections in one canonical order", () => {
    const html = renderToStaticMarkup(
      <OverviewCompositionSurface
        autonomyStatus={{
          level: "needs_review",
          summary: "Needs review",
          skills_observed: 2,
          attention_required: 1,
          pending_reviews: 0,
        }}
        lastRun="2026-04-11T00:00:00Z"
        trustWatchlist={[]}
        attentionItems={[]}
        autonomousDecisions={[]}
        onboarding={{ skillCount: 0 }}
        comparison={{
          rows: [
            {
              skillName: "selftune",
              triggerRate: 0.8,
              routingConfidence: 0.7,
              confidenceCoverage: 0.9,
              sessions: 10,
              lastEvolution: null,
              bucket: "stable",
            },
          ],
        }}
        sectionsBeforeFeed={<div>Before Feed</div>}
        runSummary={{
          lastRun: "2026-04-11T00:00:00Z",
          deployed: 1,
          evolved: 2,
          watched: 3,
          runCount: 4,
        }}
        sectionsAfterFeed={<div>After Feed</div>}
      />,
    );

    expect(html).toContain("Onboarding 0");
    expect(html).toContain("Comparison 1");
    expect(html).toContain("Before Feed");
    expect(html).toContain("Run Summary 4");
    expect(html).toContain("After Feed");
    expect(html.indexOf("Comparison 1")).toBeLessThan(html.indexOf("Before Feed"));
    expect(html.indexOf("Run Summary 4")).toBeLessThan(html.indexOf("After Feed"));
    expect(html).toContain('<div class="col-span-12"><div>Before Feed</div></div>');
  });

  it("omits the comparison block when there are no rows", () => {
    const html = renderToStaticMarkup(
      <OverviewCompositionSurface
        autonomyStatus={{
          level: "needs_review",
          summary: "Needs review",
          skills_observed: 0,
          attention_required: 0,
          pending_reviews: 0,
        }}
        lastRun={null}
        trustWatchlist={[]}
        attentionItems={[]}
        autonomousDecisions={[]}
        comparison={{
          rows: [],
        }}
      />,
    );

    expect(html).not.toContain("Comparison");
  });
});
