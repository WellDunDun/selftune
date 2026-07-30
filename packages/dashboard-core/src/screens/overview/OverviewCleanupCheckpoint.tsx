import type { ReactNode } from "react";
import { ArchiveIcon, HistoryIcon, LinkIcon, ShieldCheckIcon } from "lucide-react";

import {
  Badge,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@selftune/ui/primitives";

export interface OverviewCleanupCandidate {
  skillName: string;
  reason: string;
  lastInvokedAt: string | null;
  inactiveDays: number;
  sessionsSinceInvocation: number;
}

export interface OverviewCleanupCheckpointProps {
  activeSkillCount: number;
  candidates: readonly OverviewCleanupCandidate[];
  evidencePendingCount: number;
  archivedCount: number;
  reviewAction: ReactNode;
  restoreAction?: ReactNode;
  consolidationCandidates?: readonly OverviewConsolidationCandidate[];
  consolidationAction?: ReactNode;
}

export interface OverviewConsolidationCandidate {
  skillName: string;
  installedCount: number;
  projectCount: number;
  confidence: "source_current" | "review_required";
}

export function OverviewCleanupCheckpoint({
  activeSkillCount,
  candidates,
  evidencePendingCount,
  archivedCount,
  reviewAction,
  restoreAction,
  consolidationCandidates = [],
  consolidationAction,
}: OverviewCleanupCheckpointProps) {
  const recommendationCount = candidates.length + consolidationCandidates.length;
  if (recommendationCount === 0) return null;

  return (
    <Card className="col-span-12 overflow-hidden border-primary/20 bg-primary/[0.04] shadow-none">
      <CardHeader className="gap-3 border-b border-border/10">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ArchiveIcon className="size-4" />
            </span>
            <CardTitle className="text-base">Cleanup ready</CardTitle>
            <Badge variant="secondary">{recommendationCount} recommended</Badge>
          </div>
          <CardDescription>
            {candidates.length > 0
              ? `${candidates.length} of ${activeSkillCount} active skills have enough inactivity evidence for archive review.`
              : null}
            {candidates.length > 0 && consolidationCandidates.length > 0 ? " " : null}
            {consolidationCandidates.length > 0
              ? `${consolidationCandidates.length} duplicate-install recommendation${consolidationCandidates.length === 1 ? "" : "s"} can reduce repeated project context.`
              : null}
          </CardDescription>
        </div>
        <CardAction className="flex flex-wrap gap-2">
          {candidates.length > 0 ? reviewAction : null}
          {consolidationCandidates.length > 0 ? consolidationAction : null}
        </CardAction>
      </CardHeader>

      <CardContent className="grid gap-4 pt-5 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {candidates.slice(0, 3).map((candidate) => (
            <div
              key={candidate.skillName}
              className="rounded-xl border border-border/15 bg-background/70 px-4 py-3"
              title={candidate.reason}
            >
              <p className="truncate text-sm font-medium">{candidate.skillName}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {candidate.inactiveDays} days inactive · {candidate.sessionsSinceInvocation} later
                sessions
              </p>
            </div>
          ))}
          {consolidationCandidates.slice(0, Math.max(0, 3 - candidates.length)).map((candidate) => (
            <div
              key={`consolidate:${candidate.skillName}`}
              className="rounded-xl border border-border/15 bg-background/70 px-4 py-3"
            >
              <p className="truncate text-sm font-medium">{candidate.skillName}</p>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <LinkIcon className="size-3.5 shrink-0" /> {candidate.installedCount} installations
                · {candidate.projectCount} project link
                {candidate.projectCount === 1 ? "" : "s"}
              </p>
              {candidate.confidence === "review_required" ? (
                <p className="mt-1 text-xs text-muted-foreground">Canonical review required</p>
              ) : null}
            </div>
          ))}
        </div>

        <div className="flex min-w-56 flex-col justify-center gap-2 text-xs text-muted-foreground">
          <p className="flex items-center gap-2">
            <ShieldCheckIcon className="size-3.5 text-primary" /> No files will be deleted
          </p>
          {evidencePendingCount > 0 ? (
            <p className="flex items-center gap-2">
              <HistoryIcon className="size-3.5" /> {evidencePendingCount} skill
              {evidencePendingCount === 1 ? "" : "s"} still need more evidence
            </p>
          ) : null}
          {archivedCount > 0 && restoreAction ? (
            <div className="pt-1">
              {archivedCount} archived · {restoreAction}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
