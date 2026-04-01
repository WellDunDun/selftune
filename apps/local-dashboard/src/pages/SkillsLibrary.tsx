import { deriveStatus, formatRate, sortByPassRateAndChecks } from "@selftune/ui/lib";
import {
  Badge,
  Button,
  Card,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@selftune/ui/primitives";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  ArrowUpDownIcon,
  BrainCircuitIcon,
  CircleDotIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Skeleton } from "@/components/ui/skeleton";
import type {
  EvolutionEntry,
  OverviewResponse,
  PendingProposal,
  SkillHealthStatus,
  SkillSummary,
} from "@/types";

/* ── Types ─────────────────────────────────────────────────── */

type FilterTab = "ALL" | "HEALTHY" | "WARNING" | "CRITICAL" | "UNGRADED";

interface DerivedSkill {
  name: string;
  scope: string | null;
  passRate: number | null;
  checks: number;
  status: SkillHealthStatus;
  uniqueSessions: number;
  triggeredCount: number;
  lastSeen: string | null;
}

/* ── Constants ─────────────────────────────────────────────── */

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: "ALL", label: "All Skills" },
  { key: "HEALTHY", label: "Healthy" },
  { key: "WARNING", label: "Warning" },
  { key: "CRITICAL", label: "Critical" },
  { key: "UNGRADED", label: "Ungraded" },
];

const STATUS_STYLE: Record<SkillHealthStatus, { text: string; bg: string; label: string }> = {
  HEALTHY: { text: "text-primary", bg: "bg-primary", label: "Deployed" },
  WARNING: { text: "text-primary-accent", bg: "bg-primary-accent", label: "Needs Attention" },
  CRITICAL: { text: "text-destructive", bg: "bg-destructive", label: "Critical" },
  UNGRADED: { text: "text-muted-foreground", bg: "bg-muted-foreground", label: "Ungraded" },
  UNKNOWN: { text: "text-muted-foreground", bg: "bg-muted-foreground", label: "Unknown" },
};

function getPassRatePercent(passRate: number | null): number {
  return passRate !== null ? Math.round(passRate * 100) : 0;
}

/* ── Helpers ───────────────────────────────────────────────── */

function deriveSkills(skills: SkillSummary[]): DerivedSkill[] {
  return sortByPassRateAndChecks(
    skills.map((s) => ({
      name: s.skill_name,
      scope: s.skill_scope,
      passRate: s.total_checks > 0 ? s.pass_rate : null,
      checks: s.total_checks,
      status: deriveStatus(s.pass_rate, s.total_checks),
      uniqueSessions: s.unique_sessions,
      triggeredCount: s.triggered_count,
      lastSeen: s.last_seen,
    })),
  );
}

function aggregatePassRate(skills: SkillSummary[]): number | null {
  const graded = skills.filter((s) => s.total_checks >= 5);
  if (graded.length === 0) return null;
  const totalChecks = graded.reduce((sum, s) => sum + s.total_checks, 0);
  const totalPasses = graded.reduce((sum, s) => sum + Math.round(s.pass_rate * s.total_checks), 0);
  return totalChecks > 0 ? totalPasses / totalChecks : null;
}

function findMostActiveSkill(
  skills: SkillSummary[],
  evolution: EvolutionEntry[],
): { skill: SkillSummary; latestEvolution: EvolutionEntry } | null {
  // Find the most recently evolved skill
  const sorted = [...evolution]
    .filter((e) => e.skill_name)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  for (const evo of sorted) {
    const skill = skills.find((s) => s.skill_name === evo.skill_name);
    if (skill) return { skill, latestEvolution: evo };
  }

  // Fallback: skill with most checks
  if (skills.length > 0) {
    const top = [...skills].sort((a, b) => b.total_checks - a.total_checks)[0];
    return { skill: top, latestEvolution: sorted[0] ?? (null as unknown as EvolutionEntry) };
  }
  return null;
}

