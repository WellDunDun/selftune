"use client";

import type { ReactNode } from "react";

import type { DerivedSkill } from "@selftune/ui/components";
import {
  PageHeader,
  PageScaffold,
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
  inventoryControl,
  isLoading,
  error,
  onRetry,
}: SkillsLibraryScreenProps) {
  if (isLoading) {
    return <SkillsLibrarySkeleton />;
  }

  if (error) {
    return <SkillsLibraryError message={error} onRetry={onRetry} />;
  }

  return (
    <PageScaffold
      data-parity-root="skills-library"
      className="@container/main min-w-0 max-w-full flex-1 animate-in fade-in overflow-x-hidden duration-500"
    >
      <PageHeader
        title="Skills Library"
        description="Monitor and manage your evolving skill definitions across all scopes."
      />

      {inventoryControl}
    </PageScaffold>
  );
}
