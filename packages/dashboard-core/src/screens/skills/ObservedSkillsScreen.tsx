"use client";

import type { ReactNode } from "react";

import type { DerivedSkill } from "@selftune/ui/components";
import {
  PageHeader,
  PageScaffold,
  SkillsLibraryError,
  SkillsLibrarySkeleton,
} from "@selftune/ui/components";

export interface ObservedSkillsHero {
  skillName: string;
  skillScope?: string | null;
  platforms?: string[];
  passRate: number | null;
  totalChecks: number;
  uniqueSessions: number;
  status: DerivedSkill["status"];
  latestEvolutionTimestamp?: string | null;
}

export interface ObservedSkillsPendingProposal {
  id: string;
  skillName: string | null;
  action: string;
}

export interface ObservedSkillsScreenProps {
  skills: DerivedSkill[];
  inventoryControl?: ReactNode;
  heroSkill?: ObservedSkillsHero | null;
  aggregatePassRate: number | null;
  gradedCount: number;
  pendingProposals: ObservedSkillsPendingProposal[];
  isLoading: boolean;
  error?: string | null;
  onRetry(): void;
  renderHeroActions(skillName: string): ReactNode;
  renderCardActions(skillName: string): ReactNode;
}

export function ObservedSkillsScreen({
  inventoryControl,
  isLoading,
  error,
  onRetry,
}: ObservedSkillsScreenProps) {
  if (isLoading) return <SkillsLibrarySkeleton />;
  if (error) return <SkillsLibraryError message={error} onRetry={onRetry} />;

  return (
    <PageScaffold className="max-w-full overflow-x-hidden">
      <PageHeader
        title="Observed Skills"
        description="Review telemetry-backed skills observed across connected sessions."
      />
      {inventoryControl}
    </PageScaffold>
  );
}