function timeAgo(ts: string | null): string {
  if (!ts) return "never";
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/* ── Loading skeleton ──────────────────────────────────────── */

function SkillsLibrarySkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-8 p-6 md:p-10 animate-in fade-in duration-500">
      <div className="space-y-2">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-5 w-96" />
      </div>
      <div className="grid grid-cols-12 gap-6">
        <Skeleton className="col-span-8 h-72 rounded-xl" />
        <div className="col-span-4 flex flex-col gap-6">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={`skel-${i}`} className="h-52 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/* ── Hero Card ─────────────────────────────────────────────── */

function HeroCard({
  skill,
  latestEvolution,
}: {
  skill: SkillSummary;
  latestEvolution: EvolutionEntry | null;
}) {
  const status = deriveStatus(skill.pass_rate, skill.total_checks);
  const passRatePct = getPassRatePercent(skill.total_checks > 0 ? skill.pass_rate : null);

  return (
    <Card className="col-span-12 lg:col-span-8 rounded-3xl border border-border/15 p-8 relative overflow-hidden flex flex-col">
      {/* Top progress bar — absolute positioned like Stitch */}
      <div className="absolute top-0 left-0 w-full h-1 bg-input">
        <div
          className="h-full bg-primary shadow-[0_0_15px_rgba(79,242,255,0.6)] transition-all duration-700"
          style={{ width: `${passRatePct}%` }}
        />
      </div>

      {/* Header row */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary uppercase tracking-widest">
              {status === "HEALTHY" ? "Deployed" : "Evolving"}
            </span>
            <span className="text-muted-foreground font-mono text-xs">
              {skill.skill_scope ?? "global"} scope
            </span>
          </div>
          <h2 className="font-headline text-3xl font-bold text-foreground">{skill.skill_name}</h2>
        </div>
        <div className="text-right">
          <span className="text-4xl font-headline font-light text-primary">
            {formatRate(skill.total_checks > 0 ? skill.pass_rate : null)}
          </span>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
            {latestEvolution ? `Evolved ${timeAgo(latestEvolution.timestamp)}` : "Pass Rate"}
          </p>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-8 mb-8">
        <div className="bg-muted p-4 rounded-2xl border border-border/15">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">
            Total Checks
          </p>
          <p className="text-xl font-bold font-headline tabular-nums">
            {skill.total_checks.toLocaleString()}
          </p>
        </div>
        <div className="bg-muted p-4 rounded-2xl border border-border/15">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">
            Pass Rate
          </p>
          <p
            className={`text-xl font-bold font-headline tabular-nums ${STATUS_STYLE[status].text}`}
          >
            {formatRate(skill.total_checks > 0 ? skill.pass_rate : null)}
          </p>
        </div>
        <div className="bg-muted p-4 rounded-2xl border border-border/15">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">
            Unique Sessions
          </p>
          <p className="text-xl font-bold font-headline tabular-nums">
            {skill.unique_sessions.toLocaleString()}
          </p>
        </div>
      </div>

      {/* Action buttons — right-aligned like Stitch */}
      <div className="flex justify-end gap-4">
        <Link
          to={`/skills/${encodeURIComponent(skill.skill_name)}`}
          className="px-6 py-2 rounded-xl text-muted-foreground font-bold hover:bg-input transition-colors"
        >
          Configure
        </Link>
        <Link
          to={`/skills/${encodeURIComponent(skill.skill_name)}`}
          className="px-8 py-2 bg-primary text-primary-foreground font-bold rounded-xl shadow-[0_4px_20px_rgba(79,242,255,0.2)] hover:shadow-[0_4px_25px_rgba(79,242,255,0.4)] transition-all"
        >
          View Report
        </Link>
      </div>
    </Card>
  );
}

/* ── Stats Sidebar ─────────────────────────────────────────── */

function LibraryHealthCard({ skills }: { skills: SkillSummary[] }) {
  const aggRate = aggregatePassRate(skills);
  const gradedCount = skills.filter((s) => s.total_checks >= 5).length;

  return (
    <Card className="rounded-3xl border border-border/15 p-6 flex flex-col justify-center">
      <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-4">
        Library Health
      </p>
      <div className="flex items-end gap-2 mb-2">
        <span className="text-5xl font-headline font-bold tabular-nums">
          {aggRate !== null ? `${Math.round(aggRate * 100)}%` : "--"}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Aggregate pass rate across {gradedCount} graded skill{gradedCount !== 1 ? "s" : ""}.
      </p>
    </Card>
  );
}

function PendingProposalsCard({ proposals }: { proposals: PendingProposal[] }) {
  if (proposals.length === 0) {
    return (
      <Card className="rounded-3xl p-6 flex flex-col gap-3 border border-border/15 border-l-4 border-l-primary/40">
        <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">
          Pending Proposals
        </p>
        <h3 className="font-headline font-bold text-lg">No proposals pending</h3>
      </Card>
    );
  }

  return (
    <Card className="rounded-3xl p-6 flex flex-col gap-3 border border-border/15 border-l-4 border-l-primary/40">
      <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">
        Pending Proposals
      </p>
      <h3 className="font-headline font-bold text-lg mb-4">
        Awaiting Review
        <Badge
          variant="secondary"
          className="ml-2 h-5 px-2 text-[10px] bg-primary/15 text-primary border-none align-middle"
        >
          {proposals.length}
        </Badge>
      </h3>
      <div className="space-y-3 max-h-32 overflow-y-auto themed-scroll">
        {proposals.map((p) => (
          <div
            key={p.proposal_id}
            className="flex items-center justify-between p-3 bg-muted rounded-xl"
          >
            <span className="text-sm truncate">{p.skill_name ?? "Unknown"}</span>
            <span className="text-xs text-muted-foreground shrink-0">{p.action}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ── Skill Card ────────────────────────────────────────────── */

function SkillCard({ skill }: { skill: DerivedSkill }) {
  const passRatePct = getPassRatePercent(skill.passRate);
  const style = STATUS_STYLE[skill.status];

  return (
    <Card className="border border-border/15 p-6 hover:border-border/30 transition-all duration-300 flex flex-col">
      {/* Top row: status dot in box (left) + metric (right) */}
      <div className="flex justify-between items-start mb-4">
        <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center">
          <span className={`size-3 rounded-full ${style.bg}`} />
        </div>
        <div className="text-right">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
            {skill.scope ?? "unknown"}
          </p>
          <p className="text-sm font-bold tabular-nums">{skill.checks.toLocaleString()}</p>
        </div>
      </div>

      {/* Title + description */}
      <h3 className="font-headline font-bold text-xl tracking-tight text-foreground truncate mb-1">
        {skill.name}
      </h3>
      <p className="text-sm text-muted-foreground mb-6">
        {skill.uniqueSessions} sessions · Last seen {timeAgo(skill.lastSeen)}
      </p>

      {/* Progress section — "Pass Rate" label + status + bar */}
      <div className="space-y-4">
        <div className="flex justify-between items-end text-xs uppercase tracking-tighter">
          <span className="text-muted-foreground">Pass Rate</span>
          <span className={`font-bold ${style.text}`}>{style.label}</span>
        </div>
        <div className="w-full h-1 bg-input rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${style.bg}`}
            style={{ width: `${passRatePct}%` }}
          />
        </div>

        {/* Buttons */}
        <div className="pt-4 flex gap-3">
          <Link
            to={`/skills/${encodeURIComponent(skill.name)}`}
            className="flex-1 py-2 text-xs font-bold text-muted-foreground bg-muted rounded-lg text-center hover:bg-input transition-colors"
          >
            Configure
          </Link>
          <Link
            to={`/skills/${encodeURIComponent(skill.name)}`}
            className="flex-1 py-2 text-xs font-bold text-muted-foreground bg-secondary rounded-lg text-center hover:bg-input hover:text-foreground transition-all"
          >
            View Report
          </Link>
        </div>
      </div>
    </Card>
  );
}

/* ── Main Component ────────────────────────────────────────── */

export function SkillsLibrary({
  overviewQuery,
}: {
  overviewQuery: UseQueryResult<OverviewResponse>;
}) {
  const { data, isLoading, isError, error, refetch } = overviewQuery;
  const [filter, setFilter] = useState<FilterTab>("ALL");
  const [sortDesc, setSortDesc] = useState(true);

  const allSkills = useMemo(() => (data ? deriveSkills(data.skills) : []), [data]);

  const filteredSkills = useMemo(() => {
    let result = allSkills;
    if (filter !== "ALL") {
      result = result.filter((s) => s.status === filter);
    }
    if (!sortDesc) {
      return result.reduceRight<DerivedSkill[]>((acc, skill) => {
        acc.push(skill);
        return acc;
      }, []);
    }
    return result;
  }, [allSkills, filter, sortDesc]);

  const heroData = useMemo(() => {
    if (!data) return null;
    return findMostActiveSkill(data.skills, data.overview.evolution);
  }, [data]);

  if (isLoading) {
    return <SkillsLibrarySkeleton />;
  }

  if (isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
        <AlertCircleIcon className="size-10 text-destructive" />
        <p className="text-sm font-medium text-destructive">
          {error instanceof Error ? error.message : "Failed to load skills library."}
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCwIcon className="mr-2 size-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (!data) {
    return <SkillsLibrarySkeleton />;
  }

  const pendingProposals = data.overview.pending_proposals;

  return (
    <div className="@container/main flex flex-1 flex-col gap-8 py-8 px-4 lg:px-6 animate-in fade-in duration-500">
      {/* Header */}
      <div>
        <h1 className="font-headline text-4xl font-bold tracking-tight text-foreground">
          Skills Library
        </h1>
        <p className="mt-2 text-sm text-muted-foreground max-w-2xl">
          Monitor and manage your evolving skill definitions across all scopes.
        </p>
      </div>

      {/* Bento Grid: Hero + Stats */}
      <div className="grid grid-cols-12 gap-6">
        {heroData ? (
          <HeroCard skill={heroData.skill} latestEvolution={heroData.latestEvolution} />
        ) : (
          <Card className="col-span-12 lg:col-span-8 border border-border/15 p-8 flex items-center justify-center">
            <div className="text-center space-y-2">
              <BrainCircuitIcon className="size-10 text-muted-foreground mx-auto" />
              <p className="text-muted-foreground">
                No evolution activity yet. Run an evolution cycle to see your most active skill.
              </p>
            </div>
          </Card>
        )}

        <div className="col-span-12 lg:col-span-4 flex flex-col gap-6">
          <LibraryHealthCard skills={data.skills} />
          <PendingProposalsCard proposals={pendingProposals} />
        </div>
      </div>

      {/* Skills Grid Section */}
      <div className="space-y-6">
        {/* Filter tabs + sort */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex gap-1 bg-muted rounded-xl p-1">
            {FILTER_TABS.map((tab) => {
              const count =
                tab.key === "ALL"
                  ? allSkills.length
                  : allSkills.filter((s) => s.status === tab.key).length;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setFilter(tab.key)}
                  className={`px-4 py-2 rounded-lg text-sm font-headline font-semibold transition-all duration-200 ${
                    filter === tab.key
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tab.label}
                  <span className="ml-1.5 text-xs opacity-60">{count}</span>
                </button>
              );
            })}
          </div>

          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => setSortDesc((p) => !p)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors font-headline"
                />
              }
            >
              <ArrowUpDownIcon className="size-4" />
              <span>Sort by Performance</span>
            </TooltipTrigger>
            <TooltipContent>
              {sortDesc ? "Highest pass rate first" : "Lowest pass rate first"}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Grid of skill cards */}
        {filteredSkills.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {filteredSkills.map((skill: DerivedSkill) => (
              <SkillCard key={skill.name} skill={skill} />
            ))}
          </div>
        ) : (
          <Card className="border border-border/15 p-12 text-center">
            <CircleDotIcon className="size-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground font-headline">
              No skills match the current filter
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
