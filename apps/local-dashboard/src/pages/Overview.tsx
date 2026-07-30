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
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  OverviewCompositionSurface,
  type OverviewComparisonRow,
} from "@selftune/dashboard-core/screens/overview";
import { toast } from "sonner";
import { recommendLibraryConsolidation } from "@selftune/control-plane/library-consolidation";

import { runDashboardAction } from "@/api";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrchestrateRuns } from "@/hooks/useOrchestrateRuns";
import { useLibrary } from "@/hooks/useLibrary";
import { usePortfolio } from "@/hooks/usePortfolio";
import { normalizeLifecycleCommand, normalizeLifecycleText } from "@/lib/lifecycle-surface";
import type {
  CreateCheckState,
  DashboardActionName,
  CreatorOverviewStep,
  CreatorLoopNextStep,
  OverviewResponse,
  SkillHealthStatus,
} from "@/types";

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
      return "Ship candidate";
    case "watch_deployment":
      return "Monitor live";
  }
}

function formatCreatorOverviewStep(step: CreatorOverviewStep): string {
  switch (step) {
    case "run_create_check":
      return "Verify draft";
    case "finish_package":
      return "Finish package";
    case "generate_evals":
      return "Generate evals";
    case "run_unit_tests":
      return "Run unit tests";
    case "run_replay_dry_run":
      return "Replay dry-run";
    case "measure_baseline":
      return "Measure baseline";
    case "deploy_candidate":
      return "Ship candidate";
    case "watch_deployment":
      return "Monitor live";
  }
}

function actionForCreatorOverviewStep(step: CreatorOverviewStep): DashboardActionName | null {
  switch (step) {
    case "run_create_check":
      return "create-check";
    case "generate_evals":
      return "generate-evals";
    case "run_unit_tests":
      return "generate-unit-tests";
    case "run_replay_dry_run":
      return "replay-dry-run";
    case "measure_baseline":
      return "measure-baseline";
    case "deploy_candidate":
      return "deploy-candidate";
    case "watch_deployment":
      return "watch";
    case "finish_package":
      return null;
  }
}

function formatCreateState(state: CreateCheckState): string {
  switch (state) {
    case "blocked_spec_validation":
      return "Verification blocked";
    case "needs_spec_validation":
      return "Verify draft";
    case "needs_package_resources":
      return "Finish package";
    case "needs_evals":
      return "Generate evals";
    case "needs_unit_tests":
      return "Generate unit tests";
    case "needs_routing_replay":
      return "Replay package";
    case "needs_baseline":
      return "Measure baseline";
    case "ready_to_publish":
      return "Publish draft";
  }
}

