"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import {
  SkillReportGuideSheet,
  SkillReportOnboardingBanner,
  SkillReportTopRow,
  SkillTrustNarrativePanel,
  TrustSignalsGrid,
} from "@selftune/ui/components";
import { Button } from "@selftune/ui/primitives";
import type { TrustFields, TrustState } from "@selftune/ui/types";

export interface SkillReportNextAction {
  icon: ReactNode;
  text: string;
  actionLabel: string;
  variant: "default" | "secondary" | "destructive" | "outline";
}

export interface SkillReportScaffoldProps {
  backLink: ReactNode;
  title: string;
  statusBadge?: ReactNode;
  toolbarMeta?: ReactNode;
  summary?: ReactNode;
  showOnboardingBanner?: boolean;
  guideButtonLabel?: string;
  nextAction: SkillReportNextAction;
  trustState: TrustState;
  coverage?: TrustFields["coverage"];
  evidenceQuality?: TrustFields["evidence_quality"];
  routingQuality?: TrustFields["routing_quality"];
  evolutionState?: TrustFields["evolution_state"];
  dataHygiene?: TrustFields["data_hygiene"];
  fallbackChecks: number;
  fallbackSessions: number;
  fallbackEvidenceRows: number;
  fallbackEvolutionRows: number;
  fallbackLatestAction?: string;
  nextActionText: string;
  children?: ReactNode;
}

export function SkillReportScaffold({
  backLink,
  title,
  statusBadge,
  toolbarMeta,
  summary,
  showOnboardingBanner = false,
  guideButtonLabel = "How to read this page",
  nextAction,
  trustState,
  coverage,
  evidenceQuality,
  routingQuality,
  evolutionState,
  dataHygiene,
  fallbackChecks,
  fallbackSessions,
  fallbackEvidenceRows,
  fallbackEvolutionRows,
  fallbackLatestAction,
  nextActionText,
  children,
}: SkillReportScaffoldProps) {
  const [isGuideOpen, setIsGuideOpen] = useState(false);

  return (
    <>
      <SkillReportGuideSheet open={isGuideOpen} onOpenChange={setIsGuideOpen} />

      <div className="@container/main flex flex-1 flex-col gap-5 p-4 lg:px-6 lg:pb-6 lg:pt-0">
        <div className="sticky top-0 z-30 space-y-2 border-b border-border/15 bg-background/95 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="flex flex-wrap items-center gap-3">
            {backLink}
            <h1 className="shrink-0 font-headline text-base font-semibold tracking-tight lg:text-lg">
              {title}
            </h1>
            {statusBadge}
            <div className="ml-auto flex shrink-0 items-center gap-4">
              <Button variant="outline" size="sm" onClick={() => setIsGuideOpen(true)}>
                {guideButtonLabel}
              </Button>
              {toolbarMeta}
            </div>
          </div>

          {summary ? (
            <div className="space-y-1.5 text-sm leading-relaxed text-muted-foreground">
              {summary}
            </div>
          ) : null}
        </div>

        {showOnboardingBanner ? (
          <SkillReportOnboardingBanner onOpenGuide={() => setIsGuideOpen(true)} />
        ) : null}

        <div className="space-y-4">
          <SkillReportTopRow
            nextAction={nextAction}
            latestDecision={
              (evolutionState?.evolution_rows ?? fallbackEvolutionRows) > 0 &&
              (evolutionState?.latest_action ?? fallbackLatestAction)
                ? {
                    action: evolutionState?.latest_action ?? fallbackLatestAction ?? "No data",
                    timestamp: evolutionState?.latest_timestamp ?? null,
                    evolutionCount: evolutionState?.evolution_rows ?? fallbackEvolutionRows,
                  }
                : undefined
            }
          />

          <SkillTrustNarrativePanel
            trustState={trustState}
            coverage={coverage}
            evidenceQuality={evidenceQuality}
            routingQuality={routingQuality}
            evolutionState={evolutionState}
            dataHygiene={dataHygiene}
            fallbackChecks={fallbackChecks}
            fallbackSessions={fallbackSessions}
            nextActionText={nextActionText}
            onOpenGuide={() => setIsGuideOpen(true)}
          />

          <TrustSignalsGrid
            coverage={coverage}
            evidenceQuality={evidenceQuality}
            routingQuality={routingQuality}
            evolutionState={evolutionState}
            fallbackChecks={fallbackChecks}
            fallbackSessions={fallbackSessions}
            fallbackEvidenceRows={fallbackEvidenceRows}
            fallbackEvolutionRows={fallbackEvolutionRows}
            fallbackLatestAction={fallbackLatestAction}
          />
        </div>

        {children ? (
          <div className="space-y-4 border-t border-border/10 pt-4">{children}</div>
        ) : null}
      </div>
    </>
  );
}
