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
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  EyeIcon,
  RefreshCwIcon,
  SearchIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
  ArrowRightIcon,
  GitBranchIcon,
  FlaskConicalIcon,
  BarChart3Icon,
  RocketIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  SkillReportDataQualityTabContent,
  SkillReportEvidenceTabContent,
  SkillReportInvocationsSection,
  SkillReportMissedQueriesSection,
  SkillReportScaffold,
  SkillReportTabs,
  SkillReportTrustBadge,
} from "@selftune/dashboard-core/screens/skill-report";
import { Skeleton } from "@/components/ui/skeleton";
import { useSkillReport } from "@/hooks/useSkillReport";
import type {
  CreatorLoopNextStep,
  EvolutionEntry,
  SkillTestingReadiness,
  TrustState,
} from "@/types";

type SkillReportTab = "evidence" | "missed" | "invocations" | "data-quality";

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

function deriveTestingAction(readiness: SkillTestingReadiness): {
  icon: React.ReactNode;
  text: string;
  actionLabel: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  switch (readiness.next_step) {
    case "generate_evals":
      return {
        icon: <FlaskConicalIcon className="size-5 text-primary" />,
        text: readiness.summary,
        actionLabel: "Generate evals",
        variant: "default",
      };
    case "run_unit_tests":
      return {
        icon: <CheckCircleIcon className="size-5 text-primary" />,
        text: readiness.summary,
        actionLabel: "Generate unit tests",
        variant: "default",
      };
    case "run_replay_dry_run":
      return {
        icon: <RefreshCwIcon className="size-5 text-primary" />,
        text: readiness.summary,
        actionLabel: "Run replay dry-run",
        variant: "secondary",
      };
    case "measure_baseline":
      return {
        icon: <BarChart3Icon className="size-5 text-primary" />,
        text: readiness.summary,
        actionLabel: "Measure baseline",
        variant: "secondary",
      };
    case "deploy_candidate":
      return {
        icon: <RocketIcon className="size-5 text-primary" />,
        text: readiness.summary,
        actionLabel: "Deploy candidate",
        variant: "outline",
      };
    case "watch_deployment":
      return {
        icon: <EyeIcon className="size-5 text-primary" />,
        text: readiness.summary,
        actionLabel: "Watch deployment",
        variant: "outline",
      };
  }
}

function deriveProposalAction(
  evolution: EvolutionEntry[],
  proposalId: string,
): {
  icon: React.ReactNode;
  text: string;
  actionLabel: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  const proposalEntries = evolution
    .filter((entry) => entry.proposal_id === proposalId)
    .sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
  const latest = proposalEntries.at(-1);

  switch (latest?.action) {
    case "validated":
      return {
        icon: <ArrowRightIcon className="size-5 text-primary" />,
        text: "This proposal validated successfully. Review the evidence and deploy if it still looks right.",
        actionLabel: "Deploy candidate",
        variant: "default",
      };
    case "created":
      return {
        icon: <GitBranchIcon className="size-5 text-primary" />,
        text: "This proposal has been generated and is ready for review. Inspect the evidence before deploying anything.",
        actionLabel: "Review proposal",
        variant: "default",
      };
    case "deployed":
      return {
        icon: <EyeIcon className="size-5 text-primary" />,
        text: "This proposal has already been deployed. Review the evidence trail and keep watching live behavior.",
        actionLabel: "Watch deployment",
        variant: "outline",
      };
    case "rolled_back":
      return {
        icon: <AlertTriangleIcon className="size-5 text-destructive" />,
        text: "This proposal was rolled back. Review the evidence trail before trying another change.",
        actionLabel: "Inspect rollback",
        variant: "destructive",
      };
    case "rejected":
      return {
        icon: <AlertTriangleIcon className="size-5 text-destructive" />,
        text: "This proposal was rejected by validation. Review the failure evidence before retrying.",
        actionLabel: "Review rejection",
        variant: "destructive",
      };
    default:
      return {
        icon: <GitBranchIcon className="size-5 text-primary" />,
        text: "Review the selected proposal and its evidence trail.",
        actionLabel: "Review proposal",
        variant: "default",
      };
  }
}

