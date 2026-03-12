import { Link, useParams } from "react-router-dom";
import { KpiCard } from "../components/KpiCard";
import { EmptyState, ErrorState, LoadingState } from "../components/LoadingState";
import { StatusPill } from "../components/StatusPill";
import { useSkillReport } from "../hooks/useSkillReport";
import { deriveStatus, formatRate, timeAgo } from "../utils";

export function SkillReport() {
  const { name } = useParams<{ name: string }>();
  const { data, state, error, retry } = useSkillReport(name);

  if (!name) return <ErrorState message="No skill name provided" />;
  if (state === "loading") return <LoadingState message={`Loading ${name}...`} />;
  if (state === "error") return <ErrorState message={error ?? "Unknown error"} onRetry={retry} />;
  if (state === "not-found") {
    return (
      <div className="skill-report">
        <EmptyState message={`No data found for skill "${name}".`} />
        <Link to="/" className="btn" style={{ marginTop: "1rem", display: "inline-block" }}>
          Back to Overview
        </Link>
      </div>
    );
  }
  if (!data) return <EmptyState />;

  const { usage, recent_invocations, evidence, evolution, pending_proposals } = data;
  const status = deriveStatus(usage.pass_rate, usage.total_checks);

  return (
    <div className="skill-report">
      {/* Skill Header */}
      <div className="skill-header">
        <div className="skill-header-left">
          <h1 className="skill-title">{data.skill_name}</h1>
          <StatusPill status={status} />
        </div>
      </div>

      {/* KPIs */}
      <section className="kpi-strip">
        <KpiCard
          label="Pass Rate"
          value={formatRate(usage.pass_rate)}
          color={usage.pass_rate < 0.5 ? "#dc2626" : undefined}
        />
        <KpiCard label="Total Checks" value={usage.total_checks} />
        <KpiCard label="Triggered" value={usage.triggered_count} />
        <KpiCard label="Sessions" value={data.sessions_with_skill} />
        {evidence.length > 0 && <KpiCard label="Evidence Entries" value={evidence.length} />}
      </section>

      {/* Invocation Records */}
      <section className="section">
        <h2 className="section-title">
          Recent Invocations
          <span className="section-count">{recent_invocations.length}</span>
        </h2>
        {recent_invocations.length === 0 ? (
          <EmptyState message="No invocation records yet." />
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
                {recent_invocations.map((rec, i) => (
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
      {pending_proposals.length > 0 && (
        <section className="section">
          <h2 className="section-title">Pending Proposals</h2>
          <div className="evolution-feed">
            {pending_proposals.map((p) => (
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

      {/* Evolution History */}
      {evolution.length > 0 && (
        <section className="section">
          <h2 className="section-title">Evolution History</h2>
          <div className="evolution-feed">
            {evolution.slice(0, 20).map((entry, i) => (
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

      {/* Evidence */}
      {evidence.length > 0 && (
        <section className="section">
          <h2 className="section-title">Evolution Evidence</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Proposal</th>
                  <th>Target</th>
                  <th>Stage</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {evidence.map((e, i) => (
                  <tr key={`${e.proposal_id}-${e.stage}-${i}`}>
                    <td className="cell-time">{timeAgo(e.timestamp)}</td>
                    <td className="cell-source">#{e.proposal_id.slice(0, 8)}</td>
                    <td>{e.target}</td>
                    <td>{e.stage}</td>
                    <td className="cell-source">{e.confidence !== null ? e.confidence.toFixed(2) : "--"}</td>
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
