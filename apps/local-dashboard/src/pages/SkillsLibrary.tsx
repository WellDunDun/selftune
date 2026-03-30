import { deriveStatus, formatRate, sortByPassRateAndChecks } from "@selftune/ui/lib";
import { Badge, Tooltip, TooltipContent, TooltipTrigger } from "@selftune/ui/primitives";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowUpDownIcon,
  BrainCircuitIcon,
  CheckCircleIcon,
  CircleDotIcon,
  EyeIcon,
  FolderIcon,
  GlobeIcon,
  HelpCircleIcon,
  LayersIcon,
  ServerIcon,
  SparklesIcon,
  XCircleIcon,
  ZapIcon,
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

const STATUS_COLOR: Record<SkillHealthStatus, string> = {
  HEALTHY: "text-emerald-400",
  WARNING: "text-amber-400",
  CRITICAL: "text-red-400",
  UNGRADED: "text-slate-500",
  UNKNOWN: "text-slate-600",
};

const STATUS_BG: Record<SkillHealthStatus, string> = {
  HEALTHY: "bg-emerald-400",
  WARNING: "bg-amber-400",
  CRITICAL: "bg-red-400",
  UNGRADED: "bg-slate-500",
  UNKNOWN: "bg-slate-600",
};

const STATUS_ICON: Record<SkillHealthStatus, React.ReactNode> = {
  HEALTHY: <CheckCircleIcon className="size-4 text-emerald-400" />,
  WARNING: <AlertTriangleIcon className="size-4 text-amber-400" />,
  CRITICAL: <XCircleIcon className="size-4 text-red-400" />,
  UNGRADED: <CircleDotIcon className="size-4 text-slate-500" />,
  UNKNOWN: <HelpCircleIcon className="size-4 text-slate-600" />,
};

