import {
  SkillsLibraryScreen,
  type SkillsLibraryHero,
  type SkillsLibraryPendingProposal,
} from "@selftune/dashboard-core/screens/skills";
import type { DerivedSkill } from "@selftune/ui/components";
import { deriveStatus, sortByPassRateAndChecks } from "@selftune/ui/lib";
import { Badge, Button } from "@selftune/ui/primitives";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArchiveIcon, ArchiveRestoreIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  usePortfolio,
  useQuarantinePortfolioSkill,
  useRestorePortfolioSkill,
} from "@/hooks/usePortfolio";
import type {
  EvolutionEntry,
  OverviewResponse,
  PortfolioAuditEntry,
  PortfolioClassification,
  SkillSummary,
} from "@/types";

const CLASSIFICATION_LABELS: Record<PortfolioClassification, string> = {
  protected: "Protected",
  unobserved: "Unobserved",
  under_observed: "Building evidence",
  routing_problem: "Routing problem",
  active: "Active",
  inactive_candidate: "Review inactivity",
  consolidation_candidate: "Review overlap",
};

const CLASSIFICATION_STYLES: Record<PortfolioClassification, string> = {
  protected: "border-border/40 bg-muted text-muted-foreground",
  unobserved: "border-border/40 bg-muted text-muted-foreground",
  under_observed: "border-sky-400/25 bg-sky-400/10 text-sky-300",
  routing_problem: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  active: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  inactive_candidate: "border-destructive/25 bg-destructive/10 text-destructive",
  consolidation_candidate: "border-fuchsia-400/25 bg-fuchsia-400/10 text-fuchsia-300",
};

function formatEvidence(entry: PortfolioAuditEntry): string {
  if (entry.evidence.trusted_checks === 0) return "No trusted checks";
  const invoked = entry.evidence.triggered_count;
  const checks = entry.evidence.trusted_checks;
  return `${invoked} invoked / ${checks} checks`;
}

function isPortfolioClassification(value: string): value is PortfolioClassification {
  return value in CLASSIFICATION_LABELS;
}

