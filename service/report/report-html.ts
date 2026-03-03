/**
 * HTML report page renderer for skill health reports.
 *
 * Generates a standalone HTML page showing skill health metrics,
 * with an embedded badge image from /badge/:skillName.
 */

import type { AggregatedSkillData } from "../types.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderReportHTML(data: AggregatedSkillData): string {
  const passRateDisplay = data.session_count > 0
    ? `${Math.round(data.weighted_pass_rate * 100)}%`
    : "No data";
  const trendArrows: Record<string, string> = { up: "\u2191", down: "\u2193", stable: "\u2192", unknown: "?" };
  const trendDisplay = trendArrows[data.trend] ?? "?";
  const statusColor = data.status === "HEALTHY" ? "#4c1" : data.status === "REGRESSED" ? "#e05d44" : "#9f9f9f";
  const encodedName = encodeURIComponent(data.skill_name);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>selftune report: ${escapeHtml(data.skill_name)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #333; background: #fafafa; }
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
    .status-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; color: #fff; font-size: 0.85rem; font-weight: 600; }
    .embed-code { background: #f5f5f5; padding: 12px; border-radius: 4px; font-family: monospace; font-size: 0.85rem; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>Skill Report: ${escapeHtml(data.skill_name)}</h1>
  <div class="badge">
    <img src="/badge/${encodedName}" alt="Skill Health Badge" />
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
      <div class="stat-value">${data.contributor_count}</div>
      <div class="stat-label">Contributors</div>
    </div>
    <div class="stat">
      <div class="stat-value">${data.session_count}</div>
      <div class="stat-label">Sessions</div>
    </div>
    <div class="stat">
      <span class="status-badge" style="background: ${statusColor}">${data.status}</span>
    </div>
  </div>

  <div class="card">
    <h2>Embed This Badge</h2>
    <p>Add to your skill's README:</p>
    <div class="embed-code">
      ![Skill Health](https://selftune.dev/badge/${encodedName})
    </div>
  </div>

  <div class="card">
    <h2>Details</h2>
    <table>
      <tr><th>Metric</th><th>Value</th></tr>
      <tr><td>Weighted Pass Rate</td><td>${(data.weighted_pass_rate * 100).toFixed(1)}%</td></tr>
      <tr><td>Trend</td><td>${data.trend}</td></tr>
      <tr><td>Status</td><td>${data.status}</td></tr>
      <tr><td>Contributors</td><td>${data.contributor_count}</td></tr>
      <tr><td>Total Sessions</td><td>${data.session_count}</td></tr>
      <tr><td>Last Updated</td><td>${data.last_updated}</td></tr>
    </table>
  </div>
</body>
</html>`;
}
