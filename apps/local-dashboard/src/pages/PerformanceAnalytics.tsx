import {
  ActivityHeatmap,
  EvolutionROIList,
  PassRateTrendChart,
  SkillRankingsList,
} from "@selftune/ui/components";
import type { AnalyticsResponse } from "@selftune/ui/components";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@selftune/ui/primitives";
import { useQuery } from "@tanstack/react-query";
import { AlertCircleIcon, DownloadIcon, RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";

/* ── Data fetching ──────────────────────────────────────── */

async function fetchAnalytics(): Promise<AnalyticsResponse> {
  const response = await fetch("/api/v2/analytics");
  if (!response.ok) {
    throw new Error(`Failed to load analytics (${response.status})`);
  }
  return (await response.json()) as AnalyticsResponse;
}

function parseDayBucket(day: string): Date | null {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return null;
  return new Date(year, month - 1, date);
}

/* ── Main Page ──────────────────────────────────────────── */

export function PerformanceAnalytics() {
  const [chartMode, setChartMode] = useState<"pass_rate" | "volume">("pass_rate");

  const { data, isPending, isError, error, refetch } = useQuery<AnalyticsResponse>({
    queryKey: ["analytics"],
    queryFn: fetchAnalytics,
    refetchInterval: 30_000,
  });

  const lastGraded = useMemo(() => {
    if (!data?.pass_rate_trend.length) return null;
    const last = data.pass_rate_trend[data.pass_rate_trend.length - 1];
    if (!last) return null;
    const lastDay = parseDayBucket(last.date);
    if (!lastDay) return null;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const diffDays = Math.max(
      0,
      Math.floor((todayStart.getTime() - lastDay.getTime()) / 86_400_000),
    );
    if (diffDays === 0) return "today";
    if (diffDays === 1) return "1d ago";
    return `${diffDays}d ago`;
  }, [data]);

  const topSkills = useMemo(() => {
    if (!data?.skill_rankings) return [];
    return [...data.skill_rankings].sort((a, b) => b.pass_rate - a.pass_rate).slice(0, 5);
  }, [data]);

  const avgPassRate = useMemo(() => {
    if (!topSkills.length) return 0;
    return topSkills.reduce((sum, s) => sum + s.pass_rate, 0) / topSkills.length;
  }, [topSkills]);

  const improvedSkills = useMemo(() => {
    if (!data?.evolution_impact) return [];
    return data.evolution_impact.filter((e) => e.pass_rate_after > e.pass_rate_before);
  }, [data]);

  if (isPending) {
    return (
      <div className="@container/main flex flex-1 flex-col gap-6 py-6 px-4 lg:px-6">
        <Skeleton className="h-12 w-80" />
        <div className="grid grid-cols-12 gap-6">
          <Skeleton className="col-span-8 h-[380px] rounded-xl" />
          <Skeleton className="col-span-4 h-[380px] rounded-xl" />
          <Skeleton className="col-span-7 h-[320px] rounded-xl" />
          <Skeleton className="col-span-5 h-[320px] rounded-xl" />
          <Skeleton className="col-span-12 h-[140px] rounded-xl" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
        <AlertCircleIcon className="size-10 text-destructive" />
        <p className="text-sm font-medium text-destructive">
          {error instanceof Error ? error.message : "Failed to load analytics"}
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
          No analytics data available yet. Run some sessions and grading first.
        </p>
      </div>
    );
  }

  const { summary } = data;

  return (
    <div className="@container/main flex flex-1 flex-col gap-8 py-8 px-4 lg:px-6">
      {/* Hero Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-headline text-4xl font-bold tracking-tight text-foreground">
              Performance Analytics
            </h1>
            <Badge
              variant="outline"
              className="border-primary/20 bg-primary/10 text-primary gap-1.5 text-[10px] font-headline uppercase tracking-widest"
            >
              <span className="size-1.5 rounded-full bg-primary animate-pulse" />
              Live
            </Badge>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {lastGraded ? `Last graded: ${lastGraded}` : "Awaiting first grading run"}
            {summary.active_skills > 0 && ` \u00B7 ${summary.active_skills} active skills`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => refetch()}
            className="gap-1.5 font-headline text-[10px] uppercase tracking-widest"
          >
            <RefreshCwIcon className="size-3" />
            Refresh
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5 font-headline text-[10px] uppercase tracking-widest"
            disabled
            aria-disabled="true"
            title="Export is not available yet."
          >
            <DownloadIcon className="size-3" />
            Export
          </Button>
        </div>
      </div>

      {/* Bento Grid */}
      <div className="grid grid-cols-12 gap-6">
        {/* Row 1: Evolution Impact Curve */}
        <Card className="col-span-12 @4xl/main:col-span-8 bg-muted border-none shadow-none">
          <CardHeader className="pb-2">
            <CardDescription className="font-headline text-[10px] uppercase tracking-widest">
              Evolution Trajectory
            </CardDescription>
            <div className="flex items-center justify-between">
              <CardTitle className="font-headline text-lg">Evolution Impact Curve</CardTitle>
              <div className="flex items-center gap-1 bg-background rounded-lg p-0.5">
                {[
                  { key: "pass_rate" as const, label: "Pass Rate" },
                  { key: "volume" as const, label: "Check Volume" },
                ].map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setChartMode(tab.key)}
                    className={`px-3 py-1 rounded-md text-[10px] font-headline uppercase tracking-widest transition-colors ${
                      chartMode === tab.key
                        ? "bg-secondary text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <PassRateTrendChart data={data.pass_rate_trend} mode={chartMode} />
          </CardContent>
        </Card>

        {/* Row 1: Skill Performance */}
        <Card className="col-span-12 @4xl/main:col-span-4 bg-muted border-none shadow-none flex flex-col">
          <CardHeader className="pb-2">
            <CardDescription className="font-headline text-[10px] uppercase tracking-widest">
              Skill Rankings
            </CardDescription>
            <CardTitle className="font-headline text-lg">Skill Performance</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col">
            <SkillRankingsList skills={topSkills} />

            <div className="mt-5 pt-4 border-t border-border/20">
              <div className="flex items-center justify-between">
                <span className="font-headline text-[10px] uppercase tracking-widest text-muted-foreground">
                  Avg Pass Rate
                </span>
                <span className="font-headline text-2xl font-bold text-primary">
                  {topSkills.length > 0 ? `${Math.round(avgPassRate * 100)}%` : "--"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Row 2: Check Activity Heatmap */}
        <Card className="col-span-12 @4xl/main:col-span-7 bg-muted border-none shadow-none">
          <CardHeader className="pb-2">
            <CardDescription className="font-headline text-[10px] uppercase tracking-widest">
              Grading Activity
            </CardDescription>
            <CardTitle className="font-headline text-lg">Check Activity Over Time</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col">
            <ActivityHeatmap data={data.daily_activity} />
          </CardContent>
        </Card>

        {/* Row 2: Evolution ROI */}
        <Card className="col-span-12 @4xl/main:col-span-5 bg-muted border-none shadow-none">
          <CardHeader className="pb-2">
            <CardDescription className="font-headline text-[10px] uppercase tracking-widest">
              Evolution Outcomes
            </CardDescription>
            <CardTitle className="font-headline text-lg">Evolution ROI</CardTitle>
          </CardHeader>
          <CardContent>
            <EvolutionROIList impacts={data.evolution_impact} />
          </CardContent>
        </Card>

        {/* Row 3: Insight Card */}
        <Card className="col-span-12 bg-muted/60 backdrop-blur-md border-none shadow-none">
          <CardContent className="pt-6">
            <div className="flex flex-col @3xl/main:flex-row items-start @3xl/main:items-center justify-between gap-4">
              <div>
                <p className="font-headline text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                  Data-Driven Insight
                </p>
                <p className="text-[15px] text-foreground leading-relaxed max-w-2xl">
                  {improvedSkills.length > 0
                    ? `${improvedSkills.length} skill${improvedSkills.length !== 1 ? "s" : ""} improved after evolution, averaging ${Math.round(summary.avg_improvement * 100)}% improvement. ${summary.total_checks_30d} checks processed in the last 30 days across ${summary.active_skills} active skills.`
                    : summary.total_checks_30d > 0
                      ? `${summary.total_checks_30d} checks processed in the last 30 days across ${summary.active_skills} active skills. Run an evolution cycle to start improving skill pass rates.`
                      : "Start grading sessions to generate performance insights. Run selftune orchestrate to begin the autonomous improvement loop."}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <Button
                  size="sm"
                  className="font-headline text-[10px] uppercase tracking-widest"
                  disabled
                  aria-disabled="true"
                  title="Dashboard-triggered evolution is not available yet."
                >
                  Run Evolution
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="font-headline text-[10px] uppercase tracking-widest border-primary/20 text-primary hover:border-primary/40"
                  disabled
                  aria-disabled="true"
                  title="Detailed analytics drill-down is not available yet."
                >
                  View Details
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Footer Status Bar */}
      <div className="flex items-center justify-between text-[10px] font-headline uppercase tracking-widest text-muted-foreground px-1">
        <span>
          {summary.total_evolutions} evolution{summary.total_evolutions !== 1 ? "s" : ""} deployed
        </span>
        <span>{summary.total_checks_30d} checks (30d)</span>
        <span>
          {summary.active_skills} active skill{summary.active_skills !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}
