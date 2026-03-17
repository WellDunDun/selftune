/**
 * Route handler: GET /report/:name
 *
 * Returns an HTML skill health report page with evolution evidence,
 * validation results, and monitoring snapshot.
 */

import type { SkillStatus, StatusResult } from "../status.js";
import type { EvolutionEvidenceEntry } from "../types.js";

interface MergedEvidenceEntry {
  proposal_id: string;
  target: string;
  rationale: string;
  confidence?: number;
  original_text: string;
  proposed_text: string;
  eval_set: import("../types.js").EvalEntry[];
  validation: import("../types.js").EvolutionEvidenceValidation | null;
  stages: Array<{ stage: string; timestamp: string; details: string }>;
  latest_timestamp: string;
}

function mergeEvidenceEntries(entries: EvolutionEvidenceEntry[]): MergedEvidenceEntry[] {
  const merged = new Map<string, MergedEvidenceEntry>();
  const sorted = [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  for (const entry of sorted) {
    if (!merged.has(entry.proposal_id)) {
      merged.set(entry.proposal_id, {
        proposal_id: entry.proposal_id,
        target: entry.target,
        rationale: entry.rationale ?? "",
        confidence: entry.confidence,
        original_text: entry.original_text ?? "",
        proposed_text: entry.proposed_text ?? "",
        eval_set: entry.eval_set ?? [],
        validation: entry.validation ?? null,
        stages: [],
        latest_timestamp: entry.timestamp,
      });
    }

    const current = merged.get(entry.proposal_id);
    if (!current) continue;
    current.stages.push({
      stage: entry.stage,
      timestamp: entry.timestamp,
      details: entry.details ?? "",
    });
    if (!current.rationale && entry.rationale) current.rationale = entry.rationale;
    if (current.confidence === undefined && entry.confidence !== undefined) {
      current.confidence = entry.confidence;
    }
    if (!current.original_text && entry.original_text) current.original_text = entry.original_text;
    if (!current.proposed_text && entry.proposed_text) current.proposed_text = entry.proposed_text;
    if (current.eval_set.length === 0 && entry.eval_set) current.eval_set = entry.eval_set;
    if (!current.validation && entry.validation) current.validation = entry.validation;
  }

  return [...merged.values()].sort((a, b) => b.latest_timestamp.localeCompare(a.latest_timestamp));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildReportHTML(
  skillName: string,
  skill: SkillStatus,
  statusResult: StatusResult,
  evidenceEntries: EvolutionEvidenceEntry[],
): string {
  const mergedEvidence = mergeEvidenceEntries(evidenceEntries);
  const latestValidation = mergedEvidence.find(
    (entry) => entry.validation?.per_entry_results?.length,
  );
  const passRateDisplay =
    skill.passRate !== null ? `${Math.round(skill.passRate * 100)}%` : "No data";
  const trendArrows: Record<string, string> = {
    up: "\u2191",
    down: "\u2193",
    stable: "\u2192",
    unknown: "?",
  };
  const trendDisplay = trendArrows[skill.trend] ?? "?";
  const statusColor =
    skill.status === "HEALTHY"
      ? "#4c1"
      : skill.status === "CRITICAL"
        ? "#e05d44"
        : skill.status === "WARNING"
          ? "#dfb317"
          : "#9f9f9f";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>selftune report: ${escapeHtml(skillName)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 1100px; margin: 40px auto; padding: 0 20px; color: #333; background: #fafafa; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    .badge { margin: 16px 0; }
    .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 16px 0; }
    .card h2 { font-size: 1.1rem; margin-top: 0; }
    .stat { display: inline-block; margin-right: 32px; }
    .stat-value { font-size: 2rem; font-weight: bold; }
    .stat-label { font-size: 0.85rem; color: #666; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
    th { font-weight: 600; font-size: 0.85rem; color: #666; text-transform: uppercase; }
    a { color: #0366d6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .status-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; color: #fff; font-size: 0.85rem; font-weight: 600; }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .muted { color: #666; font-size: 0.9rem; }
    .chip { display: inline-flex; align-items: center; padding: 4px 8px; border-radius: 999px; border: 1px solid #e2e8f0; background: #f8fafc; color: #475569; font-size: 0.75rem; margin-right: 6px; margin-bottom: 6px; }
    .artifact { border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-top: 12px; background: #f8fafc; }
    .artifact pre { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; line-height: 1.5; margin: 0; }
    .diff { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 12px; }
    .empty { color: #666; font-size: 0.9rem; }
    @media (max-width: 800px) {
      .grid, .diff { grid-template-columns: 1fr; }
      .stat { display: block; margin-right: 0; margin-bottom: 16px; }
    }
  </style>
</head>
<body>
  <a href="/">\u2190 Dashboard</a>
  <h1>Skill Report: ${escapeHtml(skillName)}</h1>
  <div class="badge">
    <img src="/badge/${encodeURIComponent(skillName)}" alt="Skill Health Badge" />
  </div>

  <div class="card">
    <h2>Health Summary</h2>
    <div class="stat">
      <div class="stat-value">${passRateDisplay}</div>
      <div class="stat-label">Pass Rate</div>
    </div>
    <div class="stat">
      <div class="stat-value">${trendDisplay}</div>
      <div class="stat-label">Trend</div>
    </div>
    <div class="stat">
      <div class="stat-value">${skill.missedQueries}</div>
      <div class="stat-label">Missed Queries</div>
    </div>
    <div class="stat">
      <span class="status-badge" style="background: ${statusColor}">${skill.status}</span>
    </div>
  </div>

  ${
    skill.snapshot
      ? `
  <div class="card">
    <h2>Monitoring Snapshot</h2>
    <table>
      <tr><th>Metric</th><th>Value</th></tr>
      <tr><td>Window Sessions</td><td>${skill.snapshot.window_sessions}</td></tr>
      <tr><td>Pass Rate</td><td>${(skill.snapshot.pass_rate * 100).toFixed(1)}%</td></tr>
      <tr><td>False Negative Rate</td><td>${(skill.snapshot.false_negative_rate * 100).toFixed(1)}%</td></tr>
      <tr><td>Regression Detected</td><td>${skill.snapshot.regression_detected ? "Yes" : "No"}</td></tr>
      <tr><td>Baseline Pass Rate</td><td>${(skill.snapshot.baseline_pass_rate * 100).toFixed(1)}%</td></tr>
    </table>
  </div>`
      : ""
  }

  <div class="card">
    <h2>System Overview</h2>
    <table>
      <tr><th>Metric</th><th>Value</th></tr>
      <tr><td>Total Skills</td><td>${statusResult.skills.length}</td></tr>
      <tr><td>Unmatched Queries</td><td>${statusResult.unmatchedQueries}</td></tr>
      <tr><td>Pending Proposals</td><td>${statusResult.pendingProposals}</td></tr>
      <tr><td>Last Session</td><td>${escapeHtml(statusResult.lastSession ?? "\u2014")}</td></tr>
    </table>
  </div>

  <div class="card">
    <h2>Description Versions</h2>
    ${
      mergedEvidence.length === 0
        ? '<p class="empty">No proposal evidence recorded for this skill yet.</p>'
        : mergedEvidence
            .slice(0, 6)
            .map((entry) => {
              const before = entry.validation?.before_pass_rate;
              const after = entry.validation?.after_pass_rate;
              const net = entry.validation?.net_change;
              return `<div class="artifact">
                <div><strong>${escapeHtml(entry.proposal_id)}</strong></div>
                <div class="muted" style="margin-top:6px;">${escapeHtml(
                  entry.stages
                    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
                    .map(
                      (stage) =>
                        `${stage.stage} ${new Date(stage.timestamp).toLocaleString("en-US")}`,
                    )
                    .join(" \u00b7 "),
                )}</div>
                <div style="margin-top:10px;">
                  <span class="chip">${escapeHtml(entry.target)}</span>
                  ${
                    entry.confidence !== undefined
                      ? `<span class="chip">conf ${entry.confidence.toFixed(2)}</span>`
                      : ""
                  }
                  <span class="chip">before ${before !== undefined ? `${(before * 100).toFixed(1)}%` : "\u2014"}</span>
                  <span class="chip">after ${after !== undefined ? `${(after * 100).toFixed(1)}%` : "\u2014"}</span>
                  <span class="chip">net ${net !== undefined ? `${net >= 0 ? "+" : ""}${(net * 100).toFixed(1)}pp` : "\u2014"}</span>
                </div>
                <p class="muted" style="margin-top:10px;">${escapeHtml(entry.rationale || "No rationale recorded")}</p>
                <div class="diff">
                  <div>
                    <h3 style="font-size:0.8rem;text-transform:uppercase;color:#666;">Original</h3>
                    <pre>${escapeHtml(entry.original_text || "No original text recorded")}</pre>
                  </div>
                  <div>
                    <h3 style="font-size:0.8rem;text-transform:uppercase;color:#666;">Proposed</h3>
                    <pre>${escapeHtml(entry.proposed_text || "No proposed text recorded")}</pre>
                  </div>
                </div>
              </div>`;
            })
            .join("")
    }
  </div>

  <div class="card">
    <h2>Validation Evidence</h2>
    ${
      latestValidation?.validation?.per_entry_results?.length
        ? `<p class="muted">Latest proposal with per-entry validation: ${escapeHtml(latestValidation.proposal_id)}</p>
           <table>
             <tr><th>Query</th><th>Expected</th><th>Before</th><th>After</th><th>Delta</th></tr>
             ${latestValidation.validation.per_entry_results
               .slice(0, 100)
               .map((result) => {
                 const delta =
                   result.before_pass === result.after_pass
                     ? "Unchanged"
                     : result.after_pass
                       ? "New pass"
                       : "Regression";
                 return `<tr>
                   <td>${escapeHtml(result.entry.query)}</td>
                   <td>${result.entry.should_trigger ? "Yes" : "No"}</td>
                   <td>${result.before_pass ? "Yes" : "No"}</td>
                   <td>${result.after_pass ? "Yes" : "No"}</td>
                   <td>${delta}</td>
                 </tr>`;
               })
               .join("")}
           </table>`
        : '<p class="empty">No per-entry validation evidence recorded for this skill yet.</p>'
    }
  </div>
</body>
</html>`;
}

export function handleReport(
  statusResult: StatusResult,
  skillName: string,
  evidenceEntries: EvolutionEvidenceEntry[],
): Response {
  const skill = statusResult.skills.find((s) => s.name === skillName);
  const filteredEvidence = evidenceEntries.filter(
    (entry) => entry.skill_name === skillName,
  );

  if (!skill) {
    return new Response("Skill not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const html = buildReportHTML(skillName, skill, statusResult, filteredEvidence);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
    },
  });
}
