import { EvolutionTimeline } from "@selftune/ui/components";
import { EvidenceViewer } from "@selftune/ui/components";
import { InfoTip } from "@selftune/ui/components";
import { STATUS_CONFIG } from "@selftune/ui/lib";
import { deriveStatus, formatRate, timeAgo } from "@selftune/ui/lib";
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@selftune/ui/primitives";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  FlaskConicalIcon,
  ActivityIcon,
  EyeIcon,
  RefreshCwIcon,
  LayersIcon,
  TrendingUpIcon,
  TrendingDownIcon,
  CoinsIcon,
  ChevronRightIcon,
  ClockIcon,
  AlertOctagonIcon,
  TargetIcon,
  GaugeIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { Skeleton } from "@/components/ui/skeleton";
import { useSkillReport } from "@/hooks/useSkillReport";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = secs / 60;
  if (mins < 60) return `${mins.toFixed(1)}m`;
  return `${(mins / 60).toFixed(1)}h`;
}

const ACTION_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  created: "outline",
  validated: "secondary",
  deployed: "default",
  rejected: "destructive",
  rolled_back: "destructive",
};

/** Feed-style session group with progressive disclosure */
function SessionGroup({
  sessionId,
  meta,
  invocations,
  defaultExpanded,
}: {
  sessionId: string;
  meta?:
    | { started_at?: string | null; model?: string | null; workspace_path?: string | null }
    | undefined;
  invocations: Array<{
    timestamp: string | null;
    session_id: string | null;
    triggered: boolean;
    query: string;
    invocation_mode: string | null;
    confidence: number | null;
    tool_name: string | null;
    agent_type: string | null;
  }>;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const ts = meta?.started_at ?? invocations[0]?.timestamp;
  const modeBreakdown = invocations.reduce(
    (acc, inv) => {
      const mode = inv.invocation_mode ?? "unknown";
      acc[mode] = (acc[mode] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="rounded-lg bg-secondary ghost-border overflow-hidden transition-colors">
      {/* Session header — always visible */}
      <button
        type="button"
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-input active:bg-input/80 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRightIcon
          className={`size-3.5 text-muted-foreground shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium font-headline">
              {invocations.length} invocation{invocations.length !== 1 ? "s" : ""}
            </span>
            <span className="text-xs text-muted-foreground">{ts ? timeAgo(ts) : ""}</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {meta?.model && (
              <Badge variant="secondary" className="text-[10px] font-normal">
                {meta.model}
              </Badge>
            )}
            {meta?.workspace_path && (
              <span
                className="text-[11px] text-muted-foreground font-mono"
                title={meta.workspace_path}
              >
                {meta.workspace_path.split("/").slice(-2).join("/")}
              </span>
            )}
          </div>
        </div>
        {/* Compact mode summary when collapsed */}
        {!expanded && (
          <div className="flex items-center gap-1 shrink-0">
            {Object.entries(modeBreakdown).map(([mode, count]) => (
              <Badge key={mode} variant="outline" className="text-[10px] font-normal gap-1">
                {mode} <span className="text-muted-foreground">{count}</span>
              </Badge>
            ))}
          </div>
        )}
        <span className="text-[10px] text-muted-foreground/40 font-mono shrink-0">
          {sessionId.substring(0, 8)}
        </span>
      </button>

      {/* Invocation table — expanded */}
      {expanded && (
        <div className="border-t border-border/15 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent bg-transparent border-b border-border/15">
                <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground font-headline h-8">
                  Prompt <InfoTip text="The user prompt that led to this skill being invoked" />
                </TableHead>
                <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground font-headline h-8 w-[90px]">
                  Mode{" "}
                  <InfoTip text="explicit = user typed /skillname · implicit = user mentioned skill by name · inferred = agent chose skill autonomously" />
                </TableHead>
                <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground font-headline h-8 w-[70px]">
                  Confidence{" "}
                  <InfoTip text="Model's confidence score (0–100%) when routing this prompt to the skill" />
                </TableHead>
                <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground font-headline h-8 w-[90px]">
                  Agent{" "}
                  <InfoTip text="Which agent invoked the skill — main agent or a subagent type (e.g. Explore, Engineer)" />
                </TableHead>
                <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground font-headline h-8 w-[70px] text-right">
                  Time
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invocations.map((inv, i) => (
                <TableRow key={i} className={!inv.triggered ? "bg-destructive/5" : ""}>
                  <TableCell
                    className="max-w-[500px] truncate text-sm py-2"
                    title={inv.query || undefined}
                  >
                    {inv.query || (
                      <span className="text-muted-foreground/40 italic">No prompt recorded</span>
                    )}
                    {!inv.triggered && (
                      <Badge variant="destructive" className="text-[10px] font-normal ml-2">
                        missed
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="py-2">
                    {inv.invocation_mode ? (
                      <Badge variant="secondary" className="text-[10px] font-normal">
                        {inv.invocation_mode}
                      </Badge>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="py-2 font-mono text-xs text-muted-foreground tabular-nums">
                    {inv.confidence !== null ? `${Math.round(inv.confidence * 100)}%` : "—"}
                  </TableCell>
                  <TableCell className="py-2">
                    {inv.agent_type ? (
                      <Badge variant="outline" className="text-[10px] font-normal">
                        {inv.agent_type}
                      </Badge>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="py-2 font-mono text-[11px] text-muted-foreground text-right whitespace-nowrap">
                    {inv.timestamp ? timeAgo(inv.timestamp) : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function SkillReport() {
  const { name } = useParams<{ name: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, isPending, isError, error, refetch } = useSkillReport(name);

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

  // All hooks must be called unconditionally — before any early returns
  useEffect(() => {
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
  }, [activeProposal, searchParams, setSearchParams]);

  const handleSelectProposal = (proposalId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("proposal", proposalId);
    setSearchParams(next, { replace: true });
  };

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
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
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
    data.usage.total_checks === 0 &&
    data.usage.triggered_count === 0 &&
    data.evidence.length === 0 &&
    data.evolution.length === 0 &&
    data.pending_proposals.length === 0 &&
    (data.canonical_invocations?.length ?? 0) === 0 &&
    (data.prompt_samples?.length ?? 0) === 0 &&
    (data.session_metadata?.length ?? 0) === 0;

  if (isNotFound) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
        <p className="text-sm text-muted-foreground">No data found for skill "{name}".</p>
        <Button variant="outline" size="sm" render={<Link to="/" />}>
          <ArrowLeftIcon className="mr-2 size-3.5" />
          Back to Overview
        </Button>
      </div>
    );
  }

  const {
    usage,
    evidence,
    pending_proposals,
    canonical_invocations,
    duration_stats,
    selftune_stats,
    prompt_samples: _prompt_samples,
    session_metadata,
  } = data;
  const status = deriveStatus(usage.pass_rate, usage.total_checks);
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.UNKNOWN;
  const passRateGood = status === "HEALTHY";
  const hasEvolution = (selftune_stats?.run_count ?? 0) > 0;
  const missed = duration_stats?.missed_triggers ?? 0;

  // Unique models/platforms from session metadata
  const _uniqueModels = [...new Set((session_metadata ?? []).map((s) => s.model).filter(Boolean))];
  const _uniquePlatforms = [
    ...new Set((session_metadata ?? []).map((s) => s.platform).filter(Boolean)),
  ];
  const _uniqueDirectories = [
    ...new Set((session_metadata ?? []).map((s) => s.workspace_path).filter(Boolean)),
  ];

  // Unified invocations from consolidated skill_invocations table
  const mergedInvocations = (canonical_invocations ?? []).map((ci) => ({
    timestamp: ci.timestamp || ci.occurred_at || null,
    session_id: ci.session_id,
    triggered: ci.triggered,
    query: ci.query ?? "",
    source: ci.source ?? "",
    invocation_mode: ci.invocation_mode ?? null,
    confidence: ci.confidence ?? null,
    tool_name: ci.tool_name ?? null,
    agent_type: ci.agent_type ?? null,
  }));
  mergedInvocations.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));

  // Group invocations by session for the grouped view
  const sessionMap = new Map<string, typeof mergedInvocations>();
  for (const inv of mergedInvocations) {
    const sid = inv.session_id ?? "unknown";
    const arr = sessionMap.get(sid);
    if (arr) arr.push(inv);
    else sessionMap.set(sid, [inv]);
  }
  const sessionMetaMap = new Map((session_metadata ?? []).map((s) => [s.session_id, s]));
  // Sort session groups by most recent invocation
  const groupedSessions = [...sessionMap.entries()].sort(([, a], [, b]) =>
    (b[0]?.timestamp ?? "").localeCompare(a[0]?.timestamp ?? ""),
  );

  return (
    <Tabs defaultValue={evolution.length > 0 ? "evidence" : "invocations"}>
      <div className="@container/main flex flex-1 flex-col gap-4 p-4 lg:px-6 lg:pb-6 lg:pt-0">
        {/* Skill Header + Tab Bar */}
        <div className="sticky top-[73px] z-30 -mx-4 border-b border-border/15 bg-background/80 px-4 py-3 backdrop-blur-xl lg:-mx-6 lg:px-6">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div className="min-w-0">
                <Link
                  to="/"
                  className="inline-flex items-center gap-1.5 font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:text-primary"
                >
                  <ArrowLeftIcon className="size-3.5" />
                  Back to dashboard
                </Link>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <h1 className="font-headline text-xl font-bold tracking-tight lg:text-2xl">
                    {data.skill_name}
                  </h1>
                  <Badge variant={config.variant} className="gap-1 shrink-0 text-[10px]">
                    {config.icon}
                    {config.label}
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">
                    {usage.total_checks} checks
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">
                    {formatRate(usage.pass_rate)} trigger rate
                  </Badge>
                </div>
                <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                  Trace how this skill is performing in the field, what evidence drove recent
                  changes, and whether routing confidence is moving in the right direction.
                </p>
              </div>

              <TabsList
                variant="line"
                className="w-full justify-start overflow-x-auto lg:ml-auto lg:w-auto lg:justify-end font-headline text-sm"
              >
                {evolution.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger render={<TabsTrigger value="evidence" />}>
                      Evidence
                      {activeProposal && (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          #{activeProposal.slice(0, 8)}
                        </span>
                      )}
                    </TooltipTrigger>
                    <TooltipContent>Change history and validation results</TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger render={<TabsTrigger value="invocations" />}>
                    Invocations
                    <Badge variant="secondary" className="text-[10px]">
                      {mergedInvocations.length}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>Recent skill triggers and their outcomes</TooltipContent>
                </Tooltip>
                {pending_proposals.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger render={<TabsTrigger value="pending" />}>
                      Pending
                      <Badge variant="destructive" className="text-[10px]">
                        {pending_proposals.length}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>Proposals not yet deployed</TooltipContent>
                  </Tooltip>
                )}
              </TabsList>
            </div>
          </div>
        </div>

        {/* KPIs — 2 rows of 4 */}
        <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
          {/* Row 1: Core metrics */}
          <Card className="@container/card rounded-xl bg-muted border-none">
            <CardHeader>
              <CardDescription className="flex items-center gap-1.5 font-headline text-[10px] uppercase tracking-widest text-muted-foreground">
                <FlaskConicalIcon className="size-3.5" />
                Trigger Rate
                <InfoTip text="Percentage of skill checks that resulted in this skill being triggered" />
              </CardDescription>
              <CardTitle
                className={`text-2xl font-bold tabular-nums font-headline @[250px]/card:text-3xl ${usage.total_checks > 0 && !passRateGood ? "text-destructive" : "text-primary"}`}
              >
                {usage.total_checks > 0 ? formatRate(usage.pass_rate) : "--"}
              </CardTitle>
              <CardAction>
                {usage.total_checks > 0 ? (
                  <Badge variant={passRateGood ? "outline" : "destructive"}>
                    {passRateGood ? (
                      <TrendingUpIcon className="size-3" />
                    ) : (
                      <TrendingDownIcon className="size-3" />
                    )}
                    {formatRate(usage.pass_rate)}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    no checks yet
                  </Badge>
                )}
              </CardAction>
            </CardHeader>
          </Card>

          <Card className="@container/card rounded-xl bg-muted border-none">
            <CardHeader>
              <CardDescription className="flex items-center gap-1.5 font-headline text-[10px] uppercase tracking-widest text-muted-foreground">
                <LayersIcon className="size-3.5" />
                Total Checks
                <InfoTip text="Total evaluation checks run across all sessions for this skill" />
              </CardDescription>
              <CardTitle className="text-2xl font-bold tabular-nums font-headline text-primary-accent @[250px]/card:text-3xl">
                {usage.total_checks}
              </CardTitle>
            </CardHeader>
          </Card>

          <Card className="@container/card rounded-xl bg-muted border-none">
            <CardHeader>
              <CardDescription className="flex items-center gap-1.5 font-headline text-[10px] uppercase tracking-widest text-muted-foreground">
                <ActivityIcon className="size-3.5" />
                Triggered
                <InfoTip text="Number of times this skill was invoked by the agent during sessions" />
              </CardDescription>
              <CardTitle className="text-2xl font-bold tabular-nums font-headline text-primary-accent @[250px]/card:text-3xl">
                {usage.triggered_count}
              </CardTitle>
            </CardHeader>
          </Card>

          <Card className="@container/card rounded-xl bg-muted border-none">
            <CardHeader>
              <CardDescription className="flex items-center gap-1.5 font-headline text-[10px] uppercase tracking-widest text-muted-foreground">
                <EyeIcon className="size-3.5" />
                Sessions
                <InfoTip text="Number of unique agent sessions where this skill was present" />
              </CardDescription>
              <CardTitle className="text-2xl font-bold tabular-nums font-headline text-primary-accent @[250px]/card:text-3xl">
                {data.sessions_with_skill}
              </CardTitle>
            </CardHeader>
          </Card>

          {/* Row 2: Selftune resource metrics */}
          <Card className="@container/card rounded-xl bg-muted border-none">
            <CardHeader>
              <CardDescription className="flex items-center gap-1.5 font-headline text-[10px] uppercase tracking-widest text-muted-foreground">
                <CoinsIcon className="size-3.5" />
                LLM Calls
                <InfoTip text="Total LLM calls made by selftune when evolving this skill" />
              </CardDescription>
              <CardTitle className="text-2xl font-bold tabular-nums font-headline text-primary-accent @[250px]/card:text-3xl">
                {hasEvolution ? (selftune_stats?.total_llm_calls ?? 0) : "--"}
              </CardTitle>
              <CardAction>
                {hasEvolution ? (
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {selftune_stats?.run_count ?? 0} evolution runs
                  </span>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    no evolution runs yet
                  </Badge>
                )}
              </CardAction>
            </CardHeader>
          </Card>

          <Card className="@container/card rounded-xl bg-muted border-none">
            <CardHeader>
              <CardDescription className="flex items-center gap-1.5 font-headline text-[10px] uppercase tracking-widest text-muted-foreground">
                <ClockIcon className="size-3.5" />
                Avg Duration
                <InfoTip text="Average time selftune spent evolving this skill per run" />
              </CardDescription>
              <CardTitle className="text-2xl font-bold tabular-nums font-headline text-primary-accent @[250px]/card:text-3xl">
                {hasEvolution ? formatDuration(selftune_stats?.avg_elapsed_ms ?? 0) : "--"}
              </CardTitle>
              <CardAction>
                {hasEvolution ? (
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {formatDuration(selftune_stats?.total_elapsed_ms ?? 0)} total
                  </span>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    no evolution runs yet
                  </Badge>
                )}
              </CardAction>
            </CardHeader>
          </Card>

          <Card className="@container/card rounded-xl bg-muted border-none">
            <CardHeader>
              <CardDescription className="flex items-center gap-1.5 font-headline text-[10px] uppercase tracking-widest text-muted-foreground">
                <AlertOctagonIcon className="size-3.5" />
                Missed Triggers
                <InfoTip text="Number of times this skill was evaluated but did not trigger. High counts may indicate the skill description needs evolution." />
              </CardDescription>
              <CardTitle
                className={`text-2xl font-bold tabular-nums font-headline @[250px]/card:text-3xl ${missed > 0 ? "text-destructive" : "text-primary-accent"}`}
              >
                {missed}
              </CardTitle>
            </CardHeader>
          </Card>

          <Card className="@container/card rounded-xl bg-muted border-none">
            <CardHeader>
              <CardDescription className="flex items-center gap-1.5 font-headline text-[10px] uppercase tracking-widest text-muted-foreground">
                <TargetIcon className="size-3.5" />
                Avg Confidence
                <InfoTip text="Average model confidence score when routing user prompts to this skill" />
              </CardDescription>
              <CardTitle className="text-2xl font-bold tabular-nums font-headline text-primary-accent @[250px]/card:text-3xl">
                {(() => {
                  const withConfidence = mergedInvocations.filter((i) => i.confidence !== null);
                  return withConfidence.length > 0
                    ? formatRate(
                        withConfidence.reduce((sum, i) => sum + (i.confidence ?? 0), 0) /
                          withConfidence.length,
                      )
                    : "--";
                })()}
              </CardTitle>
            </CardHeader>
          </Card>

          {data.description_quality && (
            <Card className="@container/card rounded-xl bg-muted border-none">
              <CardHeader>
                <CardDescription className="flex items-center gap-1.5 font-headline text-[10px] uppercase tracking-widest text-muted-foreground">
                  <GaugeIcon className="size-3.5" />
                  Description Quality
                  <InfoTip text="Heuristic score assessing description routing precision: trigger context, specificity, conciseness, and vagueness. Higher = better agent routing." />
                </CardDescription>
                <CardTitle
                  className={`text-2xl font-bold tabular-nums font-headline @[250px]/card:text-3xl ${data.description_quality.composite < 0.5 ? "text-destructive" : "text-primary"}`}
                >
                  {`${Math.round(data.description_quality.composite * 100)}%`}
                </CardTitle>
                <CardAction>
                  <Tooltip>
                    <TooltipTrigger>
                      <Badge
                        variant={
                          data.description_quality.composite >= 0.7 ? "outline" : "secondary"
                        }
                        className="text-[10px] font-normal cursor-help"
                      >
                        {data.description_quality.composite >= 0.7
                          ? "good"
                          : data.description_quality.composite >= 0.5
                            ? "fair"
                            : "needs work"}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="font-mono text-[10px] space-y-0.5">
                      <div>
                        trigger context:{" "}
                        {Math.round(data.description_quality.criteria.trigger_context * 100)}%
                      </div>
                      <div>
                        specificity:{" "}
                        {Math.round(data.description_quality.criteria.specificity * 100)}%
                      </div>
                      <div>
                        vagueness: {Math.round(data.description_quality.criteria.vagueness * 100)}%
                      </div>
                      <div>
                        length: {Math.round(data.description_quality.criteria.length * 100)}%
                      </div>
                      <div>
                        not just name:{" "}
                        {Math.round(data.description_quality.criteria.not_just_name * 100)}%
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </CardAction>
              </CardHeader>
            </Card>
          )}
        </div>

        {/* Main content: timeline rail + detail canvas */}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[280px_minmax(0,1fr)] 2xl:grid-cols-[320px_minmax(0,1fr)]">
          {/* Left rail: Evolution Timeline — widened and carded so the audit trail can be scanned */}
          {evolution.length > 0 && (
            <aside className="rounded-xl bg-secondary p-3 xl:sticky xl:top-24 xl:self-start xl:max-h-[calc(100svh-7rem)] xl:overflow-y-auto">
              <div className="mb-3 border-b border-border/15 pb-3">
                <p className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  Evolution trail
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Review each proposal as a single narrative: creation, validation, deploy, or
                  rollback.
                </p>
              </div>
              <EvolutionTimeline
                entries={evolution}
                selectedProposalId={activeProposal}
                onSelect={handleSelectProposal}
              />
            </aside>
          )}

          {/* Right content area */}
          <div className="min-w-0 space-y-4">
            {/* Evidence tab */}
            {evolution.length > 0 && (
              <TabsContent value="evidence">
                {activeProposal ? (
                  <EvidenceViewer
                    proposalId={activeProposal}
                    evolution={evolution}
                    evidence={evidence}
                  />
                ) : (
                  <div className="flex items-center justify-center rounded-lg bg-secondary ghost-border py-12">
                    <p className="text-sm text-muted-foreground">
                      Select a proposal from the timeline
                    </p>
                  </div>
                )}
              </TabsContent>
            )}

            {/* Invocations tab — unified from skill_invocations table */}
            <TabsContent value="invocations">
              {mergedInvocations.length === 0 ? (
                <Card className="rounded-xl bg-muted border-none">
                  <CardContent className="py-12">
                    <p className="text-sm text-muted-foreground text-center">
                      No invocation records yet.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-3">
                  {/* Legend */}
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {mergedInvocations.length} invocations across {groupedSessions.length}{" "}
                      sessions
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <Badge variant="secondary" className="text-[9px] font-normal">
                          explicit
                        </Badge>{" "}
                        user typed /skill
                      </span>
                      <span className="flex items-center gap-1">
                        <Badge variant="secondary" className="text-[9px] font-normal">
                          implicit
                        </Badge>{" "}
                        mentioned by name
                      </span>
                      <span className="flex items-center gap-1">
                        <Badge variant="secondary" className="text-[9px] font-normal">
                          inferred
                        </Badge>{" "}
                        agent chose autonomously
                      </span>
                    </div>
                  </div>
                  {groupedSessions.map(([sessionId, invocations], idx) => {
                    const meta = sessionMetaMap.get(sessionId);
                    return (
                      <SessionGroup
                        key={sessionId}
                        sessionId={sessionId}
                        meta={meta}
                        invocations={invocations}
                        defaultExpanded={idx < 3}
                      />
                    );
                  })}
                </div>
              )}
            </TabsContent>

            {/* Pending tab */}
            {pending_proposals.length > 0 && (
              <TabsContent value="pending">
                <Card className="rounded-xl bg-muted border-none">
                  <CardHeader>
                    <CardTitle className="text-sm font-headline">Undeployed Proposals</CardTitle>
                    <CardDescription className="text-muted-foreground">
                      {pending_proposals.length} not yet deployed
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {pending_proposals.map((p) => (
                      <button
                        key={p.proposal_id}
                        type="button"
                        onClick={() => handleSelectProposal(p.proposal_id)}
                        className="flex gap-3 rounded-lg bg-secondary ghost-border p-3 w-full text-left hover:bg-input transition-colors"
                      >
                        <div className="mt-0.5 size-2 shrink-0 rounded-full bg-primary" />
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <Badge
                              variant={ACTION_VARIANT[p.action] ?? "secondary"}
                              className="text-[10px]"
                            >
                              {p.action}
                            </Badge>
                            <span className="text-xs text-muted-foreground font-mono">
                              {timeAgo(p.timestamp)}
                            </span>
                            <span className="text-[10px] text-muted-foreground/60 font-mono ml-auto">
                              #{p.proposal_id.slice(0, 8)}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">{p.details}</p>
                        </div>
                      </button>
                    ))}
                  </CardContent>
                </Card>
              </TabsContent>
            )}
          </div>
        </div>
      </div>
    </Tabs>
  );
}
