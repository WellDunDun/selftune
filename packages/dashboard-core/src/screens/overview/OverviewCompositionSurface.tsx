"use client";

import type { ReactNode } from "react";

import {
  OverviewComparisonSurface,
  type OverviewComparisonSurfaceProps,
} from "./OverviewComparisonSurface";
import { OverviewCoreSurface, type OverviewCoreSurfaceProps } from "./OverviewCoreSurface";
import { OverviewOnboardingBanner } from "./OverviewOnboardingBanner";
import { OverviewRunSummary, type OverviewRunSummaryProps } from "./OverviewRunSummary";

export interface OverviewCompositionSurfaceProps extends Omit<
  OverviewCoreSurfaceProps,
  "beforeHero" | "betweenHeroAndFeed" | "afterFeed"
> {
  onboarding?: {
    skillCount: number;
    storageKey?: string;
  } | null;
  comparison?: Omit<OverviewComparisonSurfaceProps, "renderSkillLink"> | null;
  sectionsBeforeFeed?: ReactNode;
  runSummary?: OverviewRunSummaryProps | null;
  sectionsAfterFeed?: ReactNode;
}

export function OverviewCompositionSurface({
  onboarding,
  comparison,
  sectionsBeforeFeed,
  runSummary,
  sectionsAfterFeed,
  renderSkillLink,
  ...coreProps
}: OverviewCompositionSurfaceProps) {
  const beforeHero = onboarding ? (
    <OverviewOnboardingBanner
      skillCount={onboarding.skillCount}
      storageKey={onboarding.storageKey}
    />
  ) : null;

  const betweenHeroAndFeed =
    comparison || sectionsBeforeFeed ? (
      <>
        {comparison && comparison.rows.length > 0 ? (
          <div className="col-span-12">
            <OverviewComparisonSurface {...comparison} renderSkillLink={renderSkillLink} />
          </div>
        ) : null}
        {sectionsBeforeFeed ? <div className="col-span-12">{sectionsBeforeFeed}</div> : null}
      </>
    ) : null;

  const afterFeed =
    runSummary || sectionsAfterFeed ? (
      <>
        {runSummary ? <OverviewRunSummary {...runSummary} /> : null}
        {sectionsAfterFeed}
      </>
    ) : null;

  return (
    <OverviewCoreSurface
      {...coreProps}
      renderSkillLink={renderSkillLink}
      beforeHero={beforeHero}
      betweenHeroAndFeed={betweenHeroAndFeed}
      afterFeed={afterFeed}
    />
  );
}
