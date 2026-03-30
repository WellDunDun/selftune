import { STATUS_CONFIG } from "@selftune/ui/lib";
import { deriveStatus, formatRate, timeAgo } from "@selftune/ui/lib";
import {
  Badge,
  Button,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@selftune/ui/primitives";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  GitBranchIcon,
  PlusIcon,
  RefreshCwIcon,
  RocketIcon,
  TrendingUpIcon,
  XCircleIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Link, useParams } from "react-router-dom";

import { Skeleton } from "@/components/ui/skeleton";
import { useSkillReport } from "@/hooks/useSkillReport";

import type { CanonicalInvocation, EvolutionEntry, PendingProposal } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = secs / 60;
  if (mins < 60) return `${mins.toFixed(1)}m`;
  return `${(mins / 60).toFixed(1)}h`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function statusBadgeClasses(status: string): string {
  switch (status) {
    case "HEALTHY":
      return "border-primary/30 bg-primary/5 text-primary";
    case "CRITICAL":
      return "border-destructive/30 bg-destructive/5 text-destructive";
    case "WARNING":
      return "border-amber-500/30 bg-amber-500/5 text-amber-500";
    default:
      return "border-muted-foreground/30 bg-muted-foreground/5 text-muted-foreground";
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function KPICard({
  label,
  value,
  trending,
  tooltip,
}: {
  label: string;
  value: string | number;
  trending?: boolean;
  tooltip?: string;
}) {
  const card = (
    <div className="rounded-xl bg-muted p-6 hover:bg-secondary transition-all">
      <p className="text-[10px] font-headline tracking-[0.2em] text-muted-foreground uppercase mb-2">
        {label}
      </p>
      <div className="flex items-baseline gap-2">
        <span className="text-4xl font-bold font-headline text-primary">{value}</span>
        {trending && <TrendingUpIcon className="size-5 text-primary" />}
      </div>
    </div>
  );

  if (!tooltip) return card;

  return (
    <Tooltip>
      <TooltipTrigger>{card}</TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function InvocationTimelineTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { query: string; outcome: string; confidence: number; session_id: string; timestamp: string } }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg bg-secondary border border-border/20 px-4 py-3 text-xs shadow-lg">
      <p className="text-foreground font-headline font-bold mb-1 max-w-[260px] truncate">
        {d.query || "No query recorded"}
      </p>
      <p className="text-muted-foreground">
        <span className={d.outcome === "pass" ? "text-primary" : "text-destructive"}>
          {d.outcome === "pass" ? "Pass" : "Fail"}
        </span>
        {" — confidence "}
        {Math.round(d.confidence * 100)}%
      </p>
      <p className="text-muted-foreground/60 font-mono mt-1">
        {d.session_id.substring(0, 8)} &middot; {timeAgo(d.timestamp)}
      </p>
    </div>
  );
}

function InvocationTimeline({
  invocations,
}: {
  invocations: CanonicalInvocation[];
}) {
  const recent = invocations.slice(0, 30).toReversed();
  if (recent.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">
        No invocation data yet.
      </p>
    );
  }

  const chartData = recent.map((inv, i) => ({
    index: i,
    confidence: inv.confidence ?? 0.5,
    outcome: inv.triggered ? "pass" : "fail",
    query: inv.query ?? "",
    session_id: inv.session_id,
    timestamp: inv.timestamp,
  }));

  return (
    <div>
      <div className="flex justify-between items-center mb-8">
        <h3 className="text-sm tracking-widest uppercase text-foreground/80 font-bold font-headline">
          Invocation Timeline
        </h3>
        <div className="flex gap-4 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-primary" />
            Pass
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-destructive" />
            Fail
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={192}>
        <BarChart data={chartData} barCategoryGap={2}>
          <XAxis dataKey="index" hide />
          <YAxis domain={[0, 1]} hide />
          <RechartsTooltip
            content={<InvocationTimelineTooltip />}
            cursor={{ fill: "hsl(var(--muted-foreground) / 0.08)" }}
          />
          <Bar dataKey="confidence" radius={[3, 3, 0, 0]} maxBarSize={24}>
            {chartData.map((entry) => (
              <Cell
                key={`cell-${entry.index}`}
                fill={entry.outcome === "pass" ? "hsl(var(--primary))" : "hsl(var(--destructive))"}
                opacity={0.85}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function EvolutionHistory({
  evolution,
}: {
  evolution: EvolutionEntry[];
}) {
  const recent = evolution.slice(0, 8);
  if (recent.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">
        No evolution history yet.
      </p>
    );
  }

  function dotClasses(action: string): string {
    switch (action) {
      case "deployed":
        return "bg-primary ring-4 ring-background";
      case "validated":
        return "bg-input ring-4 ring-background";
      case "rejected":
      case "rolled_back":
        return "bg-input ring-4 ring-background opacity-60";
      default:
        return "bg-input ring-4 ring-background";
    }
  }

  function actionIcon(action: string) {
    switch (action) {
      case "deployed":
        return <RocketIcon className="size-3.5 text-primary" />;
      case "validated":
        return <CheckCircle2Icon className="size-3.5 text-primary" />;
      case "rejected":
      case "rolled_back":
        return <XCircleIcon className="size-3.5 text-destructive" />;
      default:
        return <PlusIcon className="size-3.5 text-muted-foreground" />;
    }
  }

  return (
    <div className="space-y-6 relative">
      <div className="absolute left-[11px] top-2 bottom-2 w-[1px] bg-border/30" />
      {recent.map((entry, i) => {
        const isDeployed = entry.action === "deployed";
        return (
          <div key={`${entry.proposal_id}-${i}`} className="relative flex items-start gap-3 pl-8">
            <div
              className={`absolute left-0 mt-0.5 size-6 rounded-full flex items-center justify-center ${dotClasses(entry.action)}`}
            >
              {actionIcon(entry.action)}
            </div>
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-headline capitalize ${isDeployed ? "font-bold text-foreground" : "text-foreground/80"}`}>
                {entry.action}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                {entry.details}
              </p>
              <p className="text-[10px] text-muted-foreground/60 mt-1 font-mono">
                {timeAgo(entry.timestamp)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RecentInvocationsTable({
  invocations,
}: {
  invocations: CanonicalInvocation[];
}) {
  const rows = invocations.slice(0, 15);
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">
        No invocations recorded.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="text-[10px] tracking-[0.2em] text-muted-foreground uppercase border-b border-border/10">
            <th className="px-8 py-4 font-normal">Session ID</th>
            <th className="px-8 py-4 font-normal">Query</th>
            <th className="px-8 py-4 font-normal">Outcome</th>
            <th className="px-8 py-4 font-normal text-right">Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((inv, i) => (
            <tr
              key={`${inv.session_id}-${i}`}
              className="hover:bg-secondary transition-colors"
            >
              <td className="py-3 px-8 font-mono text-xs text-primary">
                {inv.session_id.substring(0, 8)}
              </td>
              <td className="py-3 px-8 text-sm text-foreground max-w-[400px] truncate">
                {inv.query || (
                  <span className="text-muted-foreground/40 italic">
                    No query recorded
                  </span>
                )}
              </td>
              <td className="py-3 px-8">
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase ${
                    inv.triggered
                      ? "bg-primary/10 text-primary"
                      : "bg-destructive/10 text-destructive"
                  }`}
                >
                  {inv.triggered ? "Pass" : "Fail"}
                </span>
              </td>
              <td className="py-3 px-8 text-xs text-muted-foreground text-right whitespace-nowrap font-mono">
                {timeAgo(inv.timestamp)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExecutionMetricsPanel({
  durationStats,
  executionMetrics,
  tokenUsage,
}: {
  durationStats: { avg_duration_ms: number; execution_count: number };
  executionMetrics?: {
    avg_files_changed: number;
    total_lines_added: number;
    total_cost_usd: number;
  } | null;
  tokenUsage: { total_input_tokens: number; total_output_tokens: number };
}) {
  const metrics = [
    {
      label: "Avg Duration",
      value: formatDuration(durationStats.avg_duration_ms),
    },
    {
      label: "Total Cost",
      value: executionMetrics ? formatCost(executionMetrics.total_cost_usd) : "--",
    },
    {
      label: "Files Changed",
      value: executionMetrics
        ? executionMetrics.avg_files_changed.toFixed(1)
        : "--",
    },
    {
      label: "Lines Added",
      value: executionMetrics
        ? executionMetrics.total_lines_added.toLocaleString()
        : "--",
    },
  ];

  const totalTokens = tokenUsage.total_input_tokens + tokenUsage.total_output_tokens;
  const inputPct =
    totalTokens > 0
      ? Math.round((tokenUsage.total_input_tokens / totalTokens) * 100)
      : 0;

  return (
    <div className="space-y-6">
      {metrics.map((m) => (
        <div key={m.label} className="flex items-end justify-between">
          <span className="text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
            {m.label}
          </span>
          <span className="text-xl font-bold font-headline text-foreground">
            {m.value}
          </span>
        </div>
      ))}
      <div className="pt-4 border-t border-border/10">
        <div className="flex items-end justify-between mb-3">
          <span className="text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
            Token Usage
          </span>
          <span className="text-xs text-muted-foreground font-mono">
            {totalTokens.toLocaleString()} total
          </span>
        </div>
        <div className="w-full h-2 rounded-full bg-input overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${inputPct}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-[10px] text-muted-foreground">
            Input: {tokenUsage.total_input_tokens.toLocaleString()}
          </span>
          <span className="text-[10px] text-muted-foreground">
            Output: {tokenUsage.total_output_tokens.toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  );
}

function PendingProposalCards({
  proposals,
}: {
  proposals: PendingProposal[];
}) {
  if (proposals.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">
        No pending proposals.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {proposals.map((p) => (
        <div
          key={p.proposal_id}
          className="rounded-xl bg-secondary p-6 border border-border/10"
        >
          <div className="flex items-center gap-2 mb-3">
            <RocketIcon className="size-4 text-primary" />
            <span className="text-sm font-bold font-headline text-foreground capitalize flex-1">
              {p.action}
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">
              #{p.proposal_id.slice(0, 8)}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mb-4 line-clamp-3">
            {p.details}
          </p>
          <div className="flex items-center gap-3">
            <Button size="sm" className="bg-primary text-primary-foreground text-xs">
              Accept
            </Button>
            <Button size="sm" variant="secondary" className="bg-input text-foreground text-xs">
              Reject
            </Button>
            <span className="ml-auto text-[10px] text-muted-foreground font-mono">
              {timeAgo(p.timestamp)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function SkillReportV2() {
  const { name } = useParams<{ name: string }>();
  const { data, isPending, isError, error, refetch } = useSkillReport(name);
  const [activeTab, setActiveTab] = useState("overview");

  // Derive invocations sorted by recency
  const invocations = useMemo(() => {
    if (!data) return [];
    const items = (data.canonical_invocations ?? []).map((ci) => ({
      ...ci,
      timestamp: ci.timestamp || ci.occurred_at || "",
    }));
    items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return items;
  }, [data]);

  // --- Guard states ---

  if (!name) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <p className="text-sm text-destructive">No skill name provided</p>
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="sticky top-0 z-50 bg-muted w-full px-8 py-6">
          <Skeleton className="h-4 w-32 mb-4" />
          <Skeleton className="h-10 w-64 mb-4" />
          <Skeleton className="h-10 w-96" />
        </div>
        <div className="p-8 space-y-8">
          <div className="grid grid-cols-4 gap-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
          <div className="grid grid-cols-12 gap-6">
            <Skeleton className="col-span-7 h-72 rounded-xl" />
            <Skeleton className="col-span-5 h-72 rounded-xl" />
          </div>
          <div className="grid grid-cols-12 gap-6">
            <Skeleton className="col-span-8 h-64 rounded-xl" />
            <Skeleton className="col-span-4 h-64 rounded-xl" />
          </div>
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
      <div className="flex flex-1 items-center justify-center py-16">
        <p className="text-sm text-muted-foreground">No data yet</p>
      </div>
    );
  }

  // --- Derived values ---
  const { usage, evolution, pending_proposals, duration_stats, token_usage, execution_metrics, description_quality } = data;
  const status = deriveStatus(usage.pass_rate, usage.total_checks);
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.UNKNOWN;
  const passRate = usage.total_checks > 0 ? formatRate(usage.pass_rate) : "--";
  const triggerRate =
    usage.total_checks > 0
      ? `${Math.round((usage.triggered_count / usage.total_checks) * 100)}%`
      : "--";
  const uniqueSessions = data.sessions_with_skill;
  const descQuality = description_quality
    ? `${Math.round(description_quality.composite * 100)}%`
    : "--";

  return (
    <div className="flex flex-1 flex-col">
      {/* Sticky Header */}
      <header className="sticky top-0 z-50 bg-muted w-full px-8 py-6 flex flex-col gap-6">
        <div className="flex justify-between items-center">
          <div className="flex flex-col">
            {/* Breadcrumb */}
            <div className="flex items-center gap-2 text-muted-foreground text-xs font-headline tracking-widest uppercase mb-1">
              <Link
                to="/"
                className="flex items-center gap-1.5 hover:text-primary transition-colors"
              >
                <ArrowLeftIcon className="size-3" />
                Dashboard
              </Link>
              <span>/</span>
              <span>Skills</span>
            </div>
            {/* Title + Status */}
            <div className="flex items-center gap-4">
              <h2 className="text-3xl font-bold font-headline text-foreground tracking-tighter">
                {data.skill_name}
              </h2>
              <span
                className={`px-3 py-1 rounded-full border text-[10px] font-bold tracking-[0.2em] uppercase ${statusBadgeClasses(status)}`}
              >
                {config.label}
              </span>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex items-center gap-4">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <div className="flex bg-muted p-1 rounded-xl">
                <TabsList className="bg-transparent gap-0">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <TabsTrigger
                          value="overview"
                          className={`px-4 py-2 text-xs tracking-widest uppercase font-headline transition-colors ${
                            activeTab === "overview"
                              ? "text-primary border-b-2 border-primary"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        />
                      }
                    >
                      Overview
                    </TooltipTrigger>
                    <TooltipContent>Skill health summary and key metrics</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <TabsTrigger
                          value="invocations"
                          className={`px-4 py-2 text-xs tracking-widest uppercase font-headline transition-colors ${
                            activeTab === "invocations"
                              ? "text-primary border-b-2 border-primary"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        />
                      }
                    >
                      Invocations
                      {invocations.length > 0 && (
                        <Badge variant="secondary" className="ml-1.5 text-[10px]">
                          {invocations.length}
                        </Badge>
                      )}
                    </TooltipTrigger>
                    <TooltipContent>Recent skill triggers and their outcomes</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <TabsTrigger
                          value="evolution"
                          className={`px-4 py-2 text-xs tracking-widest uppercase font-headline transition-colors ${
                            activeTab === "evolution"
                              ? "text-primary border-b-2 border-primary"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        />
                      }
                    >
                      Evolution
                      {evolution.length > 0 && (
                        <Badge variant="secondary" className="ml-1.5 text-[10px]">
                          {evolution.length}
                        </Badge>
                      )}
                    </TooltipTrigger>
                    <TooltipContent>Change history and validation results</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <TabsTrigger
                          value="proposals"
                          className={`px-4 py-2 text-xs tracking-widest uppercase font-headline transition-colors ${
                            activeTab === "proposals"
                              ? "text-primary border-b-2 border-primary"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        />
                      }
                    >
                      Proposals
                      {pending_proposals.length > 0 && (
                        <Badge variant="destructive" className="ml-1.5 text-[10px]">
                          {pending_proposals.length}
                        </Badge>
                      )}
                    </TooltipTrigger>
                    <TooltipContent>Proposals awaiting review</TooltipContent>
                  </Tooltip>
                </TabsList>
              </div>
            </Tabs>
          </div>
        </div>
      </header>

      {/* Bento Grid Content */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="p-8 space-y-8">
          {/* ============ OVERVIEW TAB ============ */}
          <TabsContent value="overview" className="mt-0 space-y-8">
            {/* Row 1: 4 KPI Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
              <KPICard label="Pass Rate" value={passRate} trending={usage.pass_rate > 0.9} tooltip="Percentage of checks where the skill executed correctly" />
              <KPICard label="Trigger Rate" value={triggerRate} tooltip="Percentage of checks where the skill was triggered" />
              <KPICard label="Unique Sessions" value={uniqueSessions} tooltip="Number of distinct sessions that invoked this skill" />
              <KPICard label="Description Quality" value={descQuality} tooltip="Composite quality score of the skill's SKILL.md description" />
            </div>

            {/* Row 2: Invocation Timeline + Evolution History */}
            <div className="grid grid-cols-12 gap-6">
              <div className="col-span-12 xl:col-span-7 bg-muted p-8 rounded-xl">
                <InvocationTimeline invocations={invocations} />
              </div>

              <div className="col-span-12 xl:col-span-5 bg-muted p-8 rounded-xl relative">
                <h3 className="text-sm tracking-widest uppercase text-foreground/80 font-bold font-headline mb-8">
                  Evolution History
                </h3>
                <EvolutionHistory evolution={evolution} />
              </div>
            </div>

            {/* Row 3: Recent Invocations + Execution Metrics */}
            <div className="grid grid-cols-12 gap-6">
              <div className="col-span-12 xl:col-span-8 bg-muted rounded-xl overflow-hidden">
                <div className="px-8 py-6 border-b border-border/10">
                  <h3 className="text-sm tracking-widest uppercase text-foreground/80 font-bold font-headline">
                    Recent Invocations
                  </h3>
                </div>
                <RecentInvocationsTable invocations={invocations} />
              </div>

              <div className="col-span-12 xl:col-span-4 bg-muted p-8 rounded-xl">
                <h3 className="text-sm tracking-widest uppercase text-foreground/80 font-bold font-headline mb-8">
                  Execution Metrics
                </h3>
                <ExecutionMetricsPanel
                  durationStats={duration_stats}
                  executionMetrics={execution_metrics}
                  tokenUsage={token_usage}
                />
              </div>
            </div>

            {/* Row 4: Pending Proposals */}
            {pending_proposals.length > 0 && (
              <div className="bg-muted p-8 rounded-xl">
                <div className="flex justify-between items-center mb-8">
                  <h3 className="text-sm tracking-widest uppercase text-foreground/80 font-bold font-headline">
                    Pending Proposals
                  </h3>
                  <button
                    type="button"
                    className="text-xs text-primary font-bold font-headline tracking-wider uppercase hover:text-primary-accent transition-colors"
                    onClick={() => setActiveTab("proposals")}
                  >
                    View All
                  </button>
                </div>
                <PendingProposalCards proposals={pending_proposals} />
              </div>
            )}
          </TabsContent>

          {/* ============ INVOCATIONS TAB ============ */}
          <TabsContent value="invocations" className="mt-0">
            <div className="bg-muted rounded-xl overflow-hidden">
              <div className="px-8 py-6 border-b border-border/10 flex items-center justify-between">
                <h3 className="text-sm tracking-widest uppercase text-foreground/80 font-bold font-headline">
                  All Invocations
                  <span className="ml-2 text-muted-foreground font-normal">
                    ({invocations.length})
                  </span>
                </h3>
              </div>
              <RecentInvocationsTable invocations={invocations} />
            </div>
          </TabsContent>

          {/* ============ EVOLUTION TAB ============ */}
          <TabsContent value="evolution" className="mt-0">
            <div className="bg-muted rounded-xl p-8">
              <h3 className="text-sm tracking-widest uppercase text-foreground/80 font-bold font-headline mb-8">
                Full Evolution Trail
              </h3>
              {evolution.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No evolution history yet.
                </p>
              ) : (
                <div className="space-y-4">
                  {evolution.map((entry, i) => (
                    <div
                      key={`${entry.proposal_id}-${i}`}
                      className="rounded-xl bg-secondary p-6 border border-border/10"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        {entry.action === "deployed" ? (
                          <CheckCircle2Icon className="size-4 text-primary" />
                        ) : entry.action === "rolled_back" || entry.action === "rejected" ? (
                          <XCircleIcon className="size-4 text-destructive" />
                        ) : (
                          <GitBranchIcon className="size-4 text-muted-foreground" />
                        )}
                        <Badge
                          variant={
                            entry.action === "deployed"
                              ? "default"
                              : entry.action === "rolled_back" || entry.action === "rejected"
                                ? "destructive"
                                : "secondary"
                          }
                          className="text-[10px] capitalize"
                        >
                          {entry.action}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground font-mono ml-auto">
                          #{entry.proposal_id.slice(0, 8)} - {timeAgo(entry.timestamp)}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {entry.details}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          {/* ============ PROPOSALS TAB ============ */}
          <TabsContent value="proposals" className="mt-0">
            <div className="bg-muted rounded-xl p-8">
              <h3 className="text-sm tracking-widest uppercase text-foreground/80 font-bold font-headline mb-8">
                Pending Proposals
                <span className="ml-2 text-muted-foreground font-normal">
                  ({pending_proposals.length})
                </span>
              </h3>
              <PendingProposalCards proposals={pending_proposals} />
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
