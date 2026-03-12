import { useMemo } from "react"
import { ActivityPanel } from "@/components/ActivityTimeline"
import { SectionCards } from "@/components/section-cards"
import { SkillHealthGrid } from "@/components/skill-health-grid"
import type { SkillCard, SkillHealthStatus, SkillSummary, OverviewResponse } from "@/types"
import { deriveStatus } from "@/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { AlertCircleIcon, RefreshCwIcon } from "lucide-react"

function deriveSkillCards(skills: SkillSummary[]): SkillCard[] {
  const cards: SkillCard[] = skills.map((s) => ({
    name: s.skill_name,
    passRate: s.total_checks > 0 ? s.pass_rate : null,
    checks: s.total_checks,
    status: deriveStatus(s.pass_rate, s.total_checks),
    hasEvidence: s.has_evidence,
    uniqueSessions: s.unique_sessions,
    lastSeen: s.last_seen,
  }))

  cards.sort((a, b) => {
    const aRate = a.passRate ?? 1
    const bRate = b.passRate ?? 1
    if (aRate !== bRate) return aRate - bRate
    return b.checks - a.checks
  })

  return cards
}

export function Overview({
  search,
  statusFilter,
  overviewResult,
}: {
  search: string
  statusFilter: SkillHealthStatus | "ALL"
  overviewResult: { data: OverviewResponse | null; state: string; error: string | null; retry: () => void }
}) {
  const { data, state, error, retry } = overviewResult

  const cards = useMemo(() => (data ? deriveSkillCards(data.skills) : []), [data])

  const filteredCards = useMemo(() => {
    let result = cards
    if (search) {
      const q = search.toLowerCase()
      result = result.filter((c) => c.name.toLowerCase().includes(q))
    }
    if (statusFilter !== "ALL") {
      result = result.filter((c) => c.status === statusFilter)
    }
    return result
  }, [cards, search, statusFilter])

  if (state === "loading") {
    return (
      <div className="@container/main flex flex-1 flex-col gap-6 py-6">
        <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="px-4 lg:px-6">
          <Skeleton className="h-8 w-32 mb-4" />
          <div className="grid grid-cols-1 gap-3 @xl/main:grid-cols-2 @5xl/main:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (state === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
        <AlertCircleIcon className="size-10 text-destructive" />
        <p className="text-sm font-medium text-destructive">{error ?? "Unknown error"}</p>
        <Button variant="outline" size="sm" onClick={retry}>
          <RefreshCwIcon className="mr-2 size-3.5" />
          Retry
        </Button>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16">
        <p className="text-sm text-muted-foreground">No telemetry data found. Run some sessions first.</p>
      </div>
    )
  }

  const { overview, skills } = data
  const gradedSkills = skills.filter((s) => s.total_checks >= 5)
  const avgPassRate =
    gradedSkills.length > 0
      ? gradedSkills.reduce((sum, s) => sum + s.pass_rate, 0) / gradedSkills.length
      : null

  return (
    <div className="@container/main flex flex-1 flex-col gap-6 py-6">
      <SectionCards
        skillsCount={skills.length}
        avgPassRate={avgPassRate}
        unmatchedCount={overview.unmatched_queries.length}
        sessionsCount={overview.counts.sessions}
        pendingCount={overview.pending_proposals.length}
        evidenceCount={overview.counts.evidence}
      />

      <SkillHealthGrid cards={filteredCards} totalCount={cards.length} />

      <div className="px-4 lg:px-6">
        <ActivityPanel
          evolution={overview.evolution}
          pendingProposals={overview.pending_proposals}
          unmatchedQueries={overview.unmatched_queries}
        />
      </div>
    </div>
  )
}
