import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import {
  ActivityPanel,
  OrchestrateRunsPanel,
  SectionCards,
  SkillHealthGrid,
} from "@selftune/ui/components"
import type { UseQueryResult } from "@tanstack/react-query"
import type { SkillCard, SkillHealthStatus, SkillSummary, OverviewResponse } from "@/types"
import { useOrchestrateRuns } from "@/hooks/useOrchestrateRuns"
import { deriveStatus, sortByPassRateAndChecks } from "@/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@selftune/ui/primitives"
import { AlertCircleIcon, RefreshCwIcon, RocketIcon, LayersIcon, ActivityIcon, XIcon } from "lucide-react"

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
    }))
  )
}

function OnboardingBanner({ skillCount }: { skillCount: number }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem("selftune-onboarding-dismissed") === "true"
    } catch {
      return false
    }
  })

  // Re-show banner if user has no skills (fresh install)
  const shouldShow = !dismissed || skillCount === 0

  if (!shouldShow) return null

  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem("selftune-onboarding-dismissed", "true")
    } catch {
      // ignore storage errors
    }
  }

  if (skillCount === 0) {
    // Full onboarding empty state
    return (
      <div className="mx-4 lg:mx-6 rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 p-8">
        <div className="flex flex-col items-center text-center gap-4 max-w-md mx-auto">
          <div className="flex items-center justify-center size-12 rounded-full bg-primary/10">
            <RocketIcon className="size-6 text-primary" />
          </div>
          <h2 className="text-lg font-semibold">Welcome to selftune</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            No skills detected yet. Once you start using selftune in your project, skills will appear here automatically.
          </p>
          <div className="grid grid-cols-1 gap-3 w-full text-left sm:grid-cols-3">
            <div className="flex items-start gap-2.5 rounded-lg border bg-card p-3">
              <div className="flex items-center justify-center size-6 rounded-full bg-blue-500/10 text-blue-500 shrink-0 text-xs font-bold">1</div>
              <div>
                <p className="text-xs font-medium">Run selftune</p>
                <p className="text-[11px] text-muted-foreground">Enable selftune in your project to start tracking skills</p>
              </div>
            </div>
            <div className="flex items-start gap-2.5 rounded-lg border bg-card p-3">
              <div className="flex items-center justify-center size-6 rounded-full bg-amber-500/10 text-amber-500 shrink-0 text-xs font-bold">2</div>
              <div>
                <p className="text-xs font-medium">Skills appear</p>
                <p className="text-[11px] text-muted-foreground">Skills are detected and monitored automatically</p>
              </div>
            </div>
            <div className="flex items-start gap-2.5 rounded-lg border bg-card p-3">
              <div className="flex items-center justify-center size-6 rounded-full bg-emerald-500/10 text-emerald-500 shrink-0 text-xs font-bold">3</div>
              <div>
                <p className="text-xs font-medium">Watch evolution</p>
                <p className="text-[11px] text-muted-foreground">Proposals flow in with validated improvements</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Compact welcome banner for returning users who haven't dismissed
  return (
    <div className="mx-4 lg:mx-6 flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
      <RocketIcon className="size-4 text-primary/60 shrink-0" />
      <p className="flex-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Welcome to selftune dashboard.</span>{" "}
        Hover over any metric label's <span className="inline-flex items-center text-muted-foreground/50"><LayersIcon className="size-2.5 mx-0.5" /></span> icon for an explanation.
        Click proposals in the Evolution timeline to see detailed evidence.
      </p>
      <button
        type="button"
        onClick={dismiss}
        className="text-muted-foreground/50 hover:text-muted-foreground transition-colors shrink-0"
      >
        <XIcon className="size-4" />
        <span className="sr-only">Dismiss</span>
      </button>
    </div>
  )
}

export function Overview({
  search,
  statusFilter,
  onStatusFilterChange,
  overviewQuery,
}: {
  search: string
  statusFilter: SkillHealthStatus | "ALL"
  onStatusFilterChange: (v: SkillHealthStatus | "ALL") => void
  overviewQuery: UseQueryResult<OverviewResponse>
}) {
  const { data, isPending, isError, error, refetch } = overviewQuery
  const orchestrateQuery = useOrchestrateRuns()

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

  if (isPending) {
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

  if (isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
        <AlertCircleIcon className="size-10 text-destructive" />
        <p className="text-sm font-medium text-destructive">{error instanceof Error ? error.message : "Unknown error"}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
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
      <OnboardingBanner skillCount={skills.length} />

      <SectionCards
        skillsCount={skills.length}
        avgPassRate={avgPassRate}
        unmatchedCount={overview.unmatched_queries.length}
        sessionsCount={overview.counts.sessions}
        pendingCount={overview.pending_proposals.length}
        evidenceCount={overview.counts.evidence}
        hasEvolution={overview.counts.evolution > 0}
      />

      <div className="grid grid-cols-1 gap-6 @5xl/main:grid-cols-[1fr_320px]">
        <SkillHealthGrid cards={filteredCards} totalCount={cards.length} statusFilter={statusFilter} onStatusFilterChange={onStatusFilterChange} renderSkillName={(skill) => (
          <Link to={`/skills/${encodeURIComponent(skill.name)}`} className="text-sm font-medium hover:underline">
            {skill.name}
          </Link>
        )} />

        <div className="px-4 lg:px-6 @5xl/main:px-0 @5xl/main:pr-4 lg:@5xl/main:pr-6">
          <div className="sticky top-4 space-y-4">
            <ActivityPanel
              evolution={overview.evolution}
              pendingProposals={overview.pending_proposals}
              unmatchedQueries={overview.unmatched_queries}
            />
            {orchestrateQuery.isPending ? (
              <Skeleton className="h-32 rounded-xl" />
            ) : orchestrateQuery.isError ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                Failed to load orchestrate runs.
              </div>
            ) : (
              <OrchestrateRunsPanel runs={orchestrateQuery.data.runs} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
