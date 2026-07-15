import { timeAgo } from "@selftune/ui/lib";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@selftune/ui/primitives";
import * as Lucide from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";

import { useSkillReport } from "@/hooks/useSkillReport";
import {
  formatActionLabel,
  useLiveActionFeed,
  useSelectedLiveActionEntry,
} from "@/lib/live-action-feed";
import { normalizeLifecycleCommand } from "@/lib/lifecycle-surface";
import type {
  DashboardActionName,
  DashboardActionResultSummary,
  DashboardSearchRunSummary,
  SessionMeta,
} from "@/types";

function statusBadge(status: "running" | "success" | "error") {
  if (status === "running") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Lucide.Loader2 className="size-3 animate-spin" />
        Running
      </Badge>
    );
  }
  if (status === "success") return <Badge variant="default">Validated</Badge>;
  return <Badge variant="destructive">Failed</Badge>;
}

function countValues(
  rows: SessionMeta[],
  selector: (row: SessionMeta) => string | null,
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = selector(row) ?? "Unknown";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .toSorted((left, right) => right.count - left.count)
    .slice(0, 5);
}

function formatPercent(value: number | null): string {
  return value == null ? "--" : `${Math.round(value * 100)}%`;
}

function formatDelta(value: number | null): string {
  return value == null ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatSummaryMode(value: string | null): string {
  if (!value) return "Dry-run";
  return value.replaceAll("_", " ").replaceAll("+", " + ");
}

function formatTitleCase(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatInteger(value: number | null): string {
  return value == null ? "--" : Math.round(value).toLocaleString();
}

function formatCurrency(value: number | null): string {
  return value == null ? "--" : `$${value.toFixed(4)}`;
}

function formatDurationMs(value: number | null): string {
  return value == null ? "--" : `${(value / 1000).toFixed(1)}s`;
}

function formatProgressStatus(
  progress:
    | {
        current: number;
        total: number;
        status: "started" | "finished";
        unit?: "eval" | "llm_call" | "step" | null;
        query: string | null;
        passed: boolean | null;
        evidence: string | null;
      }
    | null
    | undefined,
): string {
  if (!progress) return "Waiting for action progress";
  const unitLabel =
    progress.unit === "llm_call" ? "call" : progress.unit === "step" ? "step" : "eval";
  if (progress.status === "started") {
    return `Running ${unitLabel} ${progress.current}/${progress.total}`;
  }
  if (progress.passed == null) {
    return `Finished ${unitLabel} ${progress.current}/${progress.total}`;
  }
  return `${progress.passed ? "Passed" : "Failed"} ${unitLabel} ${progress.current}/${progress.total}`;
}

function progressUnitLabel(
  progress:
    | {
        unit?: "eval" | "llm_call" | "step" | null;
      }
    | null
    | undefined,
): string {
  if (progress?.unit === "llm_call") return "Current call";
  if (progress?.unit === "step") return "Current step";
  return "Current eval";
}

function progressSubjectLabel(
  progress:
    | {
        unit?: "eval" | "llm_call" | "step" | null;
      }
    | null
    | undefined,
): string {
  if (progress?.unit === "eval") return "Query";
  return "Current item";
}

function formatSampleHeading(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function EvidenceSampleList({
  title,
  emptyState,
  samples,
}: {
  title: string;
  emptyState: string;
  samples: Array<{ query: string; evidence: string | null }>;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-border/15 bg-background px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{title}</div>
      {samples.length === 0 ? (
        <div className="text-sm text-muted-foreground">{emptyState}</div>
      ) : (
        <div className="space-y-2">
          {samples.map((sample) => (
            <div
              key={`${title}:${sample.query}`}
              className="rounded-lg border border-border/10 px-3 py-2"
            >
              <div className="text-sm font-medium text-foreground">{sample.query}</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {sample.evidence ?? "No captured evidence text."}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EfficiencyMetricsCard({
  title,
  metrics,
}: {
  title: string;
  metrics: NonNullable<DashboardActionResultSummary["package_efficiency"]>["with_skill"];
}) {
  return (
    <div className="rounded-xl border border-border/15 bg-background px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{title}</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Duration
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {formatDurationMs(metrics.total_duration_ms)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Eval runs
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {formatInteger(metrics.eval_runs)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Input tokens
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {formatInteger(metrics.total_input_tokens)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Output tokens
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {formatInteger(metrics.total_output_tokens)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Cost</div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {formatCurrency(metrics.total_cost_usd)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Turns</div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {formatInteger(metrics.total_turns)}
          </div>
        </div>
      </div>
    </div>
  );
}

function PackageWatchCard({
  watch,
}: {
  watch: NonNullable<DashboardActionResultSummary["package_watch"]>;
}) {
  return (
    <div className="space-y-4 rounded-xl border border-border/15 bg-background px-4 py-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Window sessions
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {formatInteger(watch.snapshot.window_sessions)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Skill checks
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {formatInteger(watch.snapshot.skill_checks)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Observed pass rate
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {formatPercent(watch.snapshot.pass_rate)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            False negatives
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {formatPercent(watch.snapshot.false_negative_rate)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Regression
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {watch.snapshot.regression_detected ? "Detected" : "Clear"}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Rolled back
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {watch.rolled_back ? "Yes" : "No"}
          </div>
        </div>
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          Invocation signal
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {Object.entries(watch.snapshot.by_invocation_type).map(([label, totals]) => (
            <div key={label} className="rounded-lg border border-border/10 px-3 py-2">
              <div className="text-sm font-medium text-foreground">{formatTitleCase(label)}</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {totals.passed}/{totals.total} passed
              </div>
            </div>
          ))}
        </div>
      </div>

      {watch.grade_regression ? (
        <div className="rounded-lg border border-border/10 px-3 py-2">
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Grade regression
          </div>
          <div className="mt-1 text-sm text-foreground">
            Baseline {formatPercent(watch.grade_regression.before)} / Recent{" "}
            {formatPercent(watch.grade_regression.after)} / Delta{" "}
            {formatDelta(-watch.grade_regression.delta)}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {watch.grade_alert ?? "Grade watch signal detected."}
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border border-border/10 px-3 py-2">
        <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          Recommendation
        </div>
        <div className="mt-1 text-sm text-foreground">{watch.recommendation}</div>
      </div>
    </div>
  );
}

function SearchRunPanel({ searchRun }: { searchRun: DashboardSearchRunSummary }) {
  return (
    <Card className="border-border/20">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lucide.Boxes className="size-4" />
          Package search run
        </CardTitle>
        <CardDescription>
          Bounded package search result showing selected parent, candidates evaluated, and winner
          determination.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Selected parent
            </div>
            <div className="mt-2 truncate text-sm font-semibold font-mono">
              {searchRun.parent_candidate_id
                ? searchRun.parent_candidate_id.slice(0, 12)
                : "None (root)"}
            </div>
          </div>
          <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Candidates evaluated
            </div>
            <div className="mt-2 text-lg font-semibold">{searchRun.candidates_evaluated}</div>
          </div>
          <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Winner
            </div>
            <div className="mt-2 truncate text-sm font-semibold font-mono">
              {searchRun.winner_candidate_id
                ? searchRun.winner_candidate_id.slice(0, 12)
                : "No winner"}
            </div>
          </div>
          <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Frontier size
            </div>
            <div className="mt-2 text-lg font-semibold">{searchRun.frontier_size}</div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-border/15 bg-background px-4 py-3 text-sm">
            <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Parent selection method
            </div>
            <div className="text-foreground">{searchRun.parent_selection_method}</div>
          </div>
          <div className="rounded-xl border border-border/15 bg-background px-4 py-3 text-sm">
            <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Search ID
            </div>
            <div className="truncate font-mono text-foreground">{searchRun.search_id}</div>
          </div>
          {searchRun.surface_plan ? (
            <div className="rounded-xl border border-border/15 bg-background px-4 py-3 text-sm">
              <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                Surface budget
              </div>
              <div className="text-foreground">
                Routing {searchRun.surface_plan.routing_count}, body{" "}
                {searchRun.surface_plan.body_count}
              </div>
              {searchRun.surface_plan.routing_weakness != null &&
              searchRun.surface_plan.body_weakness != null ? (
                <div className="mt-1 text-xs text-foreground">
                  Weakness: routing {(searchRun.surface_plan.routing_weakness * 100).toFixed(1)}%,
                  body {(searchRun.surface_plan.body_weakness * 100).toFixed(1)}%
                </div>
              ) : null}
              <div className="mt-1 text-xs text-muted-foreground">
                {searchRun.surface_plan.weakness_source}
              </div>
            </div>
          ) : null}
        </div>

        {searchRun.winner_rationale ? (
          <div className="mt-4 rounded-xl border border-border/15 bg-background px-4 py-3 text-sm text-muted-foreground">
            <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Winner rationale
            </div>
            <div className="text-foreground">{searchRun.winner_rationale}</div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function LiveRun() {
  const [searchParams, setSearchParams] = useSearchParams();
  const eventId = searchParams.get("event") || undefined;
  const skillName = searchParams.get("skill") || undefined;
  const action = (searchParams.get("action") || undefined) as DashboardActionName | undefined;

  const entries = useLiveActionFeed();
  const selectedEntry = useSelectedLiveActionEntry({
    eventId,
    skillName,
    action,
    preferRunning: true,
  });
  const selectedSkillName = selectedEntry?.skillName ?? skillName;
  const skillQuery = useSkillReport(selectedSkillName);
  const sessionMetadata = skillQuery.data?.session_metadata ?? [];
  const platformCounts = countValues(sessionMetadata, (row) => row.platform);
  const modelCounts = countValues(sessionMetadata, (row) => row.model);
  const agentCounts = countValues(sessionMetadata, (row) => row.agent_cli);

  const recentEntries = entries.filter((entry) => {
    if (skillName && entry.skillName !== skillName) return false;
    return true;
  });
  const packageEvaluationSource = selectedEntry?.summary?.package_evaluation_source ?? null;
  const packageCandidateId = selectedEntry?.summary?.package_candidate_id ?? null;
  const packageParentCandidateId = selectedEntry?.summary?.package_parent_candidate_id ?? null;
  const packageCandidateGeneration = selectedEntry?.summary?.package_candidate_generation ?? null;
  const packageCandidateAcceptanceDecision =
    selectedEntry?.summary?.package_candidate_acceptance_decision ?? null;
  const packageCandidateAcceptanceRationale =
    selectedEntry?.summary?.package_candidate_acceptance_rationale ?? null;
  const packageEvidence = selectedEntry?.summary?.package_evidence ?? null;
  const packageEfficiency = selectedEntry?.summary?.package_efficiency ?? null;
  const packageRouting = selectedEntry?.summary?.package_routing ?? null;
  const packageBody = selectedEntry?.summary?.package_body ?? null;
  const packageGrading = selectedEntry?.summary?.package_grading ?? null;
  const packageUnitTests = selectedEntry?.summary?.package_unit_tests ?? null;
  const packageWatch = selectedEntry?.summary?.package_watch ?? null;
  const recommendedCommand = normalizeLifecycleCommand(
    selectedEntry?.summary?.recommended_command ?? null,
  );
  const evidenceGroups = packageEvidence
    ? [
        {
          title: formatSampleHeading(
            packageEvidence.replay_failures,
            "replay failure",
            "replay failures",
          ),
          emptyState: "No failed replay examples were captured.",
          samples: packageEvidence.replay_failure_samples,
        },
        {
          title: formatSampleHeading(
            packageEvidence.baseline_wins,
            "baseline win",
            "baseline wins",
          ),
          emptyState: "No with-skill wins were captured.",
          samples: packageEvidence.baseline_win_samples,
        },
        {
          title: formatSampleHeading(
            packageEvidence.baseline_regressions,
            "baseline regression",
            "baseline regressions",
          ),
          emptyState: "No with-skill regressions were captured.",
          samples: packageEvidence.baseline_regression_samples,
        },
      ]
    : [];

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-6 py-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-muted-foreground">
            <Link
              to={
                selectedSkillName ? `/skills/${encodeURIComponent(selectedSkillName)}` : "/skills"
              }
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <Lucide.ArrowLeft className="size-3" />
              Back to skill
            </Link>
            <span>/</span>
            <span>Live run</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">
              {selectedEntry ? formatActionLabel(selectedEntry.action) : "Lifecycle live run"}
            </h1>
            {selectedEntry ? statusBadge(selectedEntry.status) : null}
            {selectedSkillName ? <Badge variant="outline">{selectedSkillName}</Badge> : null}
          </div>
          <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
            Dedicated streaming view for lifecycle actions. This screen shows the live terminal
            output, parsed measured action result, and historical platform/model/token aggregates
            for the selected skill.
          </p>
        </div>

        <div className="rounded-2xl border border-border/20 bg-muted/20 px-4 py-3 text-right">
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            Watching
          </div>
          <div className="mt-1 text-sm font-medium">
            {selectedEntry?.startedAt
              ? timeAgo(new Date(selectedEntry.startedAt).toISOString())
              : "Waiting for stream"}
          </div>
          <div className="mt-1 text-[11px] font-mono text-muted-foreground">
            {selectedEntry?.id ?? "Awaiting action event"}
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_400px]">
        <div className="space-y-6">
          <Card className="border-border/20">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <Lucide.Activity className="size-4" />
                Run summary
              </CardTitle>
              <CardDescription>
                Structured action result when creator-loop commands emit machine-readable output.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {selectedEntry?.summary ? (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                      {selectedEntry.summary.before_label ?? "Before"}
                    </div>
                    <div className="mt-2 text-lg font-semibold">
                      {formatPercent(selectedEntry.summary.before_pass_rate)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                      {selectedEntry.summary.after_label ?? "After"}
                    </div>
                    <div className="mt-2 text-lg font-semibold">
                      {formatPercent(selectedEntry.summary.after_pass_rate)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                      {selectedEntry.summary.net_change_label ?? "Net change"}
                    </div>
                    <div className="mt-2 text-lg font-semibold">
                      {formatDelta(selectedEntry.summary.net_change)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                      {selectedEntry.summary.validation_label ?? "Validation"}
                    </div>
                    <div className="mt-2 text-lg font-semibold">
                      {formatSummaryMode(selectedEntry.summary.validation_mode)}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-border/20 px-4 py-8 text-sm text-muted-foreground">
                  No structured summary yet. Start a create check, replay dry-run, publish, or watch
                  flow from the skill report to stream measured results into this screen.
                </div>
              )}

              {selectedEntry?.summary?.reason ? (
                <div className="mt-4 rounded-xl border border-border/15 bg-background px-4 py-3 text-sm text-muted-foreground">
                  {selectedEntry.summary.reason}
                </div>
              ) : null}

              {recommendedCommand ? (
                <div className="mt-4 rounded-xl border border-border/15 bg-background px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Recommended next command
                  </div>
                  <div className="mt-2 font-mono text-sm text-foreground">{recommendedCommand}</div>
                </div>
              ) : null}

              {packageEvidence ? (
                <div className="mt-4 space-y-4">
                  {packageEvaluationSource || packageCandidateId ? (
                    <div className="grid gap-3 md:grid-cols-4">
                      <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                          Evaluation source
                        </div>
                        <div className="mt-2 text-lg font-semibold">
                          {packageEvaluationSource === "artifact_cache"
                            ? "Cached artifact"
                            : packageEvaluationSource === "candidate_cache"
                              ? "Accepted candidate cache"
                              : "Fresh"}
                        </div>
                      </div>
                      {packageCandidateId ? (
                        <>
                          <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                              Candidate
                            </div>
                            <div className="mt-2 text-sm font-semibold text-foreground">
                              {packageCandidateId}
                            </div>
                          </div>
                          <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                              Parent / generation
                            </div>
                            <div className="mt-2 text-sm font-semibold text-foreground">
                              {packageParentCandidateId ?? "root"} /{" "}
                              {packageCandidateGeneration ?? 0}
                            </div>
                          </div>
                        </>
                      ) : null}
                      {packageCandidateAcceptanceDecision ? (
                        <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                            Candidate acceptance
                          </div>
                          <div className="mt-2 text-sm font-semibold text-foreground">
                            {packageCandidateAcceptanceDecision}
                          </div>
                          {packageCandidateAcceptanceRationale ? (
                            <div className="mt-2 text-xs text-muted-foreground">
                              {packageCandidateAcceptanceRationale}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Measured package evidence
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Replay failures
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatInteger(packageEvidence.replay_failures)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Baseline wins
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatInteger(packageEvidence.baseline_wins)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Baseline regressions
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatInteger(packageEvidence.baseline_regressions)}
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-3 xl:grid-cols-3">
                    {evidenceGroups.map((group) => (
                      <EvidenceSampleList
                        key={group.title}
                        title={group.title}
                        emptyState={group.emptyState}
                        samples={group.samples}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {packageEfficiency ? (
                <div className="mt-4 space-y-4">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Measured efficiency
                  </div>
                  <div className="grid gap-3 xl:grid-cols-2">
                    <EfficiencyMetricsCard
                      title="With skill"
                      metrics={packageEfficiency.with_skill}
                    />
                    <EfficiencyMetricsCard
                      title="Without skill"
                      metrics={packageEfficiency.without_skill}
                    />
                  </div>
                </div>
              ) : null}

              {packageRouting ? (
                <div className="mt-4 space-y-4">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Routing validation
                  </div>
                  <div className="grid gap-3 md:grid-cols-4">
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Pass rate
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatPercent(packageRouting.pass_rate)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Passed
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {packageRouting.passed}/{packageRouting.total}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Fixture
                      </div>
                      <div className="mt-2 text-sm font-semibold text-foreground">
                        {packageRouting.fixture_id}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Runtime
                      </div>
                      <div className="mt-2 text-sm font-semibold text-foreground">
                        {formatDurationMs(
                          packageRouting.runtime_metrics?.total_duration_ms ?? null,
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {packageBody ? (
                <div className="mt-4 space-y-4">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Body validation
                  </div>
                  <div className="grid gap-3 md:grid-cols-4">
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Structural
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {packageBody.structural_valid ? "Pass" : "Fail"}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Quality
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {packageBody.quality_score == null
                          ? "--"
                          : packageBody.quality_score.toFixed(2)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Threshold
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {packageBody.quality_threshold.toFixed(2)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Valid
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {packageBody.valid ? "Yes" : "No"}
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-3 xl:grid-cols-2">
                    <div className="rounded-xl border border-border/15 bg-background px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Structural reason
                      </div>
                      <div className="mt-2 text-sm text-foreground">
                        {packageBody.structural_reason}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-background px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Quality rationale
                      </div>
                      <div className="mt-2 text-sm text-foreground">
                        {packageBody.quality_reason ?? "No body-quality rationale captured."}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {packageGrading ? (
                <div className="mt-4 space-y-4">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Measured grading context
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Baseline grade
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatPercent(packageGrading.baseline?.pass_rate ?? null)}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {packageGrading.baseline
                          ? `${formatInteger(packageGrading.baseline.sample_size)} graded sessions`
                          : "No grading baseline"}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Recent average
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatPercent(packageGrading.recent?.average_pass_rate ?? null)}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {packageGrading.recent
                          ? `${formatInteger(packageGrading.recent.sample_size)} recent grading runs`
                          : "No recent grading runs"}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Grade delta
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatDelta(packageGrading.pass_rate_delta)}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {packageGrading.regressed == null
                          ? "Regression unknown"
                          : packageGrading.regressed
                            ? "Recent grading is below baseline"
                            : "Recent grading is at or above baseline"}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Mean score delta
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatDelta(packageGrading.mean_score_delta)}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {packageGrading.baseline?.mean_score != null &&
                        packageGrading.recent?.average_mean_score != null
                          ? `Baseline ${packageGrading.baseline.mean_score.toFixed(2)} / Recent ${packageGrading.recent.average_mean_score.toFixed(2)}`
                          : "Mean score unavailable"}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {packageUnitTests ? (
                <div className="mt-4 space-y-4">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Deterministic unit tests
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Pass rate
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatPercent(packageUnitTests.pass_rate)}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {packageUnitTests.passed}/{packageUnitTests.total} passing
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Failing tests
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatInteger(packageUnitTests.failed)}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Latest run {packageUnitTests.run_at}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Failure samples
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatInteger(packageUnitTests.failing_tests.length)}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Representative deterministic failures
                      </div>
                    </div>
                  </div>
                  {packageUnitTests.failing_tests.length > 0 ? (
                    <div className="grid gap-3 xl:grid-cols-3">
                      {packageUnitTests.failing_tests.map((failure) => (
                        <div
                          key={failure.test_id}
                          className="rounded-xl border border-border/15 bg-background px-4 py-3"
                        >
                          <div className="text-sm font-medium text-foreground">
                            {failure.test_id}
                          </div>
                          <div className="mt-2 text-sm text-muted-foreground">
                            {failure.error ?? "Assertions failed without an explicit error."}
                          </div>
                          {failure.failed_assertions.length > 0 ? (
                            <div className="mt-2 text-xs text-muted-foreground">
                              {failure.failed_assertions.join(" | ")}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {packageWatch ? (
                <div className="mt-4 space-y-4">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Measured watch signal
                  </div>
                  <PackageWatchCard watch={packageWatch} />
                </div>
              ) : null}

              {selectedEntry?.summary?.watch_gate_passed != null ? (
                <div className="mt-4 flex items-center gap-2">
                  <Badge
                    variant={selectedEntry.summary.watch_gate_passed ? "default" : "destructive"}
                  >
                    Watch gate: {selectedEntry.summary.watch_gate_passed ? "Passed" : "Alert"}
                  </Badge>
                  {!selectedEntry.summary.watch_gate_passed ? (
                    <span className="text-xs text-muted-foreground">
                      Active watch alerts detected. Review before proceeding.
                    </span>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>

          {selectedEntry?.summary?.search_run ? (
            <SearchRunPanel searchRun={selectedEntry.summary.search_run} />
          ) : null}

          <Card className="border-border/20">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <Lucide.Activity className="size-4" />
                Live action progress
              </CardTitle>
              <CardDescription>
                Structured progress updates from the active creator-loop action. Create check emits
                draft-validation steps, replay emits per-eval progress, and eval generation plus
                unit-test generation emit step and LLM-call progress through the same contract.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {selectedEntry?.progress ? (
                <div className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        {progressUnitLabel(selectedEntry.progress)}
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {selectedEntry.progress.current}/{selectedEntry.progress.total}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Status
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatProgressStatus(selectedEntry.progress)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Outcome
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {selectedEntry.progress.passed == null
                          ? "Pending"
                          : selectedEntry.progress.passed
                            ? "Pass"
                            : "Fail"}
                      </div>
                    </div>
                  </div>

                  {selectedEntry.progress.phase ? (
                    <div className="rounded-xl border border-border/15 bg-background px-4 py-3 text-sm text-muted-foreground">
                      <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Phase
                      </div>
                      <div className="text-foreground">
                        {selectedEntry.progress.phase.replaceAll("_", " ")}
                      </div>
                    </div>
                  ) : null}

                  {(selectedEntry.progress.label ?? selectedEntry.progress.query) ? (
                    <div className="rounded-xl border border-border/15 bg-background px-4 py-3 text-sm text-muted-foreground">
                      <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        {progressSubjectLabel(selectedEntry.progress)}
                      </div>
                      <div className="text-foreground">
                        {selectedEntry.progress.label ?? selectedEntry.progress.query}
                      </div>
                    </div>
                  ) : null}

                  {selectedEntry.progress.evidence ? (
                    <div className="rounded-xl border border-border/15 bg-background px-4 py-3 text-sm text-muted-foreground">
                      <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Last detail
                      </div>
                      <div>{selectedEntry.progress.evidence}</div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-border/20 px-4 py-8 text-sm text-muted-foreground">
                  Waiting for structured progress. Open this page before or during a creator-loop
                  run to watch evals, LLM calls, or action steps stream through.
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/20">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <Lucide.Cpu className="size-4" />
                Live runtime metrics
              </CardTitle>
              <CardDescription>
                Per-run metadata emitted from the active action runtime. Replay still has the
                richest token and cost detail today, while other provider-backed actions emit
                normalized platform, model, and duration updates through the same metrics surface.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {selectedEntry?.metrics ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">
                      {selectedEntry.metrics.platform ?? "Unknown platform"}
                    </Badge>
                    <Badge variant="secondary">
                      {selectedEntry.metrics.model ?? "Unknown model"}
                    </Badge>
                    {selectedEntry.metrics.session_id ? (
                      <Badge variant="outline">{selectedEntry.metrics.session_id}</Badge>
                    ) : null}
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Input tokens
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatInteger(selectedEntry.metrics.input_tokens)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Output tokens
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatInteger(selectedEntry.metrics.output_tokens)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Cache read
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatInteger(selectedEntry.metrics.cache_read_input_tokens)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Cache create
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatInteger(selectedEntry.metrics.cache_creation_input_tokens)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Cost
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatCurrency(selectedEntry.metrics.total_cost_usd)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Duration
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatDurationMs(selectedEntry.metrics.duration_ms)}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="rounded-xl border border-dashed border-border/20 px-4 py-8 text-sm text-muted-foreground">
                  Waiting for structured runtime metrics. Replay emits token and cost detail today,
                  while other actions emit normalized provider/model/duration data once their LLM
                  calls start and finish.
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/20">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <Lucide.TerminalSquare className="size-4" />
                Streaming output
              </CardTitle>
              <CardDescription>
                Live stdout and stderr from the active creator-loop action.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="max-h-[640px] overflow-auto rounded-2xl border border-border/15 bg-zinc-950 px-4 py-3 font-mono text-[12px] leading-6 text-zinc-100">
                {selectedEntry?.logs.length ? (
                  selectedEntry.logs.map((log) => (
                    <div
                      key={log.id}
                      className={
                        log.stage === "stderr"
                          ? "text-amber-300"
                          : log.stage === "progress"
                            ? "text-emerald-300"
                            : log.stage === "metrics"
                              ? "text-sky-300"
                              : ""
                      }
                    >
                      <span className="mr-3 text-zinc-500">
                        {new Date(log.ts).toLocaleTimeString()}
                      </span>
                      <span className="mr-3 inline-block min-w-16 text-zinc-500">
                        [{log.stage}]
                      </span>
                      <span>{log.text}</span>
                    </div>
                  ))
                ) : (
                  <div className="text-zinc-500">
                    Waiting for live output. Start a dashboard action or run a supported `selftune`
                    command in another terminal.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="border-border/20">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <Lucide.Cpu className="size-4" />
                Skill telemetry context
              </CardTitle>
              <CardDescription>
                Historical aggregate data for the selected skill. This uses the existing skill
                report telemetry so you can narrate model and token footprint during the demo.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Input tokens
                  </div>
                  <div className="mt-2 text-lg font-semibold">
                    {skillQuery.data?.token_usage.total_input_tokens.toLocaleString() ?? "--"}
                  </div>
                </div>
                <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Output tokens
                  </div>
                  <div className="mt-2 text-lg font-semibold">
                    {skillQuery.data?.token_usage.total_output_tokens.toLocaleString() ?? "--"}
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  <Lucide.Boxes className="size-3.5" />
                  Platforms
                </div>
                <div className="flex flex-wrap gap-2">
                  {platformCounts.length ? (
                    platformCounts.map((item) => (
                      <Badge key={`platform-${item.label}`} variant="secondary">
                        {item.label} · {item.count}
                      </Badge>
                    ))
                  ) : (
                    <Badge variant="outline">No platform data yet</Badge>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  <Lucide.Bot className="size-3.5" />
                  Models
                </div>
                <div className="flex flex-wrap gap-2">
                  {modelCounts.length ? (
                    modelCounts.map((item) => (
                      <Badge key={`model-${item.label}`} variant="secondary">
                        {item.label} · {item.count}
                      </Badge>
                    ))
                  ) : (
                    <Badge variant="outline">No model data yet</Badge>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  <Lucide.Cpu className="size-3.5" />
                  Agent CLIs
                </div>
                <div className="flex flex-wrap gap-2">
                  {agentCounts.length ? (
                    agentCounts.map((item) => (
                      <Badge key={`agent-${item.label}`} variant="secondary">
                        {item.label} · {item.count}
                      </Badge>
                    ))
                  ) : (
                    <Badge variant="outline">No agent CLI data yet</Badge>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/20">
            <CardHeader className="pb-4">
              <CardTitle className="text-base">Recent live runs</CardTitle>
              <CardDescription>
                Quick jump list for the latest streamed creator-loop actions.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {recentEntries.length ? (
                recentEntries.slice(0, 8).map((entry) => {
                  const params = new URLSearchParams();
                  params.set("event", entry.id);
                  if (entry.skillName) params.set("skill", entry.skillName);
                  params.set("action", entry.action);
                  return (
                    <Button
                      key={entry.id}
                      variant="outline"
                      className="h-auto w-full justify-start px-3 py-3 text-left"
                      onClick={() => setSearchParams(params)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {formatActionLabel(entry.action)}
                          </div>
                          <div className="mt-1 truncate text-[11px] text-muted-foreground">
                            {entry.skillName ?? "No skill"} ·{" "}
                            {timeAgo(new Date(entry.updatedAt).toISOString())}
                          </div>
                        </div>
                        {statusBadge(entry.status)}
                      </div>
                    </Button>
                  );
                })
              ) : (
                <div className="rounded-xl border border-dashed border-border/20 px-4 py-6 text-sm text-muted-foreground">
                  No live runs have been observed in this browser session yet.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
