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
import { AlertCircleIcon, ArrowUpRightIcon, DownloadIcon, RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";

/* ── Types ──────────────────────────────────────────────── */

interface PassRateTrendPoint {
  date: string;
  pass_rate: number;
  total_checks: number;
}

interface SkillRanking {
  skill_name: string;
  pass_rate: number;
  total_checks: number;
  triggered_count: number;
}

interface DailyActivity {
  date: string;
  checks: number;
}

interface EvolutionImpact {
  skill_name: string;
  proposal_id: string;
  deployed_at: string;
  pass_rate_before: number;
  pass_rate_after: number;
}

interface AnalyticsSummary {
  total_evolutions: number;
  avg_improvement: number;
  total_checks_30d: number;
  active_skills: number;
}

interface AnalyticsResponse {
  pass_rate_trend: PassRateTrendPoint[];
  skill_rankings: SkillRanking[];
  daily_activity: DailyActivity[];
  evolution_impact: EvolutionImpact[];
  summary: AnalyticsSummary;
}

/* ── Data fetching ──────────────────────────────────────── */

function fetchAnalytics(): Promise<AnalyticsResponse> {
  return fetch("/api/v2/analytics").then((r) => r.json());
}

/* ── SVG Line Chart ─────────────────────────────────────── */

function EvolutionChart({
  data,
  mode,
}: {
  data: PassRateTrendPoint[];
  mode: "pass_rate" | "volume";
}) {
  const width = 720;
  const height = 260;
  const padX = 48;
  const padY = 32;
  const padBottom = 28;

  const values = data.map((d) => (mode === "pass_rate" ? d.pass_rate * 100 : d.total_checks));
  const maxVal = Math.max(...values, mode === "pass_rate" ? 100 : 1);
  const minVal = 0;

  const chartW = width - padX * 2;
  const chartH = height - padY - padBottom;

  const points = values.map((v, i) => {
    const x = padX + (i / Math.max(1, values.length - 1)) * chartW;
    const y = padY + chartH - ((v - minVal) / Math.max(1, maxVal - minVal)) * chartH;
    return { x, y };
  });

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const areaD = `${pathD} L${points[points.length - 1]?.x ?? padX},${padY + chartH} L${padX},${padY + chartH} Z`;

  const yTicks =
    mode === "pass_rate"
      ? [0, 25, 50, 75, 100]
      : Array.from({ length: 5 }, (_, i) => Math.round((maxVal / 4) * i));

  const xLabels: Array<{ label: string; x: number }> = [];
  const step = Math.max(1, Math.floor(data.length / 6));
  for (let i = 0; i < data.length; i += step) {
    const d = data[i];
    const pt = points[i];
    if (d && pt) {
      const date = new Date(d.date);
      xLabels.push({ label: `${date.getMonth() + 1}/${date.getDate()}`, x: pt.x });
    }
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[260px] text-muted-foreground text-sm">
        No trend data available yet
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-auto"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {yTicks.map((tick) => {
        const y = padY + chartH - ((tick - minVal) / Math.max(1, maxVal - minVal)) * chartH;
        return (
          <g key={tick}>
            <line
              x1={padX}
              y1={y}
              x2={width - padX}
              y2={y}
              stroke="var(--border)"
              strokeWidth="0.5"
              strokeDasharray="4 4"
            />
            <text
              x={padX - 8}
              y={y + 3}
              textAnchor="end"
              fill="var(--muted-foreground)"
              fontSize="9"
              fontFamily="var(--font-headline)"
            >
              {mode === "pass_rate" ? `${tick}%` : tick}
            </text>
          </g>
        );
      })}

      {xLabels.map((label) => (
        <text
          key={label.label}
          x={label.x}
          y={height - 4}
          textAnchor="middle"
          fill="var(--muted-foreground)"
          fontSize="9"
          fontFamily="var(--font-headline)"
        >
          {label.label}
        </text>
      ))}

      {points.length > 1 && <path d={areaD} fill="url(#chart-fill)" />}

      {points.length > 1 && (
        <path
          d={pathD}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ filter: "drop-shadow(0 0 4px rgba(79,242,255,0.5))" }}
        />
      )}

      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r="3"
          fill="var(--primary)"
          stroke="var(--muted)"
          strokeWidth="1.5"
        />
      ))}
    </svg>
  );
}

/* ── Heatmap Grid ───────────────────────────────────────── */

