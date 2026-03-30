import { STATUS_CONFIG } from "@selftune/ui/lib";
import { deriveStatus, formatRate, timeAgo } from "@selftune/ui/lib";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@selftune/ui/primitives";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  GitBranchIcon,
  RefreshCwIcon,
  RocketIcon,
  XCircleIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
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

function statusBadgeClasses(
  status: string,
): string {
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
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-xl bg-muted p-6 hover:bg-secondary transition-all">
      <p className="text-[10px] font-headline tracking-[0.2em] text-muted-foreground uppercase mb-2">
        {label}
      </p>
      <p className="text-4xl font-bold font-headline text-primary">{value}</p>
    </div>
  );
}

function InvocationTimeline({
  invocations,
}: {
  invocations: CanonicalInvocation[];
}) {
  // Take last 20 invocations, chronological order
  const recent = invocations.slice(0, 20).toReversed();
  if (recent.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">
        No invocation data yet.
      </p>
    );
  }

  const maxHeight = 120;

  return (
    <div>
      <div className="flex items-end gap-1.5 h-[140px] px-2 pt-4">
        {recent.map((inv, i) => {
          // Use confidence as bar height, fallback to a default
          const conf = inv.confidence ?? 0.5;
          const h = Math.max(8, Math.round(conf * maxHeight));
          return (
            <div
              key={`${inv.session_id}-${i}`}
              className="flex-1 flex items-end justify-center"
              title={`${inv.query ?? "no query"} — ${inv.triggered ? "pass" : "fail"}`}
            >
              <div
                className={`w-full rounded-t-sm ${inv.triggered ? "bg-primary" : "bg-destructive"}`}
                style={{ height: `${h}px` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 mt-4 px-2">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-2 rounded-full bg-primary" />
          Pass
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-2 rounded-full bg-destructive" />
          Fail
        </span>
      </div>
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

  return (
    <div className="relative pl-6">
      {/* Vertical line */}
      <div className="absolute left-[11px] top-2 bottom-2 w-[1px] bg-border/30" />
      <div className="space-y-5">
        {recent.map((entry, i) => {
          const isDeployed = entry.action === "deployed";
          return (
            <div key={`${entry.proposal_id}-${i}`} className="relative flex items-start gap-3">
              {/* Dot */}
              <div
                className={`absolute -left-6 mt-0.5 size-[10px] rounded-full border-2 ${
                  isDeployed
                    ? "bg-primary border-primary"
                    : "bg-input border-border"
                }`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground capitalize">
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
      <table className="w-full">
        <thead>
          <tr className="border-b border-border/10">
            <th className="text-left text-[10px] font-headline tracking-[0.2em] text-muted-foreground uppercase py-2 px-3">
              Session ID
            </th>
            <th className="text-left text-[10px] font-headline tracking-[0.2em] text-muted-foreground uppercase py-2 px-3">
              Query
            </th>
            <th className="text-left text-[10px] font-headline tracking-[0.2em] text-muted-foreground uppercase py-2 px-3">
              Outcome
            </th>
            <th className="text-right text-[10px] font-headline tracking-[0.2em] text-muted-foreground uppercase py-2 px-3">
              Timestamp
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((inv, i) => (
            <tr
              key={`${inv.session_id}-${i}`}
              className="hover:bg-secondary transition-colors"
            >
              <td className="py-2.5 px-3 font-mono text-xs text-primary">
                {inv.session_id.substring(0, 8)}
              </td>
              <td className="py-2.5 px-3 text-sm text-card-foreground max-w-[400px] truncate">
                {inv.query || (
                  <span className="text-muted-foreground/40 italic">
                    No query recorded
                  </span>
                )}
              </td>
              <td className="py-2.5 px-3">
                <Badge
                  variant={inv.triggered ? "default" : "destructive"}
                  className="text-[10px]"
                >
                  {inv.triggered ? "Pass" : "Fail"}
                </Badge>
              </td>
              <td className="py-2.5 px-3 text-xs text-muted-foreground text-right whitespace-nowrap font-mono">
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
    <div className="space-y-4">
      {metrics.map((m) => (
        <div key={m.label} className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{m.label}</span>
          <span className="text-sm font-bold font-headline text-foreground">
            {m.value}
          </span>
        </div>
      ))}
      <div className="pt-2 border-t border-border/10">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-muted-foreground">Token Usage</span>
          <span className="text-xs text-muted-foreground font-mono">
            {totalTokens.toLocaleString()} total
          </span>
        </div>
        <div className="w-full h-2 rounded-full bg-secondary overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${inputPct}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-1">
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
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {proposals.map((p) => (
        <div
          key={p.proposal_id}
          className="rounded-xl bg-secondary p-6 border border-border/10"
        >
          <div className="flex items-center gap-2 mb-3">
            <RocketIcon className="size-4 text-primary" />
            <span className="text-sm font-bold font-headline text-foreground capitalize">
              {p.action}
            </span>
            <span className="ml-auto text-[10px] font-mono text-muted-foreground">
              #{p.proposal_id.slice(0, 8)}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mb-4 line-clamp-3">
            {p.details}
          </p>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground font-mono">
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
      <div className="flex flex-1 flex-col gap-6 p-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-4 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-12 gap-6">
          <Skeleton className="col-span-7 h-56 rounded-xl" />
          <Skeleton className="col-span-5 h-56 rounded-xl" />
        </div>
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
      <div className="sticky top-0 z-30 bg-background/80 backdrop-blur-xl border-b border-border/15">
        <div className="p-6 pb-0">
          {/* Breadcrumb */}
          <div className="flex items-center gap-2 mb-4">
            <Link
              to="/"
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors"
            >
              <ArrowLeftIcon className="size-3.5" />
              Dashboard
            </Link>
            <span className="text-muted-foreground/40">/</span>
            <span className="text-sm text-muted-foreground">Skills</span>
          </div>

          {/* Title + Status */}
          <div className="flex items-center gap-3 mb-4">
            <h1 className="text-3xl font-bold font-headline tracking-tighter">
              {data.skill_name}
            </h1>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${statusBadgeClasses(status)}`}
            >
              {config.label}
            </span>
          </div>

          {/* Tab bar */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="bg-muted p-1 rounded-xl inline-flex">
              <TabsList className="bg-transparent gap-0">
                <TabsTrigger
                  value="overview"
                  className={`px-4 py-2 rounded-lg text-sm font-headline transition-colors ${
                    activeTab === "overview"
                      ? "border-b-2 border-primary text-primary bg-background"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Overview
                </TabsTrigger>
                <TabsTrigger
                  value="invocations"
                  className={`px-4 py-2 rounded-lg text-sm font-headline transition-colors ${
                    activeTab === "invocations"
                      ? "border-b-2 border-primary text-primary bg-background"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Invocations
                  {invocations.length > 0 && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">
                      {invocations.length}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="evolution"
                  className={`px-4 py-2 rounded-lg text-sm font-headline transition-colors ${
                    activeTab === "evolution"
                      ? "border-b-2 border-primary text-primary bg-background"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Evolution
                  {evolution.length > 0 && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">
                      {evolution.length}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="proposals"
                  className={`px-4 py-2 rounded-lg text-sm font-headline transition-colors ${
                    activeTab === "proposals"
                      ? "border-b-2 border-primary text-primary bg-background"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Proposals
                  {pending_proposals.length > 0 && (
                    <Badge variant="destructive" className="ml-1.5 text-[10px]">
                      {pending_proposals.length}
                    </Badge>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>
          </Tabs>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 p-6">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          {/* ============ OVERVIEW TAB ============ */}
          <TabsContent value="overview" className="mt-0 space-y-6">
            {/* Row 1: 4 KPI cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
              <KPICard label="Pass Rate" value={passRate} />
              <KPICard label="Trigger Rate" value={triggerRate} />
              <KPICard label="Unique Sessions" value={uniqueSessions} />
              <KPICard label="Description Quality" value={descQuality} />
            </div>

            {/* Row 2: Invocation Timeline + Evolution History */}
            <div className="grid grid-cols-12 gap-6">
              <Card className="col-span-12 xl:col-span-7 rounded-xl bg-muted border-none">
                <CardHeader>
                  <CardTitle className="text-sm font-headline">
                    Invocation Timeline
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <InvocationTimeline invocations={invocations} />
                </CardContent>
              </Card>

              <Card className="col-span-12 xl:col-span-5 rounded-xl bg-muted border-none">
                <CardHeader>
                  <CardTitle className="text-sm font-headline">
                    Evolution History
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <EvolutionHistory evolution={evolution} />
                </CardContent>
              </Card>
            </div>

            {/* Row 3: Recent Invocations + Execution Metrics */}
            <div className="grid grid-cols-12 gap-6">
              <Card className="col-span-12 xl:col-span-8 rounded-xl bg-muted border-none">
                <CardHeader>
                  <CardTitle className="text-sm font-headline">
                    Recent Invocations
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <RecentInvocationsTable invocations={invocations} />
                </CardContent>
              </Card>

              <Card className="col-span-12 xl:col-span-4 rounded-xl bg-muted border-none">
                <CardHeader>
                  <CardTitle className="text-sm font-headline">
                    Execution Metrics
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ExecutionMetricsPanel
                    durationStats={duration_stats}
                    executionMetrics={execution_metrics}
                    tokenUsage={token_usage}
                  />
                </CardContent>
              </Card>
            </div>

            {/* Row 4: Pending Proposals */}
            {pending_proposals.length > 0 && (
              <Card className="rounded-xl bg-muted border-none">
                <CardHeader>
                  <CardTitle className="text-sm font-headline">
                    Pending Proposals
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <PendingProposalCards proposals={pending_proposals} />
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ============ INVOCATIONS TAB ============ */}
          <TabsContent value="invocations" className="mt-0">
            <Card className="rounded-xl bg-muted border-none">
              <CardHeader>
                <CardTitle className="text-sm font-headline">
                  All Invocations
                  <span className="ml-2 text-muted-foreground font-normal">
                    ({invocations.length})
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <RecentInvocationsTable invocations={invocations} />
              </CardContent>
            </Card>
          </TabsContent>

          {/* ============ EVOLUTION TAB ============ */}
          <TabsContent value="evolution" className="mt-0">
            <Card className="rounded-xl bg-muted border-none">
              <CardHeader>
                <CardTitle className="text-sm font-headline">
                  Full Evolution Trail
                </CardTitle>
              </CardHeader>
              <CardContent>
                {evolution.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No evolution history yet.
                  </p>
                ) : (
                  <div className="space-y-4">
                    {evolution.map((entry, i) => (
                      <div
                        key={`${entry.proposal_id}-${i}`}
                        className="rounded-xl bg-secondary p-4 border border-border/10"
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
              </CardContent>
            </Card>
          </TabsContent>

          {/* ============ PROPOSALS TAB ============ */}
          <TabsContent value="proposals" className="mt-0">
            <Card className="rounded-xl bg-muted border-none">
              <CardHeader>
                <CardTitle className="text-sm font-headline">
                  Pending Proposals
                  <span className="ml-2 text-muted-foreground font-normal">
                    ({pending_proposals.length})
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <PendingProposalCards proposals={pending_proposals} />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