function InstalledInventory() {
  const portfolio = usePortfolio();
  const quarantine = useQuarantinePortfolioSkill();
  const restore = useRestorePortfolioSkill();
  const [search, setSearch] = useState("");
  const [classification, setClassification] = useState<PortfolioClassification | "all">("all");

  const visibleSkills = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return (portfolio.data?.audit.skills ?? []).filter((skill) => {
      if (classification !== "all" && skill.classification !== classification) return false;
      if (!normalizedSearch) return true;
      return `${skill.skill_name} ${skill.scope} ${skill.package_path}`
        .toLowerCase()
        .includes(normalizedSearch);
    });
  }, [classification, portfolio.data, search]);

  const confirmQuarantine = (skill: PortfolioAuditEntry) => {
    const evidenceWarning =
      skill.classification === "unobserved"
        ? "SelfTune has no evidence that this skill is unused. "
        : "";
    if (
      !window.confirm(
        `${evidenceWarning}Move ${skill.skill_name} out of its active registry? You can restore it from this screen.`,
      )
    ) {
      return;
    }
    quarantine.mutate({ skillName: skill.skill_name, skillPath: skill.skill_path });
  };

  return (
    <section className="border-y border-border/20 bg-background/30 py-5">
      <div className="flex flex-col gap-4 px-1">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-headline text-lg font-semibold text-foreground">
                Installed inventory
              </h2>
              {portfolio.data ? (
                <Badge variant="outline" className="border-border/40 bg-muted/40 text-foreground">
                  {portfolio.data.audit.installed_count}
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Packages discovered across project, global, Codex, and managed registries.
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <label className="flex h-9 min-w-0 items-center gap-2 border border-border/30 bg-muted/30 px-3 sm:w-72">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search installed skills"
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
            <select
              value={classification}
              onChange={(event) => {
                const value = event.target.value;
                setClassification(
                  value === "all" || isPortfolioClassification(value) ? value : "all",
                );
              }}
              className="h-9 border border-border/30 bg-muted/30 px-3 text-sm text-foreground outline-none"
              aria-label="Filter installed skills"
            >
              <option value="all">All evidence states</option>
              {Object.entries(CLASSIFICATION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="icon"
              title="Refresh installed inventory"
              aria-label="Refresh installed inventory"
              onClick={() => void portfolio.refetch()}
              disabled={portfolio.isFetching}
            >
              <RefreshCwIcon className={`size-4 ${portfolio.isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {portfolio.isError ? (
          <div className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {portfolio.error instanceof Error
              ? portfolio.error.message
              : "Installed inventory could not be loaded."}
          </div>
        ) : null}

        <div className="overflow-x-auto border border-border/20">
          <table className="w-full min-w-[820px] border-collapse text-left text-sm">
            <thead className="bg-muted/50 text-[11px] uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Skill</th>
                <th className="px-3 py-2 font-medium">Scope</th>
                <th className="px-3 py-2 font-medium">Evidence state</th>
                <th className="px-3 py-2 font-medium">Observed evidence</th>
                <th className="px-3 py-2 font-medium">Recommendation</th>
                <th className="w-12 px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/15">
              {portfolio.isLoading ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                    Scanning installed registries...
                  </td>
                </tr>
              ) : visibleSkills.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                    No installed skills match this view.
                  </td>
                </tr>
              ) : (
                visibleSkills.map((skill) => (
                  <tr key={skill.skill_path} className="bg-background/20 hover:bg-muted/20">
                    <td className="max-w-72 px-3 py-3">
                      <p className="font-medium text-foreground">{skill.skill_name}</p>
                      <p
                        className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                        title={skill.package_path}
                      >
                        {skill.package_path}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">{skill.scope}</td>
                    <td className="px-3 py-3">
                      <Badge
                        variant="outline"
                        className={CLASSIFICATION_STYLES[skill.classification]}
                      >
                        {CLASSIFICATION_LABELS[skill.classification]}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">{formatEvidence(skill)}</td>
                    <td className="max-w-80 px-3 py-3 text-xs text-muted-foreground">
                      {skill.reason}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {skill.classification !== "protected" ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Quarantine skill"
                          aria-label={`Quarantine ${skill.skill_name}`}
                          onClick={() => confirmQuarantine(skill)}
                          disabled={quarantine.isPending}
                        >
                          <ArchiveIcon className="size-4" />
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {(portfolio.data?.quarantined.length ?? 0) > 0 ? (
          <div className="border border-border/20 bg-muted/20">
            <div className="border-b border-border/15 px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
              Quarantined
            </div>
            {portfolio.data?.quarantined.map((record) => (
              <div
                key={record.quarantine_id}
                className="flex items-center justify-between gap-4 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{record.skill_name}</p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {record.original_package_path}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => restore.mutate(record.quarantine_id)}
                  disabled={restore.isPending}
                >
                  <ArchiveRestoreIcon className="size-4" />
                  Restore
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        {quarantine.error || restore.error ? (
          <p className="text-xs text-destructive">{(quarantine.error ?? restore.error)?.message}</p>
        ) : null}
      </div>
    </section>
  );
}

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

  const allSkills = useMemo(() => (data ? deriveSkills(data.skills) : []), [data]);

  const heroData = useMemo(() => {
    if (!data) return null;
    return findMostActiveSkill(data.skills, data.overview.evolution);
  }, [data]);

  const heroSkill = useMemo<SkillsLibraryHero | null>(() => {
    if (!heroData) return null;
    return {
      skillName: heroData.skill.skill_name,
      skillScope: heroData.skill.skill_scope,
      passRate: heroData.skill.total_checks > 0 ? heroData.skill.pass_rate : null,
      totalChecks: heroData.skill.total_checks,
      uniqueSessions: heroData.skill.unique_sessions,
      status: deriveStatus(heroData.skill.pass_rate, heroData.skill.total_checks),
      latestEvolutionTimestamp: heroData.latestEvolution?.timestamp ?? null,
    };
  }, [heroData]);

  const pendingProposals = useMemo<SkillsLibraryPendingProposal[]>(() => {
    if (!data) return [];
    return data.overview.pending_proposals.map((proposal) => ({
      id: proposal.proposal_id,
      skillName: proposal.skill_name ?? null,
      action: proposal.action,
    }));
  }, [data]);

  return (
    <SkillsLibraryScreen
      skills={allSkills}
      inventoryControl={<InstalledInventory />}
      heroSkill={heroSkill}
      aggregatePassRate={data ? aggregatePassRate(data.skills) : null}
      gradedCount={data ? data.skills.filter((skill) => skill.total_checks >= 5).length : 0}
      pendingProposals={pendingProposals}
      isLoading={isLoading}
      error={
        isError ? (error instanceof Error ? error.message : "Failed to load skills library.") : null
      }
      onRetry={() => {
        void refetch();
      }}
      renderHeroActions={renderHeroActions}
      renderCardActions={renderCardActions}
    />
  );
}
