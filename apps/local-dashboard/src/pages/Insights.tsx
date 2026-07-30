import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@selftune/ui/primitives";
import { DurableDecisionCard } from "@selftune/dashboard-core/screens/decisions";
import { PageHeader, PageScaffold } from "@selftune/ui/components";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  Clock3Icon,
  GitMergeIcon,
  FlaskConicalIcon,
  LightbulbIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PackageCheckIcon,
  RefreshCwIcon,
  RouteIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  useDraftInsight,
  useEvaluateInsight,
  useInsights,
  useReleaseInsight,
  useReviewInsight,
} from "@/hooks/useInsights";
import {
  useDecideDurableDecision,
  useDurableDecisions,
  useRollbackDurableDecision,
} from "@/hooks/useDecisions";
import { mapDurableDecision } from "@/dashboard-host";
import type { InsightsResponse, ReviewInsightRequest } from "@/types";

type Candidate = InsightsResponse["snapshot"]["candidates"][number];

const kindLabel: Record<Candidate["kind"], string> = {
  coverage_gap: "Coverage gap",
  workflow_combination: "Workflow combination",
  routing_problem: "Routing repair",
  stale_skill: "Stale skill",
};

const INSIGHT_SKELETON_IDS = ["first", "second", "third"] as const;
const INSIGHT_STAT_SKELETON_IDS = ["first", "second", "third", "fourth"] as const;