function ActivityHeatmap({ data }: { data: DailyActivity[] }) {
  const maxChecks = Math.max(...data.map((d) => d.checks), 1);
  const cells = data.slice(-84);

  if (cells.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
        No grading activity recorded yet
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-12 gap-1.5">
        {cells.map((day) => {
          const intensity = day.checks / maxChecks;
          const opacity = Math.max(0.08, intensity);
          return (
            <div
              key={day.date}
              className="aspect-square rounded-sm transition-colors"
              style={{
                backgroundColor: `color-mix(in srgb, var(--primary) ${Math.round(opacity * 100)}%, transparent)`,
              }}
              title={`${day.date}: ${day.checks} checks`}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-2 mt-3">
        <span className="text-[10px] font-headline uppercase tracking-widest text-muted-foreground">
          Quiet
        </span>
        {[8, 25, 50, 75, 100].map((pct) => (
          <div
            key={pct}
            className="size-3 rounded-sm"
            style={{ backgroundColor: `color-mix(in srgb, var(--primary) ${pct}%, transparent)` }}
          />
        ))}
        <span className="text-[10px] font-headline uppercase tracking-widest text-muted-foreground">
          Active
        </span>
      </div>
    </div>
  );
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
    const diff = Date.now() - new Date(last.date).getTime();
    const mins = Math.round(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
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
          <p className="mt-2 text-[13px] text-muted-foreground">
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
            <EvolutionChart data={data.pass_rate_trend} mode={chartMode} />
          </CardContent>
        </Card>

        {/* Row 1: Skill Performance */}
        <Card className="col-span-12 @4xl/main:col-span-4 bg-secondary border-none shadow-none flex flex-col">
          <CardHeader className="pb-2">
            <CardDescription className="font-headline text-[10px] uppercase tracking-widest">
              Skill Rankings
            </CardDescription>
            <CardTitle className="font-headline text-lg">Skill Performance</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col">
            {topSkills.length === 0 ? (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-sm text-muted-foreground">No skills graded yet</p>
              </div>
            ) : (
              <div className="flex-1 flex flex-col gap-4">
                {topSkills.map((skill) => (
                  <div key={skill.skill_name}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="font-headline text-[11px] uppercase tracking-wider text-foreground truncate max-w-[65%]">
                        {skill.skill_name}
                      </span>
                      <span className="font-headline text-xs font-semibold text-primary">
                        {Math.round(skill.pass_rate * 100)}%
                      </span>
                    </div>
                    <div className="h-[1.5px] rounded-full bg-border/30 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-500"
                        style={{
                          width: `${Math.round(skill.pass_rate * 100)}%`,
                          boxShadow: "0 0 6px rgba(79,242,255,0.4)",
                        }}
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {skill.total_checks} checks &middot; {skill.triggered_count} triggered
                    </p>
                  </div>
                ))}
              </div>
            )}

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
          <CardContent>
            <ActivityHeatmap data={data.daily_activity} />
          </CardContent>
        </Card>

        {/* Row 2: Evolution ROI */}
        <Card className="col-span-12 @4xl/main:col-span-5 bg-secondary border-none shadow-none">
          <CardHeader className="pb-2">
            <CardDescription className="font-headline text-[10px] uppercase tracking-widest">
              Evolution Outcomes
            </CardDescription>
            <CardTitle className="font-headline text-lg">Evolution ROI</CardTitle>
          </CardHeader>
          <CardContent>
            {data.evolution_impact.length === 0 ? (
              <div className="flex items-center justify-center h-32">
                <p className="text-sm text-muted-foreground">No evolution deployments yet</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3 max-h-[260px] overflow-y-auto">
                {data.evolution_impact.map((evo) => {
                  const delta = (evo.pass_rate_after - evo.pass_rate_before) * 100;
                  const improved = delta > 0;
                  return (
                    <div
                      key={evo.proposal_id}
                      className="flex items-center justify-between bg-muted/50 rounded-lg px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="font-headline text-[11px] uppercase tracking-wider text-foreground truncate">
                          {evo.skill_name}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {Math.round(evo.pass_rate_before * 100)}% &rarr;{" "}
                          {Math.round(evo.pass_rate_after * 100)}%
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <ArrowUpRightIcon
                          className={`size-3.5 ${improved ? "text-primary" : "text-destructive rotate-90"}`}
                        />
                        <span
                          className={`font-headline text-sm font-semibold ${improved ? "text-primary" : "text-destructive"}`}
                        >
                          {improved ? "+" : ""}
                          {Math.round(delta)}%
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
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
                <Button size="sm" className="font-headline text-[10px] uppercase tracking-widest">
                  Run Evolution
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="font-headline text-[10px] uppercase tracking-widest border-primary/20 text-primary hover:border-primary/40"
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
