import {
  LibraryHealthCard,
  PendingProposalsCard,
  SkillCardItem,
  SkillFilterTabs,
  SkillGridEmpty,
  SkillHeroCard,
  SkillHeroEmpty,
  SkillsLibraryError,
  SkillsLibrarySkeleton,
} from "@selftune/ui/components";
import type { DerivedSkill, FilterTab } from "@selftune/ui/components";
import { deriveStatus, sortByPassRateAndChecks } from "@selftune/ui/lib";
import type { UseQueryResult } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import type { EvolutionEntry, OverviewResponse, SkillSummary } from "@/types";

/* ── Helpers ───────────────────────────────────────────────── */

function deriveSkills(skills: SkillSummary[]): DerivedSkill[] {
  return sortByPassRateAndChecks(
    skills.map((s) => ({
      name: s.skill_name,
      scope: s.skill_scope,
      platforms: [],
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
): { skill: SkillSummary; latestEvolution: EvolutionEntry | null } | null {
  const sorted = [...evolution]
    .filter((e) => e.skill_name)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  for (const evo of sorted) {
    const skill = skills.find((s) => s.skill_name === evo.skill_name);
    if (skill) return { skill, latestEvolution: evo };
  }

  if (skills.length > 0) {
    const top = [...skills].sort((a, b) => b.total_checks - a.total_checks)[0];
    return { skill: top, latestEvolution: sorted[0] ?? null };
  }
  return null;
}

/* ── Render-prop helpers for React Router links ────────────── */

function renderHeroActions(skillName: string) {
  const encoded = encodeURIComponent(skillName);
  return (
    <>
      <Link
        to={`/skills/${encoded}`}
        className="px-6 py-2 rounded-xl text-muted-foreground font-bold hover:bg-input transition-colors"
      >
        Configure
      </Link>
      <Link
        to={`/skills/${encoded}`}
        className="px-8 py-2 bg-primary text-primary-foreground font-bold rounded-xl shadow-[0_4px_20px_rgba(79,242,255,0.2)] hover:shadow-[0_4px_25px_rgba(79,242,255,0.4)] transition-all"
      >
        View Report
      </Link>
    </>
  );
}

function renderCardActions(skillName: string) {
  const encoded = encodeURIComponent(skillName);
  return (
    <>
      <Link
        to={`/skills/${encoded}`}
        className="flex-1 py-2 text-xs font-bold text-muted-foreground bg-muted rounded-lg text-center hover:bg-input transition-colors"
      >
        Configure
      </Link>
      <Link
        to={`/skills/${encoded}`}
        className="flex-1 py-2 text-xs font-bold text-muted-foreground bg-secondary rounded-lg text-center hover:bg-input hover:text-foreground transition-all"
      >
        View Report
      </Link>
    </>
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
      return result;
    }
    return result.reduceRight<DerivedSkill[]>((acc, skill) => {
      acc.push(skill);
      return acc;
    }, []);
  }, [allSkills, filter, sortDesc]);

  const heroData = useMemo(() => {
    if (!data) return null;
    return findMostActiveSkill(data.skills, data.overview.evolution);
  }, [data]);

  const filterCounts = useMemo(() => {
    const counts: Record<FilterTab, number> = {
      ALL: allSkills.length,
      HEALTHY: 0,
      WARNING: 0,
      CRITICAL: 0,
      UNGRADED: 0,
    };
    for (const s of allSkills) {
      if (s.status in counts) {
        counts[s.status as Exclude<FilterTab, "ALL">]++;
      }
    }
    return counts;
  }, [allSkills]);

  if (isLoading) {
    return <SkillsLibrarySkeleton />;
  }

  if (isError) {
    return (
      <SkillsLibraryError
        message={error instanceof Error ? error.message : "Failed to load skills library."}
        onRetry={() => refetch()}
      />
    );
  }

  if (!data) {
    return <SkillsLibrarySkeleton />;
  }

  const pendingProposals = data.overview.pending_proposals.map((p) => ({
    id: p.proposal_id,
    skillName: p.skill_name ?? null,
    action: p.action,
  }));

  const aggRate = aggregatePassRate(data.skills);
  const gradedCount = data.skills.filter((s) => s.total_checks >= 5).length;

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
          <SkillHeroCard
            skillName={heroData.skill.skill_name}
            skillScope={heroData.skill.skill_scope}
            passRate={heroData.skill.total_checks > 0 ? heroData.skill.pass_rate : null}
            totalChecks={heroData.skill.total_checks}
            uniqueSessions={heroData.skill.unique_sessions}
            status={deriveStatus(heroData.skill.pass_rate, heroData.skill.total_checks)}
            latestEvolutionTimestamp={heroData.latestEvolution?.timestamp ?? null}
            renderActions={renderHeroActions}
          />
        ) : (
          <SkillHeroEmpty />
        )}

        <div className="col-span-12 lg:col-span-4 flex flex-col gap-6">
          <LibraryHealthCard aggregatePassRate={aggRate} gradedCount={gradedCount} />
          <PendingProposalsCard proposals={pendingProposals} />
        </div>
      </div>

      {/* Skills Grid Section */}
      <div className="space-y-6">
        <SkillFilterTabs
          filter={filter}
          onFilterChange={setFilter}
          counts={filterCounts}
          sortDesc={sortDesc}
          onSortToggle={() => setSortDesc((p) => !p)}
        />

        {filteredSkills.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {filteredSkills.map((skill: DerivedSkill) => (
              <SkillCardItem key={skill.name} skill={skill} renderActions={renderCardActions} />
            ))}
          </div>
        ) : (
          <SkillGridEmpty />
        )}
      </div>
    </div>
  );
}