const SCOPE_ICON: Record<string, React.ReactNode> = {
  project: <FolderIcon className="size-4 text-muted-foreground" />,
  global: <GlobeIcon className="size-4 text-muted-foreground" />,
  system: <ServerIcon className="size-4 text-muted-foreground" />,
};

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
        <Skeleton className="col-span-8 h-72 rounded-3xl" />
        <div className="col-span-4 flex flex-col gap-6">
          <Skeleton className="h-32 rounded-3xl" />
          <Skeleton className="h-32 rounded-3xl" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={`skel-${i}`} className="h-52 rounded-2xl" />
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
  const passRatePct = skill.total_checks > 0 ? Math.round(skill.pass_rate * 100) : 0;

  return (
    <div className="col-span-12 lg:col-span-8 bg-secondary rounded-3xl p-8 flex flex-col gap-6">
      {/* Progress bar */}
      <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-700"
          style={{ width: `${passRatePct}%` }}
        />
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-3">
            <BrainCircuitIcon className="size-6 text-primary" />
            <h2 className="font-headline font-bold text-2xl tracking-tight text-foreground">
              {skill.skill_name}
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Most actively evolving skill
            {latestEvolution ? ` \u2014 last evolved ${timeAgo(latestEvolution.timestamp)}` : ""}
          </p>
        </div>
        {latestEvolution && (
          <Badge className="bg-primary/15 text-primary border-primary/30 font-headline text-xs">
            <SparklesIcon className="size-3 mr-1" />
            Recently Evolved
          </Badge>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-6">
        <div className="bg-card rounded-2xl p-4 text-center">
          <p className="text-xs text-muted-foreground font-headline uppercase tracking-wider mb-1">
            Total Checks
          </p>
          <p className="text-3xl font-bold font-headline tabular-nums text-foreground">
            {skill.total_checks.toLocaleString()}
          </p>
        </div>
        <div className="bg-card rounded-2xl p-4 text-center">
          <p className="text-xs text-muted-foreground font-headline uppercase tracking-wider mb-1">
            Pass Rate
          </p>
          <p className={`text-3xl font-bold font-headline tabular-nums ${STATUS_COLOR[status]}`}>
            {formatRate(skill.total_checks > 0 ? skill.pass_rate : null)}
          </p>
        </div>
        <div className="bg-card rounded-2xl p-4 text-center">
          <p className="text-xs text-muted-foreground font-headline uppercase tracking-wider mb-1">
            Unique Sessions
          </p>
          <p className="text-3xl font-bold font-headline tabular-nums text-foreground">
            {skill.unique_sessions.toLocaleString()}
          </p>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-3">
        <Link
          to={`/skills-v2/${encodeURIComponent(skill.skill_name)}`}
          className="cognitive-gradient text-primary-foreground font-bold py-2.5 px-6 rounded-xl flex items-center gap-2 font-headline text-sm uppercase tracking-wider transition-transform active:scale-95"
        >
          <EyeIcon className="size-4" />
          View Report
        </Link>
        <Link
          to={`/skills/${encodeURIComponent(skill.skill_name)}`}
          className="bg-card text-foreground font-bold py-2.5 px-6 rounded-xl flex items-center gap-2 font-headline text-sm uppercase tracking-wider hover:bg-input transition-all"
        >
          <ActivityIcon className="size-4" />
          Configure
        </Link>
      </div>
    </div>
  );
}

/* ── Stats Sidebar ─────────────────────────────────────────── */

function LibraryHealthCard({ skills }: { skills: SkillSummary[] }) {
  const aggRate = aggregatePassRate(skills);
  const gradedCount = skills.filter((s) => s.total_checks >= 5).length;

  return (
    <div className="bg-card rounded-3xl p-6 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <LayersIcon className="size-5 text-primary" />
        <h3 className="font-headline font-bold text-sm tracking-tight text-foreground">
          Library Health
        </h3>
      </div>
      <p className="text-5xl font-bold font-headline tabular-nums text-primary text-glow">
        {aggRate !== null ? `${Math.round(aggRate * 100)}%` : "--"}
      </p>
      <p className="text-xs text-muted-foreground">
        Aggregate pass rate across {gradedCount} graded skill{gradedCount !== 1 ? "s" : ""}
      </p>
    </div>
  );
}

function PendingProposalsCard({ proposals }: { proposals: PendingProposal[] }) {
  if (proposals.length === 0) {
    return (
      <div className="bg-card rounded-3xl p-6 border-l-4 border-primary/40 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <ZapIcon className="size-5 text-primary" />
          <h3 className="font-headline font-bold text-sm tracking-tight text-foreground">
            Pending Proposals
          </h3>
        </div>
        <p className="text-sm text-muted-foreground">No pending proposals</p>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-3xl p-6 border-l-4 border-primary/40 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <ZapIcon className="size-5 text-primary" />
        <h3 className="font-headline font-bold text-sm tracking-tight text-foreground">
          Pending Proposals
        </h3>
        <Badge
          variant="secondary"
          className="ml-auto h-5 px-2 text-[10px] bg-primary/15 text-primary border-none"
        >
          {proposals.length}
        </Badge>
      </div>
      <div className="space-y-2 max-h-32 overflow-y-auto">
        {proposals.map((p) => (
          <div key={p.proposal_id} className="flex items-center gap-2 text-xs">
            <SparklesIcon className="size-3 text-primary shrink-0" />
            <span className="truncate text-foreground">{p.skill_name ?? "Unknown"}</span>
            <span className="text-muted-foreground ml-auto shrink-0">{p.action}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Skill Card ────────────────────────────────────────────── */

function SkillCard({ skill }: { skill: DerivedSkill }) {
  const passRatePct = skill.passRate !== null ? Math.round(skill.passRate * 100) : 0;
  const scopeIcon = SCOPE_ICON[skill.scope ?? ""] ?? (
    <HelpCircleIcon className="size-4 text-muted-foreground" />
  );

  return (
    <div className="bg-secondary rounded-2xl p-6 border border-border/5 hover:border-border/30 transition-all duration-300 flex flex-col gap-4">
      {/* Top row: icon + scope badge + check count */}
      <div className="flex items-center gap-2">
        {scopeIcon}
        <Badge
          variant="secondary"
          className="h-5 px-2 text-[10px] bg-muted text-muted-foreground border-none font-headline"
        >
          {skill.scope ?? "unknown"}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {skill.checks.toLocaleString()} checks
        </span>
      </div>

      {/* Skill name */}
      <h3 className="font-headline font-bold text-xl tracking-tight text-foreground truncate">
        {skill.name}
      </h3>

      {/* Status + pass rate bar */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          {STATUS_ICON[skill.status]}
          <span className={`text-xs font-headline font-semibold ${STATUS_COLOR[skill.status]}`}>
            {skill.status}
          </span>
          <span className="ml-auto text-sm font-bold tabular-nums text-foreground">
            {formatRate(skill.passRate)}
          </span>
        </div>
        <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${STATUS_BG[skill.status]}`}
            style={{ width: `${passRatePct}%` }}
          />
        </div>
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>{skill.uniqueSessions} sessions</span>
        {skill.lastSeen && <span>{timeAgo(skill.lastSeen)}</span>}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 mt-auto">
        <Link
          to={`/skills-v2/${encodeURIComponent(skill.name)}`}
          className="flex-1 bg-card text-foreground text-center font-semibold py-2 px-3 rounded-lg text-xs font-headline hover:bg-input transition-all"
        >
          View Report
        </Link>
        <Link
          to={`/skills/${encodeURIComponent(skill.name)}`}
          className="bg-muted text-muted-foreground text-center font-semibold py-2 px-3 rounded-lg text-xs font-headline hover:bg-card hover:text-foreground transition-all"
        >
          Configure
        </Link>
      </div>
    </div>
  );
}

/* ── Main Component ────────────────────────────────────────── */

export function SkillsLibrary({
  overviewQuery,
}: {
  overviewQuery: UseQueryResult<OverviewResponse>;
}) {
  const { data, isLoading } = overviewQuery;
  const [filter, setFilter] = useState<FilterTab>("ALL");
  const [sortDesc, setSortDesc] = useState(true);

  const allSkills = useMemo(() => (data ? deriveSkills(data.skills) : []), [data]);

  const filteredSkills = useMemo(() => {
    let result = allSkills;
    if (filter !== "ALL") {
      result = result.filter((s) => s.status === filter);
    }
    if (!sortDesc) {
      return result.toReversed();
    }
    return result;
  }, [allSkills, filter, sortDesc]);

  const heroData = useMemo(() => {
    if (!data) return null;
    return findMostActiveSkill(data.skills, data.overview.evolution);
  }, [data]);

  if (isLoading || !data) {
    return <SkillsLibrarySkeleton />;
  }

  const pendingProposals = data.overview.pending_proposals;

  return (
    <div className="flex flex-1 flex-col gap-8 p-6 md:p-10 animate-in fade-in duration-500">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-5xl font-bold font-headline tracking-tight text-glow">
          Skills Library
        </h1>
        <p className="text-muted-foreground text-lg">
          Monitor and manage your evolving skill definitions across all scopes
        </p>
      </div>

      {/* Bento Grid: Hero + Stats */}
      <div className="grid grid-cols-12 gap-6">
        {heroData ? (
          <HeroCard skill={heroData.skill} latestEvolution={heroData.latestEvolution} />
        ) : (
          <div className="col-span-12 lg:col-span-8 bg-secondary rounded-3xl p-8 flex items-center justify-center">
            <div className="text-center space-y-2">
              <BrainCircuitIcon className="size-10 text-muted-foreground mx-auto" />
              <p className="text-muted-foreground">
                No evolution activity yet. Run an evolution cycle to see your most active skill.
              </p>
            </div>
          </div>
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
            {filteredSkills.map((skill) => (
              <SkillCard key={skill.name} skill={skill} />
            ))}
          </div>
        ) : (
          <div className="bg-secondary rounded-2xl p-12 text-center">
            <CircleDotIcon className="size-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground font-headline">
              No skills match the current filter
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
