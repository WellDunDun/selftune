import { Link, useParams } from "react-router-dom";
import { KpiCard } from "../components/KpiCard";
import { EmptyState, ErrorState, LoadingState } from "../components/LoadingState";
import { StatusPill } from "../components/StatusPill";
import { useSkillReport } from "../hooks/useSkillReport";
import type { SkillHealthStatus } from "../types";

function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "--";
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

function deriveStatus(passRate: number, checks: number, regression: boolean): SkillHealthStatus {
  if (checks < 5) return "UNGRADED";
  if (regression) return "CRITICAL";
  if (passRate >= 0.8) return "HEALTHY";
  if (passRate >= 0.5) return "WARNING";
  return "CRITICAL";
}

export function SkillReport() {
  const { name } = useParams<{ name: string }>();
  const decodedName = name ? decodeURIComponent(name) : undefined;
  const { data, state, error, retry } = useSkillReport(decodedName);

  if (!decodedName) return <ErrorState message="No skill name provided" />;
  if (state === "loading") return <LoadingState message={`Loading ${decodedName}...`} />;
  if (state === "error") return <ErrorState message={error ?? "Unknown error"} onRetry={retry} />;
  if (state === "not-found") {
    return (
      <div className="skill-report">
        <EmptyState message={`No data found for skill "${decodedName}".`} />
        <Link to="/" className="btn" style={{ marginTop: "1rem", display: "inline-block" }}>
          Back to Overview
        </Link>
      </div>
    );
  }
  if (!data) return <EmptyState />;

  const { snapshot, evaluations, overview } = data;
  const passRate = snapshot?.pass_rate ?? null;
  const checks = snapshot?.skill_checks ?? 0;
  const regression = snapshot?.regression_detected ?? false;
  const status = passRate !== null ? deriveStatus(passRate, checks, regression) : "UNKNOWN";

  // Get evolution entries for this skill
  const skillEvolution = overview.evolution.filter(
    (e) => e.details?.toLowerCase().includes(decodedName.toLowerCase()),
  );

  // Get pending proposals for this skill
  const skillPending = overview.computed.pendingProposals.filter(
    (p) => p.skill_name === decodedName,
  );

  // Invocation type breakdown
  const invocationTypes = snapshot?.by_invocation_type
    ? Object.entries(snapshot.by_invocation_type)
    : [];

  return (
    <div className="skill-report">
      {/* Skill Header */}
      <div className="skill-header">
        <div className="skill-header-left">
          <h1 className="skill-title">{decodedName}</h1>
          <StatusPill status={status} />
        </div>
      </div>

      {/* KPIs */}
      <section className="kpi-strip">
        <KpiCard label="Pass Rate" value={formatRate(passRate)} color={passRate !== null && passRate < 0.5 ? "#dc2626" : undefined} />
        <KpiCard label="Checks" value={checks} />
        <KpiCard label="Window Sessions" value={snapshot?.window_sessions ?? 0} />
        <KpiCard label="False Negative Rate" value={formatRate(snapshot?.false_negative_rate)} />
        <KpiCard label="Baseline" value={formatRate(snapshot?.baseline_pass_rate)} />
        {regression && <KpiCard label="Regression" value="YES" color="#dc2626" />}
      </section>

      {/* Invocation Type Breakdown */}
      {invocationTypes.length > 0 && (
        <section className="section">
          <h2 className="section-title">Invocation Breakdown</h2>
          <div className="invocation-grid">
            {invocationTypes.map(([type, counts]) => (
              <div className="invocation-card" key={type}>
                <div className="invocation-type">{type}</div>
                <div className="invocation-stats">
                  <span className="invocation-pass">{counts.passed}/{counts.total}</span>
                  <span className="invocation-rate">
                    {counts.total > 0 ? `${Math.round((counts.passed / counts.total) * 100)}%` : "--"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Evaluation Records */}
      <section className="section">
        <h2 className="section-title">
          Evaluation Records
          <span className="section-count">{evaluations.length}</span>
        </h2>
        {evaluations.length === 0 ? (
          <EmptyState message="No evaluation records yet." />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Query</th>
                  <th>Triggered</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {evaluations.slice().reverse().slice(0, 100).map((rec, i) => (
                  <tr key={`${rec.session_id}-${i}`} className={rec.triggered ? "" : "row-miss"}>
                    <td className="cell-time">{timeAgo(rec.timestamp)}</td>
                    <td className="cell-query">{rec.query}</td>
                    <td className="cell-triggered">{rec.triggered ? "Yes" : "No"}</td>
                    <td className="cell-source">{rec.source ?? "--"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Pending Proposals */}
      {skillPending.length > 0 && (
        <section className="section">
          <h2 className="section-title">Pending Proposals</h2>
          <div className="evolution-feed">
            {skillPending.map((p) => (
              <div className="evolution-entry" key={p.proposal_id}>
                <div className="evolution-meta">
                  <span className={`evolution-action action-${p.action}`}>{p.action}</span>
                  <span className="evolution-time">{timeAgo(p.timestamp)}</span>
                </div>
                <div className="evolution-detail">{p.details}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Evolution History for this skill */}
      {skillEvolution.length > 0 && (
        <section className="section">
          <h2 className="section-title">Evolution History</h2>
          <div className="evolution-feed">
            {skillEvolution.slice(-15).reverse().map((entry, i) => (
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
    </div>
  );
}
