"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";

import type { AnalyticsResponse } from "@selftune/ui/components";
import {
  ActivityHeatmap,
  EvolutionROIList,
  PassRateTrendChart,
  SkillRankingsList,
} from "@selftune/ui/components";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@selftune/ui/primitives";

export interface AnalyticsScreenProps {
  data: AnalyticsResponse | null;
  isLoading: boolean;
  error?: string | null;
  onRefresh(): void;
  onRetry(): void;
  headerActions?: ReactNode;
  insightActions?: ReactNode;
}

function parseDayBucket(day: string): Date | null {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return null;
  return new Date(year, month - 1, date);
}

function AnalyticsScreenSkeleton() {
  return (
    <div className="@container/main flex flex-1 flex-col gap-6 px-4 py-6 lg:px-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-80 max-w-full" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <div className="grid grid-cols-12 gap-6">
        <Skeleton className="col-span-12 h-[380px] @4xl/main:col-span-8" />
        <Skeleton className="col-span-12 h-[380px] @4xl/main:col-span-4" />
        <Skeleton className="col-span-12 h-[320px] @4xl/main:col-span-7" />
        <Skeleton className="col-span-12 h-[320px] @4xl/main:col-span-5" />
        <Skeleton className="col-span-12 h-[140px]" />
      </div>
    </div>
  );
}

export function AnalyticsScreen({
  data,
  isLoading,
  error,
  onRefresh,
  onRetry,
  headerActions,
  insightActions,
}: AnalyticsScreenProps) {
  const [chartMode, setChartMode] = useState<"pass_rate" | "volume">("pass_rate");

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
    return data.skill_rankings.toSorted((a, b) => b.pass_rate - a.pass_rate).slice(0, 5);
  }, [data]);

  const avgPassRate = useMemo(() => {
    if (!topSkills.length) return 0;
    return topSkills.reduce((sum, skill) => sum + skill.pass_rate, 0) / topSkills.length;
  }, [topSkills]);

  const improvedSkills = useMemo(() => {
    if (!data?.evolution_impact) return [];
    return data.evolution_impact.filter((entry) => entry.pass_rate_after > entry.pass_rate_before);
  }, [data]);

  if (isLoading && !data) {
    return <AnalyticsScreenSkeleton />;
  }

  if (error && !data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
        <AlertCircleIcon className="size-10 text-destructive" />
        <p className="text-sm font-medium text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
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
    <div className="@container/main flex flex-1 flex-col gap-8 px-4 py-8 lg:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-headline text-4xl font-bold tracking-tight text-foreground">
              Performance Analytics
            </h1>
            <Badge
              variant="outline"
              className="gap-1.5 border-primary/20 bg-primary/10 font-headline text-[10px] uppercase tracking-widest text-primary"
            >
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              Live
            </Badge>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {lastGraded ? `Last graded: ${lastGraded}` : "Awaiting first grading run"}
            {summary.active_skills > 0 && ` · ${summary.active_skills} active skills`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            className="gap-1.5 font-headline text-[10px] uppercase tracking-widest"
          >
            <RefreshCwIcon className="size-3" />
            Refresh
          </Button>
          {headerActions}
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6">
        <Card className="col-span-12 border-none bg-muted shadow-none @4xl/main:col-span-8">
          <CardHeader className="pb-2">
            <CardDescription className="font-headline text-[10px] uppercase tracking-widest">
              Evolution Trajectory
            </CardDescription>
            <div className="flex items-center justify-between">
              <CardTitle className="font-headline text-lg">Evolution Impact Curve</CardTitle>
              <div className="flex items-center gap-1 rounded-lg bg-background p-0.5">
                {[
                  { key: "pass_rate" as const, label: "Pass Rate" },
                  { key: "volume" as const, label: "Check Volume" },
                ].map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setChartMode(tab.key)}
                    className={`rounded-md px-3 py-1 text-[10px] font-headline uppercase tracking-widest transition-colors ${
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

        <Card className="col-span-12 flex flex-col border-none bg-muted shadow-none @4xl/main:col-span-4">
          <CardHeader className="pb-2">
            <CardDescription className="font-headline text-[10px] uppercase tracking-widest">
              Skill Rankings
            </CardDescription>
            <CardTitle className="font-headline text-lg">Skill Performance</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col">
            <SkillRankingsList skills={topSkills} />

            <div className="mt-5 border-t border-border/20 pt-4">
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

        <Card className="col-span-12 border-none bg-muted shadow-none @4xl/main:col-span-7">
          <CardHeader className="pb-2">
            <CardDescription className="font-headline text-[10px] uppercase tracking-widest">
              Grading Activity
            </CardDescription>
            <CardTitle className="font-headline text-lg">Check Activity Over Time</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col">
            <ActivityHeatmap data={data.daily_activity} />
          </CardContent>
        </Card>

        <Card className="col-span-12 border-none bg-muted shadow-none @4xl/main:col-span-5">
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

        <Card className="col-span-12 border-none bg-muted/60 shadow-none backdrop-blur-md">
          <CardContent className="pt-6">
            <div className="flex flex-col items-start justify-between gap-4 @3xl/main:flex-row @3xl/main:items-center">
              <div>
                <p className="mb-2 font-headline text-[10px] uppercase tracking-widest text-muted-foreground">
                  Data-Driven Insight
                </p>
                <p className="max-w-2xl text-[15px] leading-relaxed text-foreground">
                  {improvedSkills.length > 0
                    ? `${improvedSkills.length} skill${improvedSkills.length !== 1 ? "s" : ""} improved after evolution, averaging ${Math.round(summary.avg_improvement * 100)}% improvement. ${summary.total_checks_30d} checks processed in the last 30 days across ${summary.active_skills} active skills.`
                    : summary.total_checks_30d > 0
                      ? `${summary.total_checks_30d} checks processed in the last 30 days across ${summary.active_skills} active skills. Run an evolution cycle to start improving skill pass rates.`
                      : "Start grading sessions to generate performance insights. Run selftune orchestrate to begin the autonomous improvement loop."}
                </p>
              </div>
              {insightActions ? (
                <div className="flex shrink-0 items-center gap-3">{insightActions}</div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center justify-between px-1 font-headline text-[10px] uppercase tracking-widest text-muted-foreground">
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
