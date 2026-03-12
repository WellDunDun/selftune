import { Link } from "react-router-dom";
import { KpiCard } from "../components/KpiCard";
import { EmptyState, ErrorState, LoadingState } from "../components/LoadingState";
import { StatusPill } from "../components/StatusPill";
import { useOverview } from "../hooks/useOverview";
import type { SkillCard, SkillSummary } from "../types";
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

  if (state === "loading") return <LoadingState message="Loading dashboard..." />;
  if (state === "error") return <ErrorState message={error ?? "Unknown error"} onRetry={retry} />;
  if (!data) return <EmptyState message="No telemetry data found. Run some sessions first." />;

  const { overview, skills } = data;
  const cards = deriveSkillCards(skills);

  const gradedSkills = skills.filter((s) => s.total_checks >= 5);
  const avgPassRate =
    gradedSkills.length > 0
      ? gradedSkills.reduce((sum, s) => sum + s.pass_rate, 0) / gradedSkills.length
      : null;

  return (
    <div className="overview">
      {/* KPI Strip */}
      <section className="kpi-strip">
        <KpiCard label="Skills Monitored" value={skills.length} />
        <KpiCard
          label="Avg Pass Rate"
          value={formatRate(avgPassRate)}
          color={avgPassRate !== null && avgPassRate < 0.5 ? "#dc2626" : undefined}
        />
        <KpiCard label="Unmatched Queries" value={overview.unmatched_queries.length} />
        <KpiCard label="Sessions" value={overview.counts.telemetry} />
        <KpiCard label="Pending Proposals" value={overview.pending_proposals.length} />
        <KpiCard label="Total Evidence" value={overview.counts.evidence} />
      </section>

      {/* Skill Health Grid */}
      <section className="section">
        <h2 className="section-title">Skill Health</h2>
        {cards.length === 0 ? (
          <EmptyState message="No skills detected yet. Trigger some skills to see data." />
        ) : (
          <div className="skill-grid">
            {cards.map((card) => (
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
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Recent Evolution */}
      {overview.evolution.length > 0 && (
        <section className="section">
          <h2 className="section-title">Recent Evolution</h2>
          <div className="evolution-feed">
            {overview.evolution.slice(0, 20).map((entry, i) => (
              <div className="evolution-entry" key={`${entry.proposal_id}-${i}`}>
                <div className="evolution-meta">
                  <span className={`evolution-action action-${entry.action}`}>{entry.action}</span>
                  <span className="evolution-time">{timeAgo(entry.timestamp)}</span>
                </div>
                <div className="evolution-detail">{entry.details}</div>
                <div className="evolution-proposal">#{entry.proposal_id.slice(0, 8)}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Unmatched Queries */}
      {overview.unmatched_queries.length > 0 && (
        <section className="section">
          <h2 className="section-title">
            Unmatched Queries
            <span className="section-count">{overview.unmatched_queries.length}</span>
          </h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Query</th>
                </tr>
              </thead>
              <tbody>
                {overview.unmatched_queries.slice(0, 50).map((q, i) => (
                  <tr key={`${q.session_id}-${i}`}>
                    <td className="cell-time">{timeAgo(q.timestamp)}</td>
                    <td className="cell-query">{q.query}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
