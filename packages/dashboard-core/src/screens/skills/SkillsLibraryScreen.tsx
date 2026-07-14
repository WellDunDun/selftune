"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import type { DerivedSkill, FilterTab } from "@selftune/ui/components";
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

export interface SkillsLibraryHero {
  skillName: string;
  skillScope?: string | null;
  platforms?: string[];
  passRate: number | null;
  totalChecks: number;
  uniqueSessions: number;
  status: DerivedSkill["status"];
  latestEvolutionTimestamp?: string | null;
}

export interface SkillsLibraryPendingProposal {
  id: string;
  skillName: string | null;
  action: string;
}

export interface SkillsLibraryScreenProps {
  skills: DerivedSkill[];
  inventoryControl?: ReactNode;
  heroSkill?: SkillsLibraryHero | null;
  aggregatePassRate: number | null;
  gradedCount: number;
  pendingProposals: SkillsLibraryPendingProposal[];
  isLoading: boolean;
  error?: string | null;
  onRetry(): void;
  renderHeroActions(skillName: string): ReactNode;
  renderCardActions(skillName: string): ReactNode;
}

export function SkillsLibraryScreen({
  skills,
  inventoryControl,
  heroSkill,
  aggregatePassRate,
  gradedCount,
  pendingProposals,
  isLoading,
  error,
  onRetry,
  renderHeroActions,
  renderCardActions,
}: SkillsLibraryScreenProps) {
  const [filter, setFilter] = useState<FilterTab>("ALL");
  const [sortDesc, setSortDesc] = useState(true);

  const filteredSkills = useMemo(() => {
    let result = skills;
    if (filter !== "ALL") {
      result = result.filter((skill) => skill.status === filter);
    }
    if (!sortDesc) {
      return result;
    }
    return result.reduceRight<DerivedSkill[]>((acc, skill) => {
      acc.push(skill);
      return acc;
    }, []);
  }, [filter, skills, sortDesc]);

  const counts = useMemo<Record<FilterTab, number>>(() => {
    const nextCounts: Record<FilterTab, number> = {
      ALL: skills.length,
      HEALTHY: 0,
      WARNING: 0,
      CRITICAL: 0,
      UNGRADED: 0,
    };

    for (const skill of skills) {
      if (skill.status in nextCounts) {
        nextCounts[skill.status as Exclude<FilterTab, "ALL">]++;
      }
    }

    return nextCounts;
  }, [skills]);

  if (isLoading) {
    return <SkillsLibrarySkeleton />;
  }

  if (error) {
    return <SkillsLibraryError message={error} onRetry={onRetry} />;
  }

  return (
    <div
      data-parity-root="skills-library"
      className="@container/main flex flex-1 animate-in fade-in flex-col gap-8 px-4 py-8 duration-500 lg:px-6"
    >
      <div>
        <h1 className="font-headline text-4xl font-bold tracking-tight text-foreground">
          Skills Library
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Monitor and manage your evolving skill definitions across all scopes.
        </p>
      </div>

      {inventoryControl}

      <div className="grid grid-cols-12 gap-6">
        {heroSkill ? (
          <SkillHeroCard
            skillName={heroSkill.skillName}
            skillScope={heroSkill.skillScope ?? null}
            platforms={heroSkill.platforms}
            passRate={heroSkill.passRate}
            totalChecks={heroSkill.totalChecks}
            uniqueSessions={heroSkill.uniqueSessions}
            status={heroSkill.status}
            latestEvolutionTimestamp={heroSkill.latestEvolutionTimestamp ?? null}
            renderActions={renderHeroActions}
          />
        ) : (
          <SkillHeroEmpty />
        )}

        <div className="col-span-12 flex flex-col gap-6 lg:col-span-4">
          <LibraryHealthCard aggregatePassRate={aggregatePassRate} gradedCount={gradedCount} />
          <PendingProposalsCard proposals={pendingProposals} />
        </div>
      </div>

      <div className="space-y-6">
        <SkillFilterTabs
          filter={filter}
          onFilterChange={setFilter}
          counts={counts}
          sortDesc={sortDesc}
          onSortToggle={() => setSortDesc((value) => !value)}
        />

        {filteredSkills.length > 0 ? (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            {filteredSkills.map((skill) => (
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
