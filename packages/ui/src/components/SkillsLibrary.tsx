import { Badge } from "../primitives/badge";
import { Card } from "../primitives/card";
import { deriveStatus, formatRate, sortByPassRateAndChecks, timeAgo } from "../lib/format";
import type { SkillHealthStatus } from "../types";
import {
  AlertCircleIcon,
  ArrowUpDownIcon,
  BrainCircuitIcon,
  CircleDotIcon,
  RefreshCwIcon,
} from "lucide-react";
import { type ReactNode } from "react";

/* ── Types ─────────────────────────────────────────────────── */

export type FilterTab = "ALL" | "HEALTHY" | "WARNING" | "CRITICAL" | "UNGRADED";

export interface DerivedSkill {
  name: string;
  scope: string | null;
  passRate: number | null;
  checks: number;
  status: SkillHealthStatus;
  uniqueSessions: number;
  triggeredCount: number;
  lastSeen: string | null;
}

export interface SkillHeroCardProps {
  skillName: string;
  skillScope: string | null;
  passRate: number | null;
  totalChecks: number;
  uniqueSessions: number;
  status: SkillHealthStatus;
  latestEvolutionTimestamp: string | null;
  /** Render prop for action buttons (link component varies by framework) */
  renderActions?: (skillName: string) => ReactNode;
}

export interface LibraryHealthCardProps {
  aggregatePassRate: number | null;
  gradedCount: number;
}

export interface PendingProposalsCardProps {
  proposals: Array<{
    id: string;
    skillName: string | null;
    action: string;
  }>;
}

export interface SkillCardProps {
  skill: DerivedSkill;
  /** Render prop for action buttons (link component varies by framework) */
  renderActions?: (skillName: string) => ReactNode;
}

export interface SkillFilterTabsProps {
  filter: FilterTab;
  onFilterChange: (tab: FilterTab) => void;
  counts: Record<FilterTab, number>;
  sortDesc: boolean;
  onSortToggle: () => void;
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

/* ── Loading Skeleton ──────────────────────────────────────── */

export function SkillsLibrarySkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-8 p-6 md:p-10 animate-in fade-in duration-500">
      <div className="space-y-2">
        <div className="h-12 w-64 rounded-lg bg-muted animate-pulse" />
        <div className="h-5 w-96 rounded-lg bg-muted animate-pulse" />
      </div>
      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-12 lg:col-span-8 h-72 rounded-xl bg-muted animate-pulse" />
        <div className="col-span-12 lg:col-span-4 flex flex-col gap-6">
          <div className="h-32 rounded-xl bg-muted animate-pulse" />
          <div className="h-32 rounded-xl bg-muted animate-pulse" />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={`skel-${i}`} className="h-52 rounded-xl bg-muted animate-pulse" />
        ))}
      </div>
    </div>
  );
}

/* ── Hero Card ─────────────────────────────────────────────── */

export function SkillHeroCard({
  skillName,
  skillScope,
  passRate,
  totalChecks,
  uniqueSessions,
  status,
  latestEvolutionTimestamp,
  renderActions,
}: SkillHeroCardProps) {
  const passRatePct = getPassRatePercent(totalChecks > 0 ? passRate : null);
  const style = STATUS_STYLE[status];

  return (
    <Card className="col-span-12 lg:col-span-8 rounded-3xl border border-border/15 p-8 relative overflow-hidden flex flex-col">
      {/* Top progress bar */}
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
              {skillScope ?? "global"} scope
            </span>
          </div>
          <h2 className="font-headline text-3xl font-bold text-foreground">{skillName}</h2>
        </div>
        <div className="text-right">
          <span className="text-4xl font-headline font-light text-primary">
            {formatRate(totalChecks > 0 ? passRate : null)}
          </span>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
            {latestEvolutionTimestamp
              ? `Evolved ${timeAgo(latestEvolutionTimestamp)}`
              : "Pass Rate"}
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
            {totalChecks.toLocaleString()}
          </p>
        </div>
        <div className="bg-muted p-4 rounded-2xl border border-border/15">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">
            Pass Rate
          </p>
          <p className={`text-xl font-bold font-headline tabular-nums ${style.text}`}>
            {formatRate(totalChecks > 0 ? passRate : null)}
          </p>
        </div>
        <div className="bg-muted p-4 rounded-2xl border border-border/15">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">
            Unique Sessions
          </p>
          <p className="text-xl font-bold font-headline tabular-nums">
            {uniqueSessions.toLocaleString()}
          </p>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex justify-end gap-4">{renderActions?.(skillName)}</div>
    </Card>
  );
}

