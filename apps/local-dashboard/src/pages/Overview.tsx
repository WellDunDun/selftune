import { Link } from "react-router-dom";
import { KpiCard } from "../components/KpiCard";
import { EmptyState, ErrorState, LoadingState } from "../components/LoadingState";
import { StatusPill } from "../components/StatusPill";
import { useOverview } from "../hooks/useOverview";
import type { MonitoringSnapshot, OverviewPayload, SkillCard, SkillHealthStatus } from "../types";

function deriveSkillCards(data: OverviewPayload): SkillCard[] {
  const snapshots = data.computed.snapshots;
  const cards: SkillCard[] = [];

  for (const [name, snap] of Object.entries(snapshots)) {
    cards.push({
      name,
      passRate: snap.skill_checks > 0 ? snap.pass_rate : null,
      checks: snap.skill_checks,
      regression: snap.regression_detected,
      status: deriveStatus(snap),
      snapshot: snap,
    });
  }

  // Sort: regressions first, then lowest pass rate
  cards.sort((a, b) => {
    if (a.regression !== b.regression) return a.regression ? -1 : 1;
    const aRate = a.passRate ?? 1;
    const bRate = b.passRate ?? 1;
    return aRate - bRate;
  });

  return cards;
}

function deriveStatus(snap: MonitoringSnapshot): SkillHealthStatus {
  if (snap.skill_checks < 5) return "UNGRADED";
  if (snap.regression_detected) return "CRITICAL";
  if (snap.pass_rate >= 0.8) return "HEALTHY";
  if (snap.pass_rate >= 0.5) return "WARNING";
  return "CRITICAL";
}

function formatRate(rate: number | null): string {
  if (rate === null) return "--";
  return `${Math.round(rate * 100)}%`;
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function Overview() {
  const { data, state, error, retry } = useOverview();

  if (state === "loading") return <LoadingState message="Loading dashboard..." />;
  if (state === "error") return <ErrorState message={error ?? "Unknown error"} onRetry={retry} />;
  if (!data) return <EmptyState message="No telemetry data found. Run some sessions first." />;

  const cards = deriveSkillCards(data);
  const snapshots = Object.values(data.computed.snapshots);
  const avgPassRate =
    snapshots.length > 0
      ? snapshots.reduce((sum, s) => sum + s.pass_rate, 0) / snapshots.length
      : null;
  const regressionCount = snapshots.filter((s) => s.regression_detected).length;

  return (
    <div className="overview">
      {/* KPI Strip */}
      <section className="kpi-strip">
        <KpiCard label="Skills Monitored" value={Object.keys(data.computed.snapshots).length} />
        <KpiCard
          label="Avg Pass Rate"
          value={formatRate(avgPassRate)}
          color={avgPassRate !== null && avgPassRate < 0.5 ? "#dc2626" : undefined}
        />
        <KpiCard
          label="Regressions"
          value={regressionCount}
          color={regressionCount > 0 ? "#dc2626" : "#059669"}
        />
        <KpiCard label="Unmatched Queries" value={data.computed.unmatched_count ?? data.computed.unmatched.length} />
        <KpiCard label="Sessions" value={data.counts.telemetry} />
        <KpiCard label="Pending Proposals" value={data.computed.pendingProposals.length} />
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
                  {card.regression && (
                    <div className="regression-badge">REGRESSION</div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Recent Evolution */}
      {data.evolution.length > 0 && (
        <section className="section">
          <h2 className="section-title">Recent Evolution</h2>
          <div className="evolution-feed">
            {data.evolution.slice(-20).reverse().map((entry, i) => (
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
      {data.computed.unmatched.length > 0 && (
        <section className="section">
          <h2 className="section-title">
            Unmatched Queries
            <span className="section-count">{data.computed.unmatched.length}</span>
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
                {data.computed.unmatched.slice(0, 50).map((q, i) => (
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