function CreatorLoopPanel({
  data,
  skills,
}: {
  data: OverviewResponse["creator_testing"];
  skills: OverviewResponse["skills"];
}) {
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const navigate = useNavigate();

  if (!data) return null;

  function handleRunPriority(
    priority: NonNullable<OverviewResponse["creator_testing"]>["priorities"][number],
  ) {
    const action = actionForCreatorOverviewStep(priority.step);
    const skill = skills.find((entry) => entry.skill_name === priority.skill_name);
    const skillPath =
      skill?.create_readiness?.skill_path ?? skill?.testing_readiness?.skill_path ?? null;

    if (!action || !skillPath) {
      toast.error("Action unavailable", {
        description:
          priority.step === "finish_package"
            ? "Finish package is still a manual step. Use the recommended command and file checklist from the skill report."
            : "This priority needs a resolved SKILL.md path before the dashboard can run it.",
      });
      return;
    }

    const actionKey = `${priority.skill_name}:${action}`;
    setRunningAction(actionKey);
    navigate(`/live-run?${new URLSearchParams({ skill: priority.skill_name, action }).toString()}`);
    void runDashboardAction(action, {
      skill: priority.skill_name,
      skillPath,
      autoSynthetic:
        action === "generate-evals" &&
        skill?.testing_readiness?.eval_readiness === "cold_start_ready",
    })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        toast.error("Action failed to start", { description: message });
      })
      .finally(() => {
        setRunningAction(null);
      });
  }

  return (
    <Card className="rounded-2xl border-border/15">
      <CardHeader className="gap-2">
        <CardTitle className="text-base">Draft skill lifecycle</CardTitle>
        <CardDescription>
          Verify the draft, fill any missing evidence, publish safely, then monitor live behavior.
          This surface tracks whether each skill is still blocked on verification, ready to ship, or
          already under watch.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">{normalizeLifecycleText(data.summary)}</p>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-8">
          {[
            ["Verify draft", data.counts.run_create_check],
            ["Finish package", data.counts.finish_package],
            ["Generate evals", data.counts.generate_evals],
            ["Run unit tests", data.counts.run_unit_tests],
            ["Replay dry-run", data.counts.run_replay_dry_run],
            ["Measure baseline", data.counts.measure_baseline],
            ["Ship candidate", data.counts.deploy_candidate],
            ["Monitor live", data.counts.watch_deployment],
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
              {data.priorities.map((priority) => {
                const action = actionForCreatorOverviewStep(priority.step);
                const actionKey = action ? `${priority.skill_name}:${action}` : null;
                return (
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
                        {formatCreatorOverviewStep(priority.step)}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {normalizeLifecycleText(priority.summary)}
                    </p>
                    <code className="mt-2 block overflow-x-auto rounded-md bg-muted/60 px-3 py-2 text-[11px] text-foreground">
                      {normalizeLifecycleCommand(priority.recommended_command)}
                    </code>
                    {action ? (
                      <div className="mt-3 flex justify-end">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={runningAction !== null && runningAction !== actionKey}
                          onClick={() => handleRunPriority(priority)}
                        >
                          {runningAction === actionKey ? (
                            <RefreshCwIcon className="mr-2 size-3.5 animate-spin" />
                          ) : null}
                          Run now
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
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
  const libraryQuery = useLibrary();
  const portfolioQuery = usePortfolio();

  if (isPending) {
    return (
      <div className="@container/main flex flex-1 flex-col gap-6 py-6 px-4 lg:px-6">
        <Skeleton className="h-[340px]" />
        <div className="grid grid-cols-12 gap-6">
          <Skeleton className="col-span-12 h-64 @4xl/main:col-span-8" />
          <Skeleton className="col-span-12 h-64 @4xl/main:col-span-4" />
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
    const createReadiness = skill.create_readiness;
    const lifecycleText =
      createReadiness && skill.total_checks === 0
        ? `Draft package · ${formatCreateState(createReadiness.state)}`
        : `${skill.skill_scope ?? "Unscoped"} · ${skill.total_checks} checks${loopStep && loopStep !== "watch_deployment" ? ` · ${formatLoopStep(loopStep)}` : ""}`;
    return {
      skillName: skill.skill_name,
      subtext: lifecycleText,
      triggerRate: trust?.pass_rate ?? skill.pass_rate,
      routingConfidence: skill.routing_confidence,
      confidenceCoverage: skill.confidence_coverage,
      sessions: skill.unique_sessions,
      lastEvolution: latestEvolutionBySkill.get(skill.skill_name) ?? null,
      bucket: trust?.bucket ?? "uncertain",
      sortTimestamp: skill.last_seen ?? null,
    };
  });
  const cleanupCandidates = (portfolioQuery.data?.audit.skills ?? [])
    .filter(
      (skill) =>
        skill.classification === "inactive_candidate" &&
        skill.recommendation === "review_quarantine",
    )
    .map((skill) => ({
      skillName: skill.skill_name,
      reason: skill.reason,
      lastInvokedAt: skill.evidence.last_invoked_at,
      inactiveDays: skill.evidence.inactive_days,
      sessionsSinceInvocation: skill.evidence.sessions_since_invocation,
    }));
  const consolidationCandidates = (libraryQuery.data?.skills ?? []).flatMap((skill) => {
    const recommendation = recommendLibraryConsolidation(skill);
    return recommendation
      ? [
          {
            skillName: recommendation.skillName,
            installedCount: recommendation.installedCount,
            projectCount: recommendation.projectCount,
            confidence: recommendation.canonical.confidence,
          },
        ]
      : [];
  });
  const cleanup =
    cleanupCandidates.length > 0 || consolidationCandidates.length > 0
      ? {
          activeSkillCount:
            portfolioQuery.data?.audit.installed_count ?? libraryQuery.data?.skills.length ?? 0,
          candidates: cleanupCandidates,
          evidencePendingCount:
            (portfolioQuery.data?.audit.counts.unobserved ?? 0) +
            (portfolioQuery.data?.audit.counts.under_observed ?? 0),
          archivedCount: portfolioQuery.data?.quarantined.length ?? 0,
          consolidationCandidates,
          reviewAction: (
            <Button size="sm" nativeButton={false} render={<Link to="/skills?review=archive" />}>
              Review cleanup
            </Button>
          ),
          consolidationAction: (
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link to="/skills?review=consolidate&bulk=1" />}
            >
              Review duplicate installations
            </Button>
          ),
          restoreAction: (
            <Link to="/skills?state=archived" className="font-medium text-primary hover:underline">
              Restore archived skills
            </Link>
          ),
        }
      : null;

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
      cleanup={cleanup}
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
      sectionsBeforeFeed={<CreatorLoopPanel data={creator_testing} skills={skills} />}
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
