import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@selftune/ui/primitives";
import type { UseQueryResult } from "@tanstack/react-query";
import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";
import { Link } from "react-router-dom";
import {
  OverviewCompositionSurface,
  type OverviewComparisonRow,
} from "@selftune/dashboard-core/screens/overview";

import { Skeleton } from "@/components/ui/skeleton";
import { useOrchestrateRuns } from "@/hooks/useOrchestrateRuns";
import type { CreatorLoopNextStep, OverviewResponse, SkillHealthStatus } from "@/types";

function formatLoopStep(step: CreatorLoopNextStep): string {
  switch (step) {
    case "generate_evals":
      return "Generate evals";
    case "run_unit_tests":
      return "Run unit tests";
    case "run_replay_dry_run":
      return "Replay dry-run";
    case "measure_baseline":
      return "Measure baseline";
    case "deploy_candidate":
      return "Deploy candidate";
    case "watch_deployment":
      return "Watch deployment";
  }
}

function CreatorLoopPanel({ data }: { data: OverviewResponse["creator_testing"] }) {
  if (!data) return null;

  return (
    <Card className="rounded-2xl border-border/15">
      <CardHeader className="gap-2">
        <CardTitle className="text-base">Creator test loop</CardTitle>
        <CardDescription>
          Generate evals, add unit tests, replay a dry-run, measure baseline, then deploy a watched
          candidate. This surface tracks whether each skill is still blocked on testing, ready to
          ship, or already under watch.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">{data.summary}</p>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {[
            ["Generate evals", data.counts.generate_evals],
            ["Run unit tests", data.counts.run_unit_tests],
            ["Replay dry-run", data.counts.run_replay_dry_run],
            ["Measure baseline", data.counts.measure_baseline],
            ["Deploy candidate", data.counts.deploy_candidate],
            ["Watching", data.counts.watch_deployment],
          ].map(([label, count]) => (
            <div key={label} className="rounded-xl border border-border/10 bg-muted/20 px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                {label}
              </div>
              <div className="mt-2 text-2xl font-semibold">{count}</div>
            </div>
          ))}
        </div>

        {data.priorities.length > 0 ? (
          <div className="space-y-3">
            <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Next priorities
            </div>
            <div className="space-y-3">
              {data.priorities.map((priority) => (
                <div
                  key={priority.skill_name}
                  className="rounded-xl border border-border/10 bg-background px-4 py-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/skills/${encodeURIComponent(priority.skill_name)}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {priority.skill_name}
                    </Link>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {formatLoopStep(priority.next_step)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{priority.summary}</p>
                  <code className="mt-2 block overflow-x-auto rounded-md bg-muted/60 px-3 py-2 text-[11px] text-foreground">
                    {priority.recommended_command}
                  </code>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Overview (main export)
// ---------------------------------------------------------------------------

export function Overview({
  search: _search,
  statusFilter: _statusFilter,
  onStatusFilterChange: _onStatusFilterChange,
  overviewQuery,
}: {
  search: string;
  statusFilter: SkillHealthStatus | "ALL";
  onStatusFilterChange: (v: SkillHealthStatus | "ALL") => void;
  overviewQuery: UseQueryResult<OverviewResponse>;
}) {
  const { data, isPending, isError, error, refetch } = overviewQuery;
  const orchestrateQuery = useOrchestrateRuns();

  if (isPending) {
    return (
      <div className="@container/main flex flex-1 flex-col gap-6 py-6 px-4 lg:px-6">
        <Skeleton className="h-[340px] rounded-xl" />
        <div className="grid grid-cols-12 gap-6">
          <Skeleton className="col-span-12 @4xl/main:col-span-8 h-64 rounded-xl" />
          <Skeleton className="col-span-12 @4xl/main:col-span-4 h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
        <AlertCircleIcon className="size-10 text-destructive" />
        <p className="text-sm font-medium text-destructive">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCwIcon className="mr-2 size-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16">
        <p className="text-sm text-muted-foreground">
          No telemetry data found. Run some sessions first.
        </p>
      </div>
    );
  }

  const {
    skills,
    autonomy_status,
    attention_queue,
    trust_watchlist,
    recent_decisions,
    overview,
    creator_testing,
  } = data;

  // Orchestrate summary
  const orchRuns = orchestrateQuery.data?.runs ?? [];
  const latestRun = orchRuns[0];
  const totalDeployed = orchRuns.reduce((s, r) => s + r.deployed, 0);
  const totalEvolved = orchRuns.reduce((s, r) => s + r.evolved, 0);
  const totalWatched = orchRuns.reduce((s, r) => s + r.watched, 0);
  const latestEvolutionBySkill = new Map<string, (typeof overview.evolution)[number]>();
  for (const entry of overview.evolution) {
    if (!entry.skill_name || latestEvolutionBySkill.has(entry.skill_name)) continue;
    latestEvolutionBySkill.set(entry.skill_name, entry);
  }

  const comparisonRows: OverviewComparisonRow[] = skills.map((skill) => {
    const trust = trust_watchlist.find((entry) => entry.skill_name === skill.skill_name);
    const loopStep = skill.testing_readiness?.next_step;
    return {
      skillName: skill.skill_name,
      subtext: `${skill.skill_scope ?? "Unscoped"} · ${skill.total_checks} checks${loopStep && loopStep !== "watch_deployment" ? ` · ${formatLoopStep(loopStep)}` : ""}`,
      triggerRate: trust?.pass_rate ?? skill.pass_rate,
      routingConfidence: skill.routing_confidence,
      confidenceCoverage: skill.confidence_coverage,
      sessions: skill.unique_sessions,
      lastEvolution: latestEvolutionBySkill.get(skill.skill_name) ?? null,
      bucket: trust?.bucket ?? "uncertain",
      sortTimestamp: skill.last_seen ?? null,
    };
  });

  return (
    <OverviewCompositionSurface
      autonomyStatus={autonomy_status}
      lastRun={latestRun?.timestamp ?? null}
      trustWatchlist={trust_watchlist}
      attentionItems={attention_queue}
      autonomousDecisions={recent_decisions}
      renderSkillLink={(skillName) => (
        <Link
          to={`/skills/${encodeURIComponent(skillName)}`}
          className="text-sm font-medium hover:underline"
        >
          {skillName}
        </Link>
      )}
      onboarding={{
        skillCount: skills.length,
      }}
      heroActions={
        <div className="flex items-center gap-3">
          {autonomy_status.attention_required > 0 ? (
            <Button size="sm" nativeButton={false} render={<a href="#supervision-feed" />}>
              Review Attention Queue
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">No action needed</span>
          )}
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="?action=evolve" />}
          >
            Run Evolution
          </Button>
        </div>
      }
      trustRailFooter={
        <Link to="/skills" className="text-xs font-medium text-primary hover:underline">
          View All Skills
        </Link>
      }
      comparison={{
        rows: comparisonRows,
        libraryAction: (
          <Link to="/skills" className="text-xs font-medium text-primary hover:underline">
            View library
          </Link>
        ),
        watchlist: {
          initialSkills: data.watched_skills,
        },
      }}
      sectionsBeforeFeed={<CreatorLoopPanel data={creator_testing} />}
      runSummary={{
        lastRun: latestRun?.timestamp ?? null,
        deployed: totalDeployed,
        evolved: totalEvolved,
        watched: totalWatched,
        runCount: orchRuns.length,
        historyAction: (
          <Link to="/analytics" className="text-primary hover:underline">
            View full history
          </Link>
        ),
      }}
    />
  );
}