function CreatorLoopSection({
  readiness,
}: {
  readiness: SkillTestingReadiness | null | undefined;
}) {
  if (!readiness) return null;

  return (
    <Card className="rounded-2xl border-border/15">
      <CardHeader className="gap-2">
        <CardTitle className="text-base">Creator test loop</CardTitle>
        <CardDescription>
          Use this loop before trusting an evolution: generate evals, add unit tests, replay a
          dry-run, measure baseline, then deploy and watch.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{formatLoopStep(readiness.next_step)}</Badge>
          <span className="text-sm text-muted-foreground">{readiness.summary}</span>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-xl border border-border/10 bg-muted/20 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Eval readiness
            </div>
            <div className="mt-2 text-sm font-medium">
              {readiness.eval_readiness === "log_ready"
                ? "Log-ready"
                : readiness.eval_readiness === "cold_start_ready"
                  ? "Cold-start ready"
                  : "Telemetry only"}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {readiness.eval_set_entries > 0
                ? `${readiness.eval_set_entries} canonical eval entries`
                : `${readiness.trusted_session_count} trusted sessions`}
            </div>
          </div>
          <div className="rounded-xl border border-border/10 bg-muted/20 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Unit tests
            </div>
            <div className="mt-2 text-sm font-medium">
              {readiness.unit_test_cases > 0
                ? `${readiness.unit_test_cases} cases`
                : "Not generated"}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {readiness.unit_test_pass_rate != null
                ? `Last run ${Math.round(readiness.unit_test_pass_rate * 100)}%`
                : "No stored test run"}
            </div>
          </div>
          <div className="rounded-xl border border-border/10 bg-muted/20 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Replay validation
            </div>
            <div className="mt-2 text-sm font-medium">
              {readiness.replay_check_count > 0
                ? `${readiness.replay_check_count} checks`
                : "Not recorded"}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {readiness.latest_validation_mode
                ? `Latest mode: ${readiness.latest_validation_mode}`
                : "Use --validation-mode replay"}
            </div>
          </div>
          <div className="rounded-xl border border-border/10 bg-muted/20 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Baseline
            </div>
            <div className="mt-2 text-sm font-medium">
              {readiness.baseline_sample_size > 0
                ? `${readiness.baseline_sample_size} samples`
                : "Not stored"}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {readiness.baseline_pass_rate != null
                ? `Pass rate ${Math.round(readiness.baseline_pass_rate * 100)}%`
                : "Run grade baseline"}
            </div>
          </div>
          <div className="rounded-xl border border-border/10 bg-muted/20 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Deployment
            </div>
            <div className="mt-2 text-sm font-medium">
              {readiness.deployment_readiness === "ready_to_deploy"
                ? "Ready to deploy"
                : readiness.deployment_readiness === "watching"
                  ? "Watching live"
                  : readiness.deployment_readiness === "rolled_back"
                    ? "Rolled back"
                    : "Blocked"}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{readiness.deployment_summary}</div>
          </div>
        </div>

        <div className="rounded-xl border border-dashed border-border/30 bg-background px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Recommended command
          </div>
          <code className="mt-2 block overflow-x-auto text-[11px] text-foreground">
            {readiness.recommended_command}
          </code>
        </div>

        {readiness.deployment_command ? (
          <div className="rounded-xl border border-dashed border-border/30 bg-background px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Deploy / watch command
            </div>
            <code className="mt-2 block overflow-x-auto text-[11px] text-foreground">
              {readiness.deployment_command}
            </code>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ─── Next best action logic ──────────────────────────── */

function deriveNextAction(
  trustState: TrustState,
  missRate: number | null | undefined,
  systemLikeRate: number | null | undefined,
  hasPendingProposals: boolean,
  _hasEvolution: boolean,
): {
  icon: React.ReactNode;
  text: string;
  actionLabel: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  if (trustState === "low_sample") {
    return {
      icon: <EyeIcon className="size-5" />,
      text: "Keep observing. This skill needs more sessions before trust can be assessed.",
      actionLabel: "Keep observing",
      variant: "secondary",
    };
  }
  if (trustState === "rolled_back") {
    return {
      icon: <AlertTriangleIcon className="size-5 text-destructive" />,
      text: "Inspect rollback evidence before re-deploying.",
      actionLabel: "Inspect rollback",
      variant: "destructive",
    };
  }
  if (trustState === "watch" && (systemLikeRate ?? 0) > 0.05) {
    return {
      icon: <AlertTriangleIcon className="size-5 text-amber-500" />,
      text: "Clean source-truth data or routing data before trusting this report.",
      actionLabel: "Clean data",
      variant: "secondary",
    };
  }
  if (trustState === "watch" && (missRate ?? 0) > 0) {
    return {
      icon: <SearchIcon className="size-5 text-amber-500" />,
      text: "Generate evals to investigate missed triggers.",
      actionLabel: "Generate evals",
      variant: "secondary",
    };
  }
  if (trustState === "watch") {
    return {
      icon: <EyeIcon className="size-5 text-amber-500" />,
      text: "This skill is under active observation. Review recent invocations to verify routing accuracy.",
      actionLabel: "Review invocations",
      variant: "secondary",
    };
  }
  if (hasPendingProposals) {
    return {
      icon: <GitBranchIcon className="size-5 text-primary" />,
      text: "Review pending proposal.",
      actionLabel: "Review proposal",
      variant: "default",
    };
  }
  if (trustState === "validated") {
    return {
      icon: <ArrowRightIcon className="size-5 text-primary" />,
      text: "Deploy the validated candidate.",
      actionLabel: "Deploy candidate",
      variant: "default",
    };
  }
  if (trustState === "deployed") {
    return {
      icon: <CheckCircleIcon className="size-5 text-green-500" />,
      text: "No action needed. Skill is healthy and being monitored.",
      actionLabel: "Healthy",
      variant: "outline",
    };
  }
  if (trustState === "observed") {
    return {
      icon: <EyeIcon className="size-5 text-muted-foreground" />,
      text: "No action needed. Selftune is still observing this skill and building confidence from real usage.",
      actionLabel: "Observed",
      variant: "outline",
    };
  }
  return {
    icon: <EyeIcon className="size-5" />,
    text: "Continue monitoring this skill.",
    actionLabel: "Monitor",
    variant: "outline",
  };
}

/* ═══════════════════════════════════════════════════════════
   SkillReport — trust-first skill report page
   ═══════════════════════════════════════════════════════════ */

export function SkillReport() {
  const { name } = useParams<{ name: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, isPending, isError, error, refetch } = useSkillReport(name);
  const [activeTab, setActiveTab] = useState<SkillReportTab>("invocations");

  // Derive proposal state from data (safe to compute even when data is null)
  const evolution = data?.evolution ?? [];
  const proposalIds = new Set(evolution.map((entry) => entry.proposal_id));
  const requestedProposal = searchParams.get("proposal");
  const activeProposal =
    requestedProposal && proposalIds.has(requestedProposal)
      ? requestedProposal
      : evolution.length > 0
        ? evolution[0].proposal_id
        : null;
  const proposalFocus = Boolean(requestedProposal && activeProposal);

  // All hooks must be called unconditionally -- before any early returns
  useEffect(() => {
    if (!data) return;

    const current = searchParams.get("proposal");
    if (activeProposal && current !== activeProposal) {
      const next = new URLSearchParams(searchParams);
      next.set("proposal", activeProposal);
      setSearchParams(next, { replace: true });
      return;
    }
    if (!activeProposal && current) {
      const next = new URLSearchParams(searchParams);
      next.delete("proposal");
      setSearchParams(next, { replace: true });
    }
  }, [data, activeProposal, searchParams, setSearchParams]);

  const handleSelectProposal = (proposalId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("proposal", proposalId);
    setSearchParams(next, { replace: true });
  };

  // Trust fields from extended SkillReportResponse
  const trust = data?.trust;
  const coverage = data?.coverage;
  const evidenceQuality = data?.evidence_quality;
  const routingQuality = data?.routing_quality;
  const evolutionState = data?.evolution_state;
  const dataHygiene = data?.data_hygiene;
  const examples = data?.examples;
  const rawChecks = dataHygiene?.raw_checks ?? coverage?.checks ?? data?.usage.total_checks ?? 0;
  const operationalChecks =
    dataHygiene?.operational_checks ?? coverage?.checks ?? data?.usage.total_checks ?? 0;
  const excludedChecks = Math.max(rawChecks - operationalChecks, 0);
  const hasEvolutionData = (evolutionState?.evolution_rows ?? evolution.length) > 0;
  const testingReadiness = data?.testing_readiness ?? null;
  const defaultTab: SkillReportTab = hasEvolutionData ? "evidence" : "invocations";

  useEffect(() => {
    setActiveTab(defaultTab);
  }, [defaultTab]);

  // Filtered invocations for the invocations tab
  const mergedInvocations = useMemo(() => {
    const invs = (data?.canonical_invocations ?? []).map((ci) => ({
      timestamp: ci.timestamp || ci.occurred_at || null,
      session_id: ci.session_id,
      triggered: ci.triggered,
      query: ci.query ?? "",
      source: ci.source ?? "",
      invocation_mode: ci.invocation_mode ?? null,
      confidence: ci.confidence ?? null,
      tool_name: ci.tool_name ?? null,
      agent_type: ci.agent_type ?? null,
      observation_kind: ci.observation_kind ?? "canonical",
      historical_context: ci.historical_context ?? null,
    }));
    invs.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
    return invs;
  }, [data?.canonical_invocations]);

  /* ─── Early returns ─────────────────────────────────── */

  if (!name) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <p className="text-sm text-destructive">No skill name provided</p>
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="@container/main flex flex-1 flex-col gap-6 p-4 lg:p-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-20 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
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
      <div className="flex flex-1 items-center justify-center py-16">
        <p className="text-sm text-muted-foreground">No data yet</p>
      </div>
    );
  }

  const isNotFound =
    (coverage?.checks ?? data.usage.total_checks) === 0 &&
    data.evidence.length === 0 &&
    data.evolution.length === 0 &&
    (data.canonical_invocations?.length ?? 0) === 0;

  if (isNotFound) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
        <p className="text-sm text-muted-foreground">No data found for skill "{name}".</p>
        <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/" />}>
          <ArrowLeftIcon className="mr-2 size-3.5" />
          Back to Overview
        </Button>
      </div>
    );
  }

  const trustState = trust?.state ?? "low_sample";

  const trustDrivenAction = deriveNextAction(
    trustState,
    routingQuality?.miss_rate,
    evidenceQuality?.system_like_rate,
    evolutionState?.has_pending_proposals ?? data.pending_proposals.length > 0,
    hasEvolutionData,
  );
  const proposalDrivenAction =
    proposalFocus && activeProposal ? deriveProposalAction(evolution, activeProposal) : null;
  const nextAction =
    proposalDrivenAction ??
    (proposalFocus ||
    trustState === "rolled_back" ||
    !testingReadiness ||
    testingReadiness.next_step === "watch_deployment"
      ? trustDrivenAction
      : deriveTestingAction(testingReadiness));

  return (
    <SkillReportScaffold
      backLink={
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link to="/" />}
          className="shrink-0"
        >
          <ArrowLeftIcon className="size-3.5" />
        </Button>
      }
      title={data.skill_name}
      statusBadge={<SkillReportTrustBadge state={trustState} />}
      toolbarMeta={
        <>
          <div className="hidden @xl/main:flex items-center gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">
              <strong className="text-foreground">
                {coverage?.checks ?? data.usage.total_checks}
              </strong>{" "}
              checks
            </span>
            <span className="text-border">|</span>
            <span className="tabular-nums">
              <strong className="text-foreground">
                {coverage?.sessions ?? data.sessions_with_skill}
              </strong>{" "}
              sessions
            </span>
            <span className="text-border">|</span>
            <span className="tabular-nums">
              <strong className="text-foreground">{coverage?.workspaces ?? "No data"}</strong>{" "}
              workspaces
            </span>
          </div>
          {coverage?.first_seen || coverage?.last_seen ? (
            <div className="hidden @3xl/main:flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
              {coverage?.first_seen ? (
                <span title="First seen">{timeAgo(coverage.first_seen)}</span>
              ) : null}
              {coverage?.first_seen && coverage?.last_seen ? <span>-</span> : null}
              {coverage?.last_seen ? (
                <span title="Last seen">{timeAgo(coverage.last_seen)}</span>
              ) : null}
            </div>
          ) : null}
        </>
      }
      summary={
        trust?.summary ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span>{trust.summary}</span>
              {evolutionState?.latest_action && evolutionState?.latest_timestamp ? (
                <span className="font-mono text-[11px] text-muted-foreground/70">
                  Latest: {evolutionState.latest_action} ({timeAgo(evolutionState.latest_timestamp)}
                  )
                </span>
              ) : null}
            </div>
            {excludedChecks > 0 ? (
              <div className="text-[12px] text-muted-foreground/80">
                Based on <span className="font-medium text-foreground">{operationalChecks}</span>{" "}
                real checks. <span className="font-medium text-foreground">{excludedChecks}</span>{" "}
                internal or legacy rows are excluded from trust scoring.
              </div>
            ) : null}
          </>
        ) : undefined
      }
      showOnboardingBanner={!proposalFocus}
      guideButtonLabel="How this works"
      prioritizeChildren={proposalFocus}
      nextAction={nextAction}
      trustState={trustState}
      coverage={coverage}
      evidenceQuality={evidenceQuality}
      routingQuality={routingQuality}
      evolutionState={evolutionState}
      dataHygiene={dataHygiene}
      fallbackChecks={data.usage.total_checks}
      fallbackSessions={data.sessions_with_skill}
      fallbackEvidenceRows={data.evidence.length}
      fallbackEvolutionRows={evolution.length}
      fallbackLatestAction={evolution[0]?.action}
      nextActionText={nextAction.text}
    >
      {!proposalFocus ? <CreatorLoopSection readiness={testingReadiness} /> : null}

      <SkillReportTabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as SkillReportTab)}
        tabs={[
          {
            value: "evidence",
            label: "Evidence",
            tooltip: "Change history and validation results",
            hidden: !hasEvolutionData,
            contentClassName: "space-y-6",
            content: (
              <>
                <SkillReportEvidenceTabContent
                  examples={examples}
                  evolution={evolution}
                  activeProposal={activeProposal}
                  onSelect={handleSelectProposal}
                  evidence={data.evidence}
                  viewerProposalId={activeProposal ?? ""}
                  showViewer={Boolean(activeProposal)}
                  emptyState={
                    <Card className="rounded-2xl">
                      <CardContent className="py-12">
                        <div className="flex flex-col items-center justify-center gap-3 text-center">
                          <EyeIcon className="size-8 text-muted-foreground/40" />
                          <p className="text-sm text-muted-foreground">
                            This skill is being observed but has no reviewable evolution evidence
                            yet.
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  }
                />
              </>
            ),
          },
          {
            value: "invocations",
            label: "Invocations",
            tooltip:
              "Real usage and repaired misses only. Internal selftune traffic and legacy residue are excluded from this working set.",
            badge: (
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {mergedInvocations.length}
              </Badge>
            ),
            content: (
              <SkillReportInvocationsSection
                invocations={mergedInvocations}
                sessionMetadata={data?.session_metadata ?? []}
                callout={
                  excludedChecks > 0 ? (
                    <div className="rounded-xl border border-border/10 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                      Showing{" "}
                      <span className="font-medium text-foreground">
                        {mergedInvocations.length}
                      </span>{" "}
                      operational invocations.{" "}
                      <span className="font-medium text-foreground">{excludedChecks}</span> internal
                      or legacy rows are tracked in Data Quality instead of being mixed into this
                      working set.
                    </div>
                  ) : undefined
                }
              />
            ),
          },
          {
            value: "missed",
            label: "Missed Queries",
            hidden: (examples?.missed.length ?? 0) === 0,
            tooltip: "Queries that look like missed triggers from real usage.",
            badge:
              (examples?.missed.length ?? 0) > 0 ? (
                <Badge variant="secondary" className="ml-1.5 text-[10px]">
                  {examples?.missed.length ?? 0}
                </Badge>
              ) : undefined,
            contentClassName: "pt-2",
            content: (
              <SkillReportMissedQueriesSection
                rows={(examples?.missed ?? []).map((example, index) => ({
                  id: `${example.session_id}:${example.timestamp ?? index}`,
                  query: example.query_text,
                  confidence: example.confidence,
                  source: example.source ?? example.platform ?? null,
                  createdAt: example.timestamp ?? "",
                }))}
              />
            ),
          },
          {
            value: "data-quality",
            label: "Data Quality",
            tooltip: "Evidence quality metrics and data hygiene",
            content: (
              <SkillReportDataQualityTabContent
                evidenceQuality={evidenceQuality}
                dataHygiene={dataHygiene}
              />
            ),
          },
        ]}
      />
    </SkillReportScaffold>
  );
}
