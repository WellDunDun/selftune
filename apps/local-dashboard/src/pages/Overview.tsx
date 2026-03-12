import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ActivityTimeline } from "../components/ActivityTimeline";
import { KpiCard } from "../components/KpiCard";
import { EmptyState, ErrorState, LoadingState } from "../components/LoadingState";
import { Sidebar } from "../components/Sidebar";
import { StatusPill } from "../components/StatusPill";
import { useOverview } from "../hooks/useOverview";
import type { SkillCard, SkillHealthStatus, SkillSummary } from "../types";
import { deriveStatus, formatRate, timeAgo } from "../utils";

function deriveSkillCards(skills: SkillSummary[]): SkillCard[] {
  const cards: SkillCard[] = skills.map((s) => ({
    name: s.skill_name,
    passRate: s.total_checks > 0 ? s.pass_rate : null,
    checks: s.total_checks,
    status: deriveStatus(s.pass_rate, s.total_checks),
    hasEvidence: s.has_evidence,
    uniqueSessions: s.unique_sessions,
    lastSeen: s.last_seen,
  }));

  // Sort: lowest pass rate first, then most checks
  cards.sort((a, b) => {
    const aRate = a.passRate ?? 1;
    const bRate = b.passRate ?? 1;
    if (aRate !== bRate) return aRate - bRate;
    return b.checks - a.checks;
  });

  return cards;
}

export function Overview() {
  const { data, state, error, retry } = useOverview();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<SkillHealthStatus | "ALL">("ALL");

  const cards = useMemo(() => (data ? deriveSkillCards(data.skills) : []), [data]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { HEALTHY: 0, WARNING: 0, CRITICAL: 0, UNGRADED: 0, UNKNOWN: 0 };
    for (const c of cards) {
      counts[c.status] = (counts[c.status] ?? 0) + 1;
    }
    return counts;
  }, [cards]);

  const filteredCards = useMemo(() => {
    let result = cards;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((c) => c.name.toLowerCase().includes(q));
    }
    if (statusFilter !== "ALL") {
      result = result.filter((c) => c.status === statusFilter);
    }
    return result;
  }, [cards, search, statusFilter]);

  if (state === "loading") return <LoadingState message="Loading dashboard..." />;
  if (state === "error") return <ErrorState message={error ?? "Unknown error"} onRetry={retry} />;
  if (!data) return <EmptyState message="No telemetry data found. Run some sessions first." />;

  const { overview, skills } = data;

  const gradedSkills = skills.filter((s) => s.total_checks >= 5);
  const avgPassRate =
    gradedSkills.length > 0
      ? gradedSkills.reduce((sum, s) => sum + s.pass_rate, 0) / gradedSkills.length
      : null;

  return (
    <div className="dashboard-layout">
      <Sidebar
        search={search}
        onSearchChange={setSearch}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        counts={statusCounts}
      />

      <div className="dashboard-center">
        {/* KPI Strip */}
        <section className="kpi-strip">
          <KpiCard label="Skills Monitored" value={skills.length} />
          <KpiCard
            label="Avg Pass Rate"
            value={formatRate(avgPassRate)}
            color={avgPassRate !== null && avgPassRate < 0.5 ? "#dc2626" : undefined}
          />
          <KpiCard label="Unmatched Queries" value={overview.unmatched_queries.length} />
          <KpiCard label="Sessions" value={overview.counts.sessions} />
          <KpiCard label="Pending Proposals" value={overview.pending_proposals.length} />
          <KpiCard label="Total Evidence" value={overview.counts.evidence} />
        </section>

        {/* Skill Health Grid */}
        <section className="section">
          <h2 className="section-title">
            Skill Health
            {filteredCards.length !== cards.length && (
              <span className="section-count">
                {filteredCards.length} / {cards.length}
              </span>
            )}
          </h2>
          {filteredCards.length === 0 ? (
            <EmptyState
              message={
                cards.length === 0
                  ? "No skills detected yet. Trigger some skills to see data."
                  : "No skills match your filters."
              }
            />
          ) : (
            <div className="skill-grid">
              {filteredCards.map((card) => (
                <Link to={`/skills/${encodeURIComponent(card.name)}`} key={card.name} className="skill-card">
                  <div className="skill-card-header">
                    <span className="skill-name">{card.name}</span>
                    <StatusPill status={card.status} />
                  </div>
                  <div className="skill-card-body">
                    <div className="skill-stat">
                      <span className="skill-stat-value">{formatRate(card.passRate)}</span>
                      <span className="skill-stat-label">pass rate</span>
                    </div>
                    <div className="skill-stat">
                      <span className="skill-stat-value">{card.checks}</span>
                      <span className="skill-stat-label">checks</span>
                    </div>
                    <div className="skill-stat">
                      <span className="skill-stat-value">{card.uniqueSessions}</span>
                      <span className="skill-stat-label">sessions</span>
                    </div>
                    {card.lastSeen && (
                      <div className="skill-stat skill-stat-last">
                        <span className="skill-stat-value skill-stat-time">{timeAgo(card.lastSeen)}</span>
                        <span className="skill-stat-label">last seen</span>
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      <ActivityTimeline
        evolution={overview.evolution}
        pendingProposals={overview.pending_proposals}
        unmatchedQueries={overview.unmatched_queries}
      />
    </div>
  );
}