function InsightsSkeleton() {
  return (
    <PageScaffold aria-label="Loading insights" aria-busy="true">
      <header className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-4 w-44" />
        </div>
        <Skeleton className="h-8 w-24" />
      </header>

      <section className="grid grid-cols-2 border-y border-border/60 sm:grid-cols-4">
        {INSIGHT_STAT_SKELETON_IDS.map((id) => (
          <div
            key={id}
            className="flex flex-col gap-2 border-r border-border/50 px-4 py-4 last:border-r-0"
          >
            <Skeleton className="h-7 w-10" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </section>

      <section className="flex flex-col" aria-hidden="true">
        {INSIGHT_SKELETON_IDS.map((id) => (
          <div
            key={id}
            className="flex flex-col gap-3 border-b border-border/60 py-4 first:border-t"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="size-4" />
                  <Skeleton className="h-4 w-48 max-w-full" />
                  <Skeleton className="h-5 w-20" />
                </div>
                <Skeleton className="h-4 w-full max-w-xl" />
              </div>
              <Skeleton className="h-8 w-20 shrink-0" />
            </div>
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </section>
    </PageScaffold>
  );
}

function Evidence({ candidate }: { candidate: Candidate }) {
  const evidence = candidate.evidence;
  return (
    <Collapsible className="border-t border-border/50 pt-2 text-xs text-muted-foreground">
      <CollapsibleTrigger
        render={<Button variant="ghost" size="sm" className="w-full justify-between px-0" />}
      >
        Evidence details
        <ChevronDownIcon data-icon="inline-end" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          <span>{evidence.supportSessions} sessions</span>
          <span>{evidence.projectDiversity} projects</span>
          <span>{Math.round(evidence.confidence * 100)}% confidence</span>
          <span>{Math.round(evidence.outcomeQuality * 100)}% outcome quality</span>
          {evidence.coUsageLift !== null ? (
            <span>{evidence.coUsageLift.toFixed(2)}x co-usage lift</span>
          ) : null}
          {evidence.sequenceConsistency !== null ? (
            <span>{Math.round(evidence.sequenceConsistency * 100)}% order consistency</span>
          ) : null}
          <span>{candidate.heldOutSessionIds.length} held out</span>
          <span>{evidence.exploratory ? "Exploratory" : "Multi-project evidence"}</span>
        </div>
        {candidate.redactedExcerpts.length > 0 ? (
          <div className="mt-3 flex flex-col gap-1 border-l-2 border-border pl-3">
            {candidate.redactedExcerpts.map((excerpt) => (
              <p key={excerpt} className="break-words">
                {excerpt}
              </p>
            ))}
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function Insights() {
  const insights = useInsights();
  const review = useReviewInsight();
  const draft = useDraftInsight();
  const evaluate = useEvaluateInsight();
  const release = useReleaseInsight();
  const durableDecisions = useDurableDecisions();
  const decideDurable = useDecideDurableDecision();
  const rollbackDurable = useRollbackDurableDecision();
  const [reviewing, setReviewing] = useState<{
    candidate: Candidate;
    action: ReviewInsightRequest["action"];
  } | null>(null);
  const [reason, setReason] = useState("");
  const [editedTitle, setEditedTitle] = useState("");
  const [editedSummary, setEditedSummary] = useState("");

  if (insights.isLoading) {
    return <InsightsSkeleton />;
  }
  if (insights.error || !insights.data) {
    return (
      <PageScaffold className="flex-row items-center justify-between">
        <p className="text-sm text-destructive">
          {insights.error instanceof Error
            ? insights.error.message
            : "Insights could not be loaded."}
        </p>
        <Button variant="outline" size="sm" onClick={() => void insights.refetch()}>
          <RefreshCwIcon /> Retry
        </Button>
      </PageScaffold>
    );
  }

  const active = insights.data.snapshot.candidates.filter(
    (candidate) => !["rejected", "released"].includes(candidate.status),
  );
  const completed = insights.data.snapshot.candidates.filter((candidate) =>
    ["rejected", "released"].includes(candidate.status),
  );

  function submitReview() {
    if (!reviewing || !reason.trim()) return;
    review.mutate(
      {
        candidate_id: reviewing.candidate.candidateId,
        action: reviewing.action,
        reason,
        title: reviewing.action === "edit" ? editedTitle : undefined,
        summary: reviewing.action === "edit" ? editedSummary : undefined,
      },
      {
        onSuccess: () => {
          toast.success("Decision recorded");
          setReviewing(null);
          setReason("");
        },
        onError: (error) =>
          toast.error("Decision failed", {
            description: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  function openReview(candidate: Candidate, action: ReviewInsightRequest["action"]) {
    setReviewing({ candidate, action });
    setReason("");
    setEditedTitle(candidate.title);
    setEditedSummary(candidate.summary);
  }

  return (
    <PageScaffold>
      <PageHeader
        title="Insights"
        description={`${
          insights.data.counts.pending +
          insights.data.counts.accepted +
          insights.data.counts.drafted
        } candidates need review`}
        actions={
          <Button variant="outline" size="sm" onClick={() => void insights.refetch()}>
            <RefreshCwIcon
              data-icon="inline-start"
              className={insights.isFetching ? "animate-spin" : ""}
            />
            Scan again
          </Button>
        }
      />

      <section className="grid grid-cols-2 border-y border-border/60 sm:grid-cols-4">
        {[
          ["Pending", insights.data.counts.pending],
          ["Drafts", insights.data.counts.drafted],
          ["Stale reviews", insights.data.counts.stale_reviews],
          ["Routing reviews", insights.data.counts.routing_reviews],
        ].map(([label, value]) => (
          <div key={label} className="border-r border-border/50 px-4 py-4 last:border-r-0">
            <div className="text-2xl font-semibold tabular-nums text-foreground">{value}</div>
            <div className="text-xs text-muted-foreground">{label}</div>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3" aria-label="Synthesis candidates">
        {active.length === 0 ? (
          <div className="border-y border-border/60 py-10 text-center">
            <LightbulbIcon className="mx-auto mb-3 size-5 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No synthesis candidates yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              SelfTune waits for at least three successful independent sessions.
            </p>
          </div>
        ) : (
          active.map((candidate) => (
            <article
              key={candidate.candidateId}
              className="flex flex-col gap-3 border-b border-border/60 py-4 first:border-t"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {candidate.kind === "workflow_combination" ? (
                      <GitMergeIcon className="size-4 shrink-0 text-primary" />
                    ) : (
                      <LightbulbIcon className="size-4 shrink-0 text-primary" />
                    )}
                    <h2
                      className="min-w-0 max-w-full truncate text-sm font-semibold text-foreground [&::first-letter]:uppercase"
                      title={candidate.title}
                    >
                      {candidate.title}
                    </h2>
                    <Badge className="shrink-0" variant="outline">
                      {kindLabel[candidate.kind]}
                    </Badge>
                    <Badge className="shrink-0" variant="secondary">
                      {candidate.status}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-sm text-muted-foreground">{candidate.summary}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {candidate.status === "accepted" ? (
                    <Button
                      size="sm"
                      disabled={draft.isPending}
                      onClick={() =>
                        draft.mutate(
                          { candidate_id: candidate.candidateId },
                          {
                            onSuccess: (result) =>
                              toast.success("Draft created", {
                                description: result.draft.skill_dir,
                              }),
                            onError: (error) =>
                              toast.error("Draft failed", {
                                description: error instanceof Error ? error.message : String(error),
                              }),
                          },
                        )
                      }
                    >
                      <CheckIcon /> {draft.isPending ? "Creating draft" : "Create draft"}
                    </Button>
                  ) : candidate.status === "drafted" ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={evaluate.isPending}
                        onClick={() =>
                          evaluate.mutate(
                            { candidate_id: candidate.candidateId },
                            {
                              onSuccess: (gate) =>
                                gate.recommended
                                  ? toast.success("Release evaluation passed")
                                  : toast.error("Release evaluation blocked", {
                                      description: gate.blockers[0],
                                    }),
                              onError: (error) =>
                                toast.error("Evaluation failed", {
                                  description:
                                    error instanceof Error ? error.message : String(error),
                                }),
                            },
                          )
                        }
                      >
                        <FlaskConicalIcon /> {evaluate.isPending ? "Evaluating" : "Evaluate"}
                      </Button>
                      <Button
                        size="sm"
                        disabled={release.isPending}
                        onClick={() =>
                          release.mutate(
                            { candidate_id: candidate.candidateId },
                            {
                              onSuccess: ({ package_path }) =>
                                toast.success("Released to Library", {
                                  description: package_path,
                                }),
                              onError: (error) =>
                                toast.error("Release blocked", {
                                  description:
                                    error instanceof Error ? error.message : String(error),
                                }),
                            },
                          )
                        }
                      >
                        <PackageCheckIcon /> {release.isPending ? "Releasing" : "Release"}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => openReview(candidate, "accept")}>
                      <CheckIcon /> Accept
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`More actions for ${candidate.title}`}
                        />
                      }
                    >
                      <MoreHorizontalIcon />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuGroup>
                        <DropdownMenuItem onClick={() => openReview(candidate, "snooze")}>
                          <Clock3Icon /> Snooze
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openReview(candidate, "edit")}>
                          <PencilIcon /> Edit candidate
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => openReview(candidate, "reject")}
                        >
                          <XIcon /> Reject
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              <Evidence candidate={candidate} />
            </article>
          ))
        )}
      </section>

      {durableDecisions.data?.decisions.length ? (
        <section className="flex flex-col gap-2" aria-label="Durable decisions">
          <h2 className="text-sm font-semibold text-foreground">Decisions</h2>
          {durableDecisions.data.decisions.map((decision) => {
            const model = mapDurableDecision(decision);
            return (
              <DurableDecisionCard
                key={model.id}
                decision={model}
                pending={decideDurable.isPending || rollbackDurable.isPending}
                onApprove={() => decideDurable.mutate({ decisionId: model.id, action: "approve" })}
                onDecline={() => decideDurable.mutate({ decisionId: model.id, action: "decline" })}
                onRollback={() => rollbackDurable.mutate(model.id)}
              />
            );
          })}
        </section>
      ) : null}

      {insights.data.portfolio_reviews.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Context hygiene</h2>
          {insights.data.portfolio_reviews.map((item) => (
            <div
              key={item.skill_path}
              className="flex items-center gap-3 border-b border-border/50 py-3"
            >
              {item.recommendation === "repair_routing" ? (
                <RouteIcon className="size-4 text-primary" />
              ) : (
                <ArchiveIcon className="size-4 text-primary" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {item.skill_name}
                </div>
                <div className="text-xs text-muted-foreground">{item.reason}</div>
              </div>
              <Badge variant="outline">Review only</Badge>
            </div>
          ))}
        </section>
      ) : null}

      {completed.length > 0 ? (
        <Collapsible className="border-t border-border/60 pt-3">
          <CollapsibleTrigger
            render={<Button variant="ghost" className="w-full justify-between px-0" />}
          >
            Completed decisions ({completed.length})
            <ChevronDownIcon data-icon="inline-end" />
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-2 pt-2">
            {completed.map((candidate) => (
              <div
                key={candidate.candidateId}
                className="flex items-center justify-between py-2 text-sm"
              >
                <span className="truncate text-foreground">{candidate.title}</span>
                <span className="text-muted-foreground">{candidate.status}</span>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      <Dialog
        open={reviewing !== null}
        onOpenChange={(open) => {
          if (!open) setReviewing(null);
        }}
      >
        {reviewing ? (
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {reviewing.action === "accept"
                  ? "Accept candidate"
                  : reviewing.action === "reject"
                    ? "Reject candidate"
                    : reviewing.action === "edit"
                      ? "Edit candidate"
                      : "Snooze candidate"}
              </DialogTitle>
              <DialogDescription className="break-words">
                {reviewing.candidate.title}
              </DialogDescription>
            </DialogHeader>
            {reviewing.action === "edit" ? (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-foreground">Title</span>
                  <Input
                    value={editedTitle}
                    onChange={(event) => setEditedTitle(event.target.value)}
                    className="h-9"
                  />
                </label>
                <label className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-foreground">Summary</span>
                  <Textarea
                    value={editedSummary}
                    onChange={(event) => setEditedSummary(event.target.value)}
                  />
                </label>
              </div>
            ) : null}
            <label className="flex flex-col gap-2">
              <span className="text-xs font-medium text-foreground">Reason</span>
              <Textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Record why this decision is appropriate"
              />
            </label>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setReviewing(null)}>
                Cancel
              </Button>
              <Button disabled={!reason.trim() || review.isPending} onClick={submitReview}>
                Save decision
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </PageScaffold>
  );
}
