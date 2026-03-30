import { ActivityPanel, OrchestrateRunsPanel, RecentActivityFeed } from "@selftune/ui/components";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@selftune/ui/primitives";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  ArrowRightIcon,
  BotIcon,
  LayersIcon,
  RefreshCwIcon,
  RocketIcon,
  SparklesIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Skeleton } from "@/components/ui/skeleton";
import { useOrchestrateRuns } from "@/hooks/useOrchestrateRuns";
import type { SkillCard, SkillHealthStatus, SkillSummary, OverviewResponse } from "@/types";
import { deriveStatus, sortByPassRateAndChecks } from "@/utils";

function deriveSkillCards(skills: SkillSummary[]): SkillCard[] {
  return sortByPassRateAndChecks(
    skills.map((s) => ({
      name: s.skill_name,
      scope: s.skill_scope,
      passRate: s.total_checks > 0 ? s.pass_rate : null,
      checks: s.total_checks,
      status: deriveStatus(s.pass_rate, s.total_checks),
      hasEvidence: s.has_evidence,
      uniqueSessions: s.unique_sessions,
      lastSeen: s.last_seen,
    })),
  );
}

function OnboardingBanner({ skillCount }: { skillCount: number }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem("selftune-onboarding-dismissed") === "true";
    } catch {
      return false;
    }
  });

  const shouldShow = !dismissed || skillCount === 0;
  if (!shouldShow) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem("selftune-onboarding-dismissed", "true");
    } catch {
      // ignore storage errors
    }
  };

  if (skillCount === 0) {
    return (
      <Card className="col-span-12 p-8">
        <div className="flex flex-col items-center text-center gap-4 max-w-md mx-auto">
          <div className="flex items-center justify-center size-12 rounded-full bg-primary/10">
            <RocketIcon className="size-6 text-primary" />
          </div>
          <h2 className="font-headline text-lg font-semibold text-foreground">
            Welcome to selftune
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            No skills detected yet. Once you start using selftune in your project, skills will
            appear here automatically.
          </p>
          <div className="grid grid-cols-1 gap-3 w-full text-left sm:grid-cols-3">
            {[
              {
                num: 1,
                color: "#4ff2ff",
                title: "Run selftune",
                desc: "Enable selftune in your project to start tracking skills",
              },
              {
                num: 2,
                color: "#73f0f6",
                title: "Skills appear",
                desc: "Skills are detected and monitored automatically",
              },
              {
                num: 3,
                color: "#00d5e3",
                title: "Watch evolution",
                desc: "Proposals flow in with validated improvements",
              },
            ].map((step) => (
              <div
                key={step.num}
                className="flex items-start gap-2.5 rounded-lg bg-muted/50 backdrop-blur-sm p-3"
              >
                <div
                  className="flex items-center justify-center size-6 rounded-full shrink-0 text-xs font-bold"
                  style={{ backgroundColor: `${step.color}15`, color: step.color }}
                >
                  {step.num}
                </div>
                <div>
                  <p className="text-xs font-medium text-foreground">{step.title}</p>
                  <p className="text-[11px] text-muted-foreground">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="col-span-12 flex-row items-center gap-3 px-4 py-3">
      <RocketIcon className="size-4 text-primary/60 shrink-0" />
      <p className="flex-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Welcome to selftune dashboard.</span> Hover
        over any metric label for an explanation. Click proposals in the Evolution timeline to see
        detailed evidence.
      </p>
      <Button
        variant="ghost"
        size="sm"
        onClick={dismiss}
        className="text-muted-foreground/50 hover:text-muted-foreground shrink-0 p-1 h-auto"
      >
        <XIcon className="size-4" />
        <span className="sr-only">Dismiss</span>
      </Button>
    </Card>
  );
}

/* ── Donut Ring SVG ────────────────────────────────────── */
function DonutChart({
  value,
  size = 160,
  stroke = 14,
}: {
  value: number;
  size?: number;
  stroke?: number;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = circumference * value;
  const gap = circumference - filled;

  return (
    <svg width={size} height={size} className="block">
      {/* Track */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--muted)"
        strokeWidth={stroke}
      />
      {/* Value */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={stroke}
        strokeDasharray={`${filled} ${gap}`}
        strokeDashoffset={circumference * 0.25}
        strokeLinecap="round"
        className="transition-all duration-700"
        style={{ filter: "drop-shadow(0 0 6px rgba(79,242,255,0.4))" }}
      />
      {/* Center text */}
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        className="font-headline text-2xl font-extrabold"
        fill="var(--primary)"
      >
        {Math.round(value * 100)}%
      </text>
    </svg>
  );
}

/* ── Bar Chart Visualization (CSS bars) ───────────────── */
function BarChartViz({ skills }: { skills: SkillSummary[] }) {
  // Generate bar heights from skill pass rates, pad to at least 12 bars
  const bars: number[] = [];
  const sorted = [...skills].sort((a, b) => b.pass_rate - a.pass_rate);
  for (let i = 0; i < Math.max(12, sorted.length); i++) {
    if (i < sorted.length && sorted[i].total_checks > 0) {
      bars.push(sorted[i].pass_rate);
    } else {
      bars.push(0.1 + Math.random() * 0.3);
    }
  }

  return (
    <div className="absolute inset-0 flex items-end justify-center gap-[6px] px-8 pb-20 pt-24 opacity-30 pointer-events-none">
      {bars.slice(0, 16).map((height, i) => (
        <div
          key={i}
          className="flex-1 rounded-t-sm min-w-[12px]"
          style={{
            height: `${Math.max(8, height * 100)}%`,
            backgroundColor: `rgba(79, 242, 255, ${0.15 + height * 0.25})`,
          }}
        />
      ))}
    </div>
  );
}

/* ── Skill Status Item ────────────────────────────────── */
function SkillStatusItem({ card }: { card: SkillCard }) {
  const statusColor =
    card.status === "HEALTHY"
      ? "bg-primary"
      : card.status === "WARNING"
        ? "bg-amber-400"
        : card.status === "CRITICAL"
          ? "bg-red-400"
          : "bg-muted-foreground/40";

  const statusLabel =
    card.status === "HEALTHY"
      ? "ACTIVE"
      : card.status === "WARNING"
        ? "BUSY"
        : card.status === "CRITICAL"
          ? "ALERT"
          : "IDLE";

  const statusBadgeClass =
    card.status === "HEALTHY"
      ? "bg-primary/10 text-primary"
      : card.status === "WARNING"
        ? "bg-amber-500/10 text-amber-400"
        : card.status === "CRITICAL"
          ? "bg-red-500/10 text-red-400"
          : "bg-muted text-muted-foreground";

  return (
    <div className="flex items-center gap-3 py-2.5">
      <div
        className={`size-9 rounded-lg ${statusColor}/15 flex items-center justify-center shrink-0`}
      >
        <SparklesIcon className="size-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{card.name}</p>
        <p className="text-[11px] text-muted-foreground">
          {card.checks} checks &middot;{" "}
          {card.passRate !== null ? `${Math.round(card.passRate * 100)}%` : "N/A"} pass
        </p>
      </div>
      <Badge
        variant="secondary"
        className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${statusBadgeClass}`}
      >
        {statusLabel}
      </Badge>
    </div>
  );
}

export function Overview({
  search,
  statusFilter,
  onStatusFilterChange,
  overviewQuery,
}: {
  search: string;
  statusFilter: SkillHealthStatus | "ALL";
  onStatusFilterChange: (v: SkillHealthStatus | "ALL") => void;
  overviewQuery: UseQueryResult<OverviewResponse>;
}) {
  const navigate = useNavigate();
  const { data, isPending, isError, error, refetch } = overviewQuery;
  const orchestrateQuery = useOrchestrateRuns();

  const cards = useMemo(() => (data ? deriveSkillCards(data.skills) : []), [data]);

  const filteredCards = useMemo(() => {
    let result = cards;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((c) => c.name.toLowerCase().includes(q));
    }
    if (statusFilter !== "ALL") {
      result = result.filter((c) => c.status === statusFilter);
    }
    return result;
  }, [cards, search, statusFilter]);

  if (isPending) {
    return (
      <div className="@container/main flex flex-1 flex-col gap-6 py-6 px-4 lg:px-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-12 gap-6">
          <Skeleton className="col-span-8 h-[400px] rounded-xl" />
          <Skeleton className="col-span-4 h-[400px] rounded-xl" />
          <Skeleton className="col-span-4 h-[320px] rounded-xl" />
          <Skeleton className="col-span-8 h-[320px] rounded-xl" />
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

  const { overview, skills } = data;
  const gradedSkills = skills.filter((s) => s.total_checks >= 5);
  const avgPassRate =
    gradedSkills.length > 0
      ? gradedSkills.reduce((sum, s) => sum + s.pass_rate, 0) / gradedSkills.length
      : null;

  // Derive trigger rate as the "system health" metric
  const totalChecks = skills.reduce((sum, s) => sum + s.total_checks, 0);
  const totalTriggered = skills.reduce((sum, s) => sum + s.triggered_count, 0);
  const triggerRate = totalChecks > 0 ? totalTriggered / totalChecks : 0;
  const healthPct = `${(triggerRate * 100).toFixed(2)}%`;

  const handleSelectProposal = (skillName: string, proposalId: string) => {
    navigate(`/skills/${encodeURIComponent(skillName)}?proposal=${encodeURIComponent(proposalId)}`);
  };

  // Orchestrate progress
  const orchRuns = orchestrateQuery.data?.runs ?? [];
  const latestRun = orchRuns[0];
  const totalDeployed = orchRuns.reduce((sum, r) => sum + r.deployed, 0);
  const totalEvolved = orchRuns.reduce((sum, r) => sum + r.evolved, 0);
  const orchProgress =
    orchRuns.length > 0
      ? Math.min(1, (totalDeployed + totalEvolved * 0.5) / Math.max(1, skills.length))
      : 0;

  return (
    <div className="@container/main flex flex-1 flex-col gap-8 py-8 px-4 lg:px-6">
      {/* ── Hero Section ─────────────────────────────────── */}
      <div>
        <h1 className="font-headline text-4xl font-bold tracking-tight text-foreground">
          Ecosystem Overview
        </h1>
        <p className="mt-2 text-[15px] text-muted-foreground max-w-2xl leading-relaxed">
          Real-time synthesis of skill routing health, evolution flow, and autonomous model
          calibration.
        </p>
      </div>

      {/* ── Bento Grid ───────────────────────────────────── */}
      <div className="grid grid-cols-12 gap-6">
        <OnboardingBanner skillCount={skills.length} />

        {/* ── Row 1: System Health (col-span-8) ──────────── */}
        <Card className="col-span-12 @4xl/main:col-span-8 min-h-[400px] relative overflow-hidden ghost-border p-0">
          {/* Background bar chart */}
          <BarChartViz skills={skills} />

          {/* Content overlay */}
          <div className="relative z-10 flex flex-col h-full p-6">
            {/* Top row */}
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="size-3 rounded-full bg-primary animate-pulse shadow-[0_0_12px_rgba(79,242,255,0.6)]" />
                <div>
                  <h2 className="font-headline text-lg font-semibold text-foreground">
                    System Health
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Neural load: {totalChecks} checks &middot; {overview.counts.sessions} sessions
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="font-headline text-5xl font-extrabold text-primary text-glow leading-none">
                  {healthPct}
                </p>
                <p className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground mt-1">
                  Trigger Precision
                </p>
              </div>
            </div>

            {/* Spacer pushes mini stats to bottom */}
            <div className="flex-1" />

            {/* Bottom mini stat cards */}
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-muted/50 backdrop-blur-sm rounded-lg p-3">
                <p className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  Skills Tracked
                </p>
                <p className="font-headline text-2xl font-bold text-foreground mt-1">
                  {skills.length}
                </p>
              </div>
              <div className="bg-muted/50 backdrop-blur-sm rounded-lg p-3">
                <p className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  Active Sessions
                </p>
                <p className="font-headline text-2xl font-bold text-foreground mt-1">
                  {overview.active_sessions}
                </p>
              </div>
              <div className="bg-muted/50 backdrop-blur-sm rounded-lg p-3">
                <p className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  Proposals Pending
                </p>
                <p className="font-headline text-2xl font-bold text-primary mt-1">
                  {overview.pending_proposals.length}
                </p>
              </div>
            </div>
          </div>
        </Card>

        {/* ── Row 1: Global Learning Rate (col-span-4) ───── */}
        <Card className="col-span-12 @4xl/main:col-span-4 ghost-border flex flex-col items-center justify-center p-6 min-h-[400px]">
          <p className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-6">
            Global Learning Rate
          </p>
          <DonutChart value={avgPassRate ?? 0} size={180} stroke={16} />
          <div className="mt-6 text-center">
            {avgPassRate !== null ? (
              <>
                <p className="font-headline text-sm font-semibold text-primary">
                  {gradedSkills.length} skills graded
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Avg pass rate across {gradedSkills.length} skill
                  {gradedSkills.length !== 1 ? "s" : ""} with 5+ checks
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Insufficient data &mdash; need skills with 5+ checks
              </p>
            )}
          </div>
        </Card>

        {/* ── Row 2: Active Skills (col-span-4) ──────────── */}
        <Card className="col-span-12 @4xl/main:col-span-4 ghost-border p-5 flex flex-col">
          <CardHeader className="p-0 mb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="font-headline text-sm font-semibold text-foreground">
                Active Skills
              </CardTitle>
              <div className="flex items-center gap-1">
                {(["ALL", "HEALTHY", "WARNING", "CRITICAL"] as const).map((s) => (
                  <Button
                    key={s}
                    variant="ghost"
                    size="sm"
                    onClick={() => onStatusFilterChange(s)}
                    className={`px-1.5 py-0.5 h-auto rounded text-[9px] font-headline uppercase tracking-widest transition-colors ${
                      statusFilter === s
                        ? "bg-input text-primary"
                        : "text-muted-foreground hover:text-slate-300"
                    }`}
                  >
                    {s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0 flex-1 divide-y divide-border/20">
            {filteredCards.slice(0, 5).map((card) => (
              <Link
                key={card.name}
                to={`/skills/${encodeURIComponent(card.name)}`}
                className="block hover:bg-muted/30 rounded-md transition-colors -mx-2 px-2"
              >
                <SkillStatusItem card={card} />
              </Link>
            ))}
            {filteredCards.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">
                {search || statusFilter !== "ALL"
                  ? "No skills match current filters"
                  : "No skills tracked yet"}
              </p>
            )}
          </CardContent>

          {filteredCards.length > 5 && (
            <Link
              to="/status"
              className="mt-4 flex items-center justify-center gap-2 text-xs font-medium text-primary hover:text-primary-accent transition-colors"
            >
              View All
              <ArrowRightIcon className="size-3" />
            </Link>
          )}
        </Card>

        {/* ── Row 2: Recent Activity Feed (col-span-8) ───── */}
        <Card className="col-span-12 @4xl/main:col-span-8 ghost-border p-5">
          <CardHeader className="p-0 mb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ZapIcon className="size-4 text-primary" />
                <CardTitle className="font-headline text-sm font-semibold text-foreground">
                  Recent Activity
                </CardTitle>
              </div>
              <div className="flex gap-2">
                {overview.pending_proposals.length > 0 && (
                  <Badge
                    variant="default"
                    className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary"
                  >
                    {overview.pending_proposals.length} PENDING
                  </Badge>
                )}
                {overview.active_sessions > 0 && (
                  <Badge
                    variant="secondary"
                    className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400"
                  >
                    {overview.active_sessions} LIVE
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            <RecentActivityFeed items={overview.recent_activity} embedded />

            {overview.recent_activity.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No recent skill invocations
              </p>
            )}
          </CardContent>
        </Card>

        {/* ── Row 3: Evolution Queue (col-span-8) ────────── */}
        <Card className="col-span-12 @4xl/main:col-span-8 ghost-border p-5">
          <CardHeader className="p-0 mb-4">
            <div className="flex items-center gap-2">
              <LayersIcon className="size-4 text-primary-accent" />
              <CardTitle className="font-headline text-sm font-semibold text-foreground">
                Evolution Queue
              </CardTitle>
              <span className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground ml-auto">
                {overview.evolution.length} events
              </span>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            <ActivityPanel
              evolution={overview.evolution}
              pendingProposals={overview.pending_proposals}
              unmatchedQueries={overview.unmatched_queries}
              onSelectProposal={handleSelectProposal}
              embedded
            />
          </CardContent>
        </Card>

        {/* ── Row 3: Autonomous Synthesis (col-span-4) ───── */}
        <Card className="col-span-12 @4xl/main:col-span-4 ghost-border relative overflow-hidden min-h-[240px] p-0">
          {/* Background gradient overlay */}
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-chart-3/5" />

          <div className="relative z-10 p-5 flex flex-col h-full">
            <div className="flex items-center gap-2 mb-4">
              <BotIcon className="size-4 text-primary-accent" />
              <h3 className="font-headline text-sm font-semibold text-foreground">
                Autonomous Synthesis
              </h3>
            </div>

            {orchestrateQuery.isPending ? (
              <Skeleton className="h-32 rounded-xl" />
            ) : orchestrateQuery.isError ? (
              <div className="rounded-lg bg-red-500/5 p-3 text-xs text-red-400">
                Failed to load orchestrate runs.
              </div>
            ) : orchRuns.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center">
                <p className="text-sm text-muted-foreground">No orchestrate runs yet</p>
                <p className="text-[11px] text-muted-foreground/70 mt-1">
                  Run{" "}
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                    selftune orchestrate
                  </code>{" "}
                  to start
                </p>
              </div>
            ) : (
              <div className="flex-1 flex flex-col justify-between">
                {/* Progress bar */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-headline uppercase tracking-[0.2em] text-muted-foreground">
                      Synthesis Progress
                    </p>
                    <p className="text-xs font-medium text-primary">
                      {Math.round(orchProgress * 100)}%
                    </p>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full cognitive-gradient transition-all duration-500"
                      style={{ width: `${Math.max(2, orchProgress * 100)}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-2">
                    {totalDeployed} deployed &middot; {totalEvolved} evolved across{" "}
                    {orchRuns.length} run{orchRuns.length !== 1 ? "s" : ""}
                  </p>
                </div>

                {/* Latest run info */}
                {latestRun && (
                  <div className="mt-4 bg-muted/50 backdrop-blur-sm rounded-lg p-3">
                    <div className="flex items-center gap-2">
                      <div
                        className={`size-2 rounded-full ${latestRun.deployed > 0 ? "bg-emerald-500" : latestRun.evolved > 0 ? "bg-amber-400" : "bg-muted-foreground/40"}`}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Latest: {latestRun.deployed} deployed, {latestRun.evolved} evolved,{" "}
                        {latestRun.watched} watched
                      </p>
                    </div>
                    <p className="text-[10px] text-muted-foreground/60 mt-1">
                      {(latestRun.elapsed_ms / 1000).toFixed(1)}s elapsed
                      {latestRun.dry_run ? " (dry-run)" : ""}
                    </p>
                  </div>
                )}

                {/* Full runs panel (collapsed) */}
                <details className="mt-3 group">
                  <summary className="text-[11px] text-primary cursor-pointer hover:text-primary-accent transition-colors">
                    Show all runs
                  </summary>
                  <div className="mt-2 max-h-48 overflow-y-auto">
                    <OrchestrateRunsPanel runs={orchRuns} embedded />
                  </div>
                </details>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