/* ── Library Health Card ───────────────────────────────────── */

export function LibraryHealthCard({ aggregatePassRate, gradedCount }: LibraryHealthCardProps) {
  return (
    <Card className="rounded-3xl border border-border/15 p-6 flex flex-col justify-center">
      <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-4">
        Library Health
      </p>
      <div className="flex items-end gap-2 mb-2">
        <span className="text-5xl font-headline font-bold tabular-nums">
          {aggregatePassRate !== null ? `${Math.round(aggregatePassRate * 100)}%` : "--"}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Aggregate pass rate across {gradedCount} graded skill{gradedCount !== 1 ? "s" : ""}.
      </p>
    </Card>
  );
}

/* ── Pending Proposals Card ────────────────────────────────── */

export function PendingProposalsCard({ proposals }: PendingProposalsCardProps) {
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
          <div key={p.id} className="flex items-center justify-between p-3 bg-muted rounded-xl">
            <span className="text-sm truncate">{p.skillName ?? "Unknown"}</span>
            <span className="text-xs text-muted-foreground shrink-0">{p.action}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ── Skill Card ────────────────────────────────────────────── */

export function SkillCardItem({ skill, renderActions }: SkillCardProps) {
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
        {skill.uniqueSessions} sessions · Last seen{" "}
        {skill.lastSeen ? timeAgo(skill.lastSeen) : "never"}
      </p>

      {/* Progress section */}
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
        <div className="pt-4 flex gap-3">{renderActions?.(skill.name)}</div>
      </div>
    </Card>
  );
}

/* ── Filter Tabs ───────────────────────────────────────────── */

export function SkillFilterTabs({
  filter,
  onFilterChange,
  counts,
  sortDesc,
  onSortToggle,
}: SkillFilterTabsProps) {
  return (
    <div className="flex items-center justify-between gap-4 flex-wrap">
      <div className="flex gap-1 bg-muted rounded-xl p-1">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => onFilterChange(tab.key)}
            className={`px-4 py-2 rounded-lg text-sm font-headline font-semibold transition-all duration-200 ${
              filter === tab.key
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            <span className="ml-1.5 text-xs opacity-60">{counts[tab.key]}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onSortToggle}
        className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors font-headline"
        title={sortDesc ? "Highest pass rate first" : "Lowest pass rate first"}
      >
        <ArrowUpDownIcon className="size-4" />
        <span>Sort by Performance</span>
      </button>
    </div>
  );
}

/* ── Empty Hero Placeholder ────────────────────────────────── */

export function SkillHeroEmpty() {
  return (
    <Card className="col-span-12 lg:col-span-8 border border-border/15 p-8 flex items-center justify-center">
      <div className="text-center space-y-2">
        <BrainCircuitIcon className="size-10 text-muted-foreground mx-auto" />
        <p className="text-muted-foreground">
          No evolution activity yet. Run an evolution cycle to see your most active skill.
        </p>
      </div>
    </Card>
  );
}

/* ── Empty Grid Placeholder ────────────────────────────────── */

export function SkillGridEmpty() {
  return (
    <Card className="border border-border/15 p-12 text-center">
      <CircleDotIcon className="size-8 text-muted-foreground mx-auto mb-3" />
      <p className="text-muted-foreground font-headline">No skills match the current filter</p>
    </Card>
  );
}

/* ── Error State ───────────────────────────────────────────── */

export function SkillsLibraryError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
      <AlertCircleIcon className="size-10 text-destructive" />
      <p className="text-sm font-medium text-destructive">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
        >
          <RefreshCwIcon className="size-3.5" />
          Retry
        </button>
      )}
    </div>
  );
}

/* ── Utility re-exports for consumers ──────────────────────── */

export { deriveStatus, formatRate, sortByPassRateAndChecks, timeAgo };
export { STATUS_STYLE, FILTER_TABS, getPassRatePercent };
export type { SkillHealthStatus };
