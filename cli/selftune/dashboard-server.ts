/**
 * selftune dashboard server — Bun.serve HTTP server for the SPA dashboard,
 * skill report HTML, badges, and action endpoints.
 *
 * Endpoints:
 *   GET  /                     — Serve dashboard SPA shell
 *   GET  /api/health           — Dashboard server health probe
 *   GET  /api/v2/overview      — SQLite-backed overview payload
 *   GET  /api/v2/skills/:name  — SQLite-backed per-skill report
 *   POST /api/actions/watch    — Trigger `selftune watch` for a skill
 *   POST /api/actions/evolve   — Trigger `selftune evolve` for a skill
 *   POST /api/actions/rollback — Trigger `selftune rollback` for a skill
 *   GET  /badge/:name          — Skill health badge
 *   GET  /report/:name         — Skill health report HTML
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { BadgeData } from "./badge/badge-data.js";
import { findSkillBadgeData } from "./badge/badge-data.js";
import type { BadgeFormat } from "./badge/badge-svg.js";
import { formatBadgeOutput, renderBadgeSvg } from "./badge/badge-svg.js";
import { EVOLUTION_AUDIT_LOG, QUERY_LOG, TELEMETRY_LOG } from "./constants.js";
import type { OverviewResponse, SkillReportResponse } from "./dashboard-contract.js";
import { readEvidenceTrail } from "./evolution/evidence.js";
import { openDb } from "./localdb/db.js";
import { materializeIncremental } from "./localdb/materialize.js";
import {
  getOverviewPayload,
  getPendingProposals,
  getSkillReportPayload,
  getSkillsList,
} from "./localdb/queries.js";
import { doctor } from "./observability.js";
import type { StatusResult } from "./status.js";
import { computeStatus } from "./status.js";
import type {
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  QueryLogRecord,
  SessionTelemetryRecord,
} from "./types.js";
import { readJsonl } from "./utils/jsonl.js";
import { readEffectiveSkillUsageRecords } from "./utils/skill-log.js";

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  spaDir?: string;
  openBrowser?: boolean;
  statusLoader?: () => StatusResult;
  evidenceLoader?: () => EvolutionEvidenceEntry[];
  overviewLoader?: () => OverviewResponse;
  skillReportLoader?: (skillName: string) => SkillReportResponse | null;
  actionRunner?: typeof runAction;
}

/** Read selftune version from package.json once at startup */
let selftuneVersion = "unknown";
try {
  const pkgPath = join(import.meta.dir, "..", "..", "package.json");
  selftuneVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
} catch {
  // fallback already set
}

