import type { EvolutionEntry, PendingProposal, UnmatchedQuery } from "../types";
import { timeAgo } from "../utils";

export function ActivityTimeline({
  evolution,
  pendingProposals,
  unmatchedQueries,
}: {
  evolution: EvolutionEntry[];
  pendingProposals: PendingProposal[];
  unmatchedQueries: UnmatchedQuery[];
}) {
  return (
    <aside className="sidebar-right">
      {/* Pending Proposals */}
      {pendingProposals.length > 0 && (
        <div className="timeline-section">
          <h3 className="timeline-heading">
            Pending Proposals
            <span className="timeline-count">{pendingProposals.length}</span>
          </h3>
          <div className="timeline-list">
            {pendingProposals.slice(0, 10).map((p) => (
              <div className="timeline-item" key={p.proposal_id}>
                <div className="timeline-dot dot-pending" />
                <div className="timeline-content">
                  <span className={`timeline-action action-${p.action}`}>{p.action}</span>
                  <span className="timeline-time">{timeAgo(p.timestamp)}</span>
                  <p className="timeline-detail">{p.details}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Evolution Timeline */}
      {evolution.length > 0 && (
        <div className="timeline-section">
          <h3 className="timeline-heading">Recent Activity</h3>
          <div className="timeline-list">
            {evolution.slice(0, 30).map((entry, i) => (
              <div className="timeline-item" key={`${entry.proposal_id}-${i}`}>
                <div className={`timeline-dot dot-${entry.action}`} />
                <div className="timeline-content">
                  <div className="timeline-meta">
                    <span className={`timeline-action action-${entry.action}`}>{entry.action}</span>
                    <span className="timeline-time">{timeAgo(entry.timestamp)}</span>
                  </div>
                  <p className="timeline-detail">{entry.details}</p>
                  <span className="timeline-id">#{entry.proposal_id.slice(0, 8)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unmatched Queries */}
      {unmatchedQueries.length > 0 && (
        <div className="timeline-section">
          <h3 className="timeline-heading">
            Unmatched Queries
            <span className="timeline-count">{unmatchedQueries.length}</span>
          </h3>
          <div className="timeline-list">
            {unmatchedQueries.slice(0, 15).map((q, i) => (
              <div className="timeline-item" key={`${q.session_id}-${i}`}>
                <div className="timeline-dot dot-unmatched" />
                <div className="timeline-content">
                  <span className="timeline-time">{timeAgo(q.timestamp)}</span>
                  <p className="timeline-detail timeline-query">{q.query}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {evolution.length === 0 && pendingProposals.length === 0 && unmatchedQueries.length === 0 && (
        <div className="timeline-empty">No recent activity</div>
      )}
    </aside>
  );
}