function findSpaDir(): string | null {
  const candidates = [
    join(dirname(import.meta.dir), "..", "apps", "local-dashboard", "dist"),
    join(dirname(import.meta.dir), "apps", "local-dashboard", "dist"),
    resolve("apps", "local-dashboard", "dist"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return null;
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
};

function computeStatusFromLogs(): StatusResult {
  const telemetry = readJsonl<SessionTelemetryRecord>(TELEMETRY_LOG);
  const skillRecords = readEffectiveSkillUsageRecords();
  const queryRecords = readJsonl<QueryLogRecord>(QUERY_LOG);
  const auditEntries = readJsonl<EvolutionAuditEntry>(EVOLUTION_AUDIT_LOG);
  const doctorResult = doctor();
  return computeStatus(telemetry, skillRecords, queryRecords, auditEntries, doctorResult);
}

interface MergedEvidenceEntry {
  proposal_id: string;
  target: string;
  rationale: string;
  confidence?: number;
  original_text: string;
  proposed_text: string;
  eval_set: import("./types.js").EvalEntry[];
  validation: import("./types.js").EvolutionEvidenceValidation | null;
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

function buildReportHTML(
  skillName: string,
  skill: import("./status.js").SkillStatus,
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
                    .join(" · "),
                )}</div>
                <div style="margin-top:10px;">
                  <span class="chip">${escapeHtml(entry.target)}</span>
                  ${
                    entry.confidence !== undefined
                      ? `<span class="chip">conf ${entry.confidence.toFixed(2)}</span>`
                      : ""
                  }
                  <span class="chip">before ${before !== undefined ? `${(before * 100).toFixed(1)}%` : "—"}</span>
                  <span class="chip">after ${after !== undefined ? `${(after * 100).toFixed(1)}%` : "—"}</span>
                  <span class="chip">net ${net !== undefined ? `${net >= 0 ? "+" : ""}${(net * 100).toFixed(1)}pp` : "—"}</span>
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeParseJson(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function runAction(
  command: string,
  args: string[],
): Promise<{ success: boolean; output: string; error: string | null }> {
  try {
    const indexPath = join(import.meta.dir, "index.ts");
    const proc = Bun.spawn(["bun", "run", indexPath, command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return { success: false, output: stdout, error: stderr || `Exit code ${exitCode}` };
    }
    return { success: true, output: stdout, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: "", error: message };
  }
}

export async function startDashboardServer(
  options?: DashboardServerOptions,
): Promise<{ server: ReturnType<typeof Bun.serve>; stop: () => void; port: number }> {
  const port = options?.port ?? 3141;
  const hostname = options?.host ?? "localhost";
  const openBrowser = options?.openBrowser ?? true;
  const getStatusResult = options?.statusLoader ?? computeStatusFromLogs;
  const getEvidenceEntries = options?.evidenceLoader ?? readEvidenceTrail;
  const getOverviewResponse = options?.overviewLoader;
  const getSkillReportResponse = options?.skillReportLoader;
  const executeAction = options?.actionRunner ?? runAction;

  // -- SPA serving -------------------------------------------------------------
  const requestedSpaDir = options?.spaDir ?? findSpaDir();
  const spaDir =
    requestedSpaDir && existsSync(join(requestedSpaDir, "index.html")) ? requestedSpaDir : null;
  if (spaDir) {
    console.log(`SPA found at ${spaDir}, serving as default dashboard`);
  } else {
    if (options?.spaDir) {
      console.warn(`Configured spaDir is missing index.html: ${options.spaDir}`);
    }
    console.warn(
      "SPA build not found. Run `bun run build:dashboard` before using `selftune dashboard`.",
    );
  }

  // -- SQLite v2 data layer ---------------------------------------------------
  let db: Database | null = null;
  let lastV2MaterializedAt = 0;
  let lastV2RefreshAttemptAt = 0;
  const needsDb = !getOverviewResponse || !getSkillReportResponse;
  if (needsDb) {
    try {
      db = openDb();
      materializeIncremental(db);
      lastV2MaterializedAt = Date.now();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`V2 dashboard data unavailable: ${message}`);
      // Continue serving; refreshV2Data will retry on demand.
    }
  }
  const V2_MATERIALIZE_TTL_MS = 15_000;

  function refreshV2Data(): void {
    if (!db) return;
    const now = Date.now();
    if (now - Math.max(lastV2MaterializedAt, lastV2RefreshAttemptAt) < V2_MATERIALIZE_TTL_MS) {
      return;
    }
    lastV2RefreshAttemptAt = now;
    try {
      materializeIncremental(db);
      lastV2MaterializedAt = now;
    } catch (error: unknown) {
      console.error("Failed to refresh v2 dashboard data", error);
      // Keep serving the last successful materialization.
    }
  }

  let cachedStatusResult: StatusResult | null = null;
  let lastStatusCacheRefreshAt = 0;
  let statusRefreshPromise: Promise<void> | null = null;

  const STATUS_CACHE_TTL_MS = 30_000;

  async function refreshStatusCache(force = false): Promise<void> {
    const cacheIsFresh =
      cachedStatusResult !== null && Date.now() - lastStatusCacheRefreshAt < STATUS_CACHE_TTL_MS;
    if (!force && cacheIsFresh) return;
    if (statusRefreshPromise) return statusRefreshPromise;

    statusRefreshPromise = (async () => {
      cachedStatusResult = getStatusResult();
      lastStatusCacheRefreshAt = Date.now();
    })();

    try {
      await statusRefreshPromise;
    } finally {
      statusRefreshPromise = null;
    }
  }

  async function getCachedStatusResult(): Promise<StatusResult> {
    if (!cachedStatusResult) {
      await refreshStatusCache(true);
    } else {
      void refreshStatusCache(false);
    }
    return cachedStatusResult as StatusResult;
  }

  const server = Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const url = new URL(req.url);

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      if (url.pathname === "/api/health" && req.method === "GET") {
        return Response.json(
          {
            ok: true,
            service: "selftune-dashboard",
            version: selftuneVersion,
            spa: Boolean(spaDir),
            v2_data_available: Boolean(getOverviewResponse || db),
          },
          { headers: corsHeaders() },
        );
      }

      // ---- SPA static assets ---- Serve from dist/assets/
      if (spaDir && req.method === "GET" && url.pathname.startsWith("/assets/")) {
        const filePath = resolve(spaDir, `.${url.pathname}`);
        const rel = relative(spaDir, filePath);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          return new Response("Not Found", { status: 404, headers: corsHeaders() });
        }
        const bunFile = Bun.file(filePath);
        if (await bunFile.exists()) {
          const ext = extname(filePath);
          const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
          return new Response(bunFile, {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
              ...corsHeaders(),
            },
          });
        }
        return new Response("Not Found", { status: 404, headers: corsHeaders() });
      }

      // ---- GET / ---- Serve SPA shell
      if (url.pathname === "/" && req.method === "GET") {
        if (spaDir) {
          const html = await Bun.file(join(spaDir, "index.html")).text();
          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
          });
        }
        return new Response("Dashboard build not found. Run `bun run build:dashboard` first.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders() },
        });
      }

      // ---- POST /api/actions/watch ----
      if (url.pathname === "/api/actions/watch" && req.method === "POST") {
        const body = (await req.json()) as { skill?: string; skillPath?: string };
        if (!body.skill || !body.skillPath) {
          return Response.json(
            { success: false, error: "Missing required fields: skill, skillPath" },
            { status: 400, headers: corsHeaders() },
          );
        }
        const args = ["--skill", body.skill, "--skill-path", body.skillPath, "--sync-first"];
        const result = await executeAction("watch", args);
        return Response.json(result, { headers: corsHeaders() });
      }

      // ---- POST /api/actions/evolve ----
      if (url.pathname === "/api/actions/evolve" && req.method === "POST") {
        const body = (await req.json()) as { skill?: string; skillPath?: string };
        if (!body.skill || !body.skillPath) {
          return Response.json(
            { success: false, error: "Missing required fields: skill, skillPath" },
            { status: 400, headers: corsHeaders() },
          );
        }
        const args = ["--skill", body.skill, "--skill-path", body.skillPath, "--sync-first"];
        const result = await executeAction("evolve", args);
        return Response.json(result, { headers: corsHeaders() });
      }

      // ---- POST /api/actions/rollback ----
      if (url.pathname === "/api/actions/rollback" && req.method === "POST") {
        const body = (await req.json()) as {
          skill?: string;
          skillPath?: string;
          proposalId?: string;
        };
        if (!body.skill || !body.skillPath || !body.proposalId) {
          return Response.json(
            { success: false, error: "Missing required fields: skill, skillPath, proposalId" },
            { status: 400, headers: corsHeaders() },
          );
        }
        const args = [
          "--skill",
          body.skill,
          "--skill-path",
          body.skillPath,
          "--proposal-id",
          body.proposalId,
        ];
        const result = await executeAction("rollback", args);
        return Response.json(result, { headers: corsHeaders() });
      }

      // ---- GET /badge/:skillName ---- Badge SVG
      if (url.pathname.startsWith("/badge/") && req.method === "GET") {
        const skillName = decodePathSegment(url.pathname.slice("/badge/".length));
        if (skillName === null) {
          return Response.json(
            { error: "Malformed skill name" },
            { status: 400, headers: corsHeaders() },
          );
        }
        const formatParam = url.searchParams.get("format");
        const validFormats = new Set(["svg", "markdown", "url"]);
        const format: BadgeFormat =
          formatParam && validFormats.has(formatParam) ? (formatParam as BadgeFormat) : "svg";

        const statusResult = await getCachedStatusResult();
        const badgeData = findSkillBadgeData(statusResult, skillName);

        if (!badgeData) {
          // Return a gray "not found" badge (format-aware)
          const notFoundData: BadgeData = {
            label: "Skill Health",
            passRate: null,
            trend: "unknown",
            status: "UNKNOWN",
            color: "#9f9f9f",
            message: "not found",
          };
          if (format === "markdown" || format === "url") {
            const output = formatBadgeOutput(notFoundData, skillName, format);
            return new Response(output, {
              status: 404,
              headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Cache-Control": "no-cache, no-store",
                ...corsHeaders(),
              },
            });
          }
          const svg = renderBadgeSvg(notFoundData);
          return new Response(svg, {
            status: 404,
            headers: {
              "Content-Type": "image/svg+xml",
              "Cache-Control": "no-cache, no-store",
              ...corsHeaders(),
            },
          });
        }

        if (format === "markdown" || format === "url") {
          const output = formatBadgeOutput(badgeData, skillName, format);
          return new Response(output, {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-cache, no-store",
              ...corsHeaders(),
            },
          });
        }

        const svg = renderBadgeSvg(badgeData);
        return new Response(svg, {
          headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "no-cache, no-store",
            ...corsHeaders(),
          },
        });
      }

      // ---- GET /report/:skillName ---- Skill health report
      if (url.pathname.startsWith("/report/") && req.method === "GET") {
        const skillName = decodePathSegment(url.pathname.slice("/report/".length));
        if (skillName === null) {
          return Response.json(
            { error: "Malformed skill name" },
            { status: 400, headers: corsHeaders() },
          );
        }
        const statusResult = await getCachedStatusResult();
        const skill = statusResult.skills.find((s) => s.name === skillName);
        const evidenceEntries = getEvidenceEntries().filter(
          (entry) => entry.skill_name === skillName,
        );

        if (!skill) {
          return new Response("Skill not found", {
            status: 404,
            headers: { "Content-Type": "text/plain", ...corsHeaders() },
          });
        }

        const html = buildReportHTML(skillName, skill, statusResult, evidenceEntries);
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache, no-store",
            ...corsHeaders(),
          },
        });
      }

      // ---- GET /api/v2/overview ---- SQLite-backed overview
      if (url.pathname === "/api/v2/overview" && req.method === "GET") {
        if (getOverviewResponse) {
          return Response.json(getOverviewResponse(), { headers: corsHeaders() });
        }
        if (!db) {
          return Response.json(
            { error: "V2 data unavailable" },
            { status: 503, headers: corsHeaders() },
          );
        }
        refreshV2Data();
        const overview = getOverviewPayload(db);
        const skills = getSkillsList(db);
        return Response.json(
          { overview, skills, version: selftuneVersion },
          { headers: corsHeaders() },
        );
      }

      // ---- GET /api/v2/skills/:name ---- SQLite-backed skill report
      if (url.pathname.startsWith("/api/v2/skills/") && req.method === "GET") {
        const skillName = decodePathSegment(url.pathname.slice("/api/v2/skills/".length));
        if (skillName === null) {
          return Response.json(
            { error: "Malformed skill name" },
            { status: 400, headers: corsHeaders() },
          );
        }
        if (getSkillReportResponse) {
          const report = getSkillReportResponse(skillName);
          if (!report) {
            return Response.json(
              { error: "Skill not found" },
              { status: 404, headers: corsHeaders() },
            );
          }
          return Response.json(report, { headers: corsHeaders() });
        }
        if (!db) {
          return Response.json(
            { error: "V2 data unavailable" },
            { status: 503, headers: corsHeaders() },
          );
        }
        refreshV2Data();
        const report = getSkillReportPayload(db, skillName);

        // 1. Evolution audit with eval_snapshot
        const evolution = db
          .query(
            `SELECT timestamp, proposal_id, action, details, eval_snapshot_json
             FROM evolution_audit
             WHERE skill_name = ?
             ORDER BY timestamp DESC
             LIMIT 100`,
          )
          .all(skillName) as Array<{
          timestamp: string;
          proposal_id: string;
          action: string;
          details: string;
          eval_snapshot_json: string | null;
        }>;
        const evolutionWithSnapshot = evolution.map((e) => ({
          ...e,
          eval_snapshot: e.eval_snapshot_json ? safeParseJson(e.eval_snapshot_json) : null,
          eval_snapshot_json: undefined,
        }));

        // 2. Pending proposals (shared helper from queries.ts)
        const pending_proposals = getPendingProposals(db, skillName);

        // CTE subquery for session IDs — avoids expanding bind parameters
        const skillSessionsCte = `
          WITH skill_sessions AS (
            SELECT DISTINCT session_id FROM skill_usage WHERE skill_name = ?
          )`;

        // 3. Token usage aggregated from sessions that used this skill
        const tokenUsage = db
          .query(
            `${skillSessionsCte}
             SELECT
               COALESCE(SUM(st.input_tokens), 0) as total_input_tokens,
               COALESCE(SUM(st.output_tokens), 0) as total_output_tokens
             FROM session_telemetry st
             WHERE st.session_id IN (SELECT session_id FROM skill_sessions)`,
          )
          .get(skillName) as { total_input_tokens: number; total_output_tokens: number };

        // 4. Skill invocations with confidence scores
        const invocationsWithConfidence = db
          .query(
            `SELECT si.occurred_at as timestamp, si.session_id, si.skill_name,
                    si.invocation_mode, si.triggered, si.confidence, si.tool_name
             FROM skill_invocations si
             WHERE si.skill_name = ?
             ORDER BY si.occurred_at DESC
             LIMIT 100`,
          )
          .all(skillName) as Array<{
          timestamp: string;
          session_id: string;
          skill_name: string;
          invocation_mode: string | null;
          triggered: number;
          confidence: number | null;
          tool_name: string | null;
        }>;

        // Not-found check — after all enrichment queries so evidence-only skills aren't 404'd
        const hasData =
          report.usage.total_checks > 0 ||
          report.recent_invocations.length > 0 ||
          report.evidence.length > 0 ||
          evolution.length > 0 ||
          pending_proposals.length > 0 ||
          invocationsWithConfidence.length > 0;
        if (!hasData) {
          return Response.json(
            { error: "Skill not found" },
            { status: 404, headers: corsHeaders() },
          );
        }

        // 5. Duration stats from execution_facts for sessions using this skill
        const durationStats = db
          .query(
            `${skillSessionsCte}
             SELECT
               COALESCE(AVG(ef.duration_ms), 0) as avg_duration_ms,
               COALESCE(SUM(ef.duration_ms), 0) as total_duration_ms,
               COUNT(*) as execution_count,
               COALESCE(SUM(ef.errors_encountered), 0) as total_errors
             FROM execution_facts ef
             WHERE ef.session_id IN (SELECT session_id FROM skill_sessions)`,
          )
          .get(skillName) as {
          avg_duration_ms: number;
          total_duration_ms: number;
          execution_count: number;
          total_errors: number;
        };

        // 6. Prompt texts from sessions that invoked this skill
        const promptSamples = db
          .query(
            `${skillSessionsCte}
             SELECT p.prompt_text, p.prompt_kind, p.is_actionable, p.occurred_at, p.session_id
             FROM prompts p
             WHERE p.session_id IN (SELECT session_id FROM skill_sessions)
               AND p.prompt_text IS NOT NULL
               AND p.prompt_text != ''
             ORDER BY p.occurred_at DESC
             LIMIT 50`,
          )
          .all(skillName) as Array<{
          prompt_text: string;
          prompt_kind: string | null;
          is_actionable: number;
          occurred_at: string;
          session_id: string;
        }>;

        // 7. Session metadata for sessions that used this skill
        const sessionMeta = db
          .query(
            `${skillSessionsCte}
             SELECT s.session_id, s.platform, s.model, s.agent_cli, s.branch,
                    s.workspace_path, s.started_at, s.ended_at, s.completion_status
             FROM sessions s
             WHERE s.session_id IN (SELECT session_id FROM skill_sessions)
             ORDER BY s.started_at DESC
             LIMIT 50`,
          )
          .all(skillName) as Array<{
          session_id: string;
          platform: string | null;
          model: string | null;
          agent_cli: string | null;
          branch: string | null;
          workspace_path: string | null;
          started_at: string | null;
          ended_at: string | null;
          completion_status: string | null;
        }>;

        return Response.json(
          {
            ...report,
            evolution: evolutionWithSnapshot,
            pending_proposals,
            token_usage: tokenUsage,
            canonical_invocations: invocationsWithConfidence.map((i) => ({
              ...i,
              triggered: i.triggered === 1,
            })),
            duration_stats: durationStats,
            prompt_samples: promptSamples.map((p) => ({
              ...p,
              is_actionable: p.is_actionable === 1,
            })),
            session_metadata: sessionMeta,
          },
          { headers: corsHeaders() },
        );
      }

      // ---- SPA fallback ---- Serve index.html for client-side routes
      if (spaDir && req.method === "GET" && !url.pathname.startsWith("/api/")) {
        const html = await Bun.file(join(spaDir, "index.html")).text();
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
        });
      }

      // ---- 404 ----
      return new Response("Not Found", { status: 404, headers: corsHeaders() });
    },
  });

  const boundPort = server.port;

  if (openBrowser) {
    const url = `http://${hostname}:${boundPort}`;
    console.log(`selftune dashboard server running at ${url}`);
    try {
      const platform = process.platform;
      if (platform === "darwin") {
        Bun.spawn(["open", url]);
      } else if (platform === "linux") {
        Bun.spawn(["xdg-open", url]);
      } else if (platform === "win32") {
        Bun.spawn(["cmd", "/c", "start", "", url]);
      }
    } catch {
      console.log(`Open manually: ${url}`);
    }
  }

  // Graceful shutdown
  const shutdownHandler = () => {
    db?.close();
    server.stop();
  };

  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);

  return {
    server,
    stop: () => {
      process.removeListener("SIGINT", shutdownHandler);
      process.removeListener("SIGTERM", shutdownHandler);
      shutdownHandler();
    },
    port: boundPort,
  };
}
