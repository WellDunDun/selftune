/**
 * selftune dashboard server — Live Bun.serve HTTP server with SSE, data API,
 * and action endpoints for the interactive dashboard.
 *
 * Endpoints:
 *   GET  /              — Serve dashboard HTML shell + live mode flag
 *   GET  /api/data      — JSON endpoint returning current telemetry data
 *   GET  /api/events    — SSE stream sending data updates every 5 seconds
 *   POST /api/actions/watch    — Trigger `selftune watch` for a skill
 *   POST /api/actions/evolve   — Trigger `selftune evolve` for a skill
 *   POST /api/actions/rollback — Trigger `selftune rollback` for a skill
 *   GET  /api/v2/overview     — SQLite-backed overview payload
 *   GET  /api/v2/skills/:name — SQLite-backed per-skill report
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { BadgeData } from "./badge/badge-data.js";
import { findSkillBadgeData } from "./badge/badge-data.js";
import type { BadgeFormat } from "./badge/badge-svg.js";
import { formatBadgeOutput, renderBadgeSvg } from "./badge/badge-svg.js";
import { EVOLUTION_AUDIT_LOG, QUERY_LOG, TELEMETRY_LOG } from "./constants.js";
import { getLastDeployedProposal } from "./evolution/audit.js";
import { readEvidenceTrail } from "./evolution/evidence.js";
import { openDb } from "./localdb/db.js";
import { materializeIncremental } from "./localdb/materialize.js";
import { getOverviewPayload, getSkillReportPayload, getSkillsList } from "./localdb/queries.js";
import { readDecisions } from "./memory/writer.js";
import { computeMonitoringSnapshot } from "./monitoring/watch.js";
import { doctor } from "./observability.js";
import type { StatusResult } from "./status.js";
import { computeStatus, DEFAULT_WINDOW_SESSIONS } from "./status.js";
import type {
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "./types.js";
import { readJsonl } from "./utils/jsonl.js";
import {
  filterActionableQueryRecords,
  filterActionableSkillUsageRecords,
} from "./utils/query-filter.js";
import { readEffectiveSkillUsageRecords } from "./utils/skill-log.js";

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  openBrowser?: boolean;
  dataLoader?: () => DashboardData;
  statusLoader?: () => StatusResult;
  evidenceLoader?: () => EvolutionEvidenceEntry[];
  actionRunner?: typeof runAction;
}

const LIVE_CACHE_TTL_MS = 30_000;

interface DashboardData {
  telemetry: SessionTelemetryRecord[];
  skills: SkillUsageRecord[];
  queries: QueryLogRecord[];
  evolution: EvolutionAuditEntry[];
  evidence: EvolutionEvidenceEntry[];
  decisions: import("./types.js").DecisionRecord[];
  computed: {
    snapshots: Record<string, ReturnType<typeof computeMonitoringSnapshot>>;
    unmatched: Array<{ timestamp: string; session_id: string; query: string }>;
    pendingProposals: EvolutionAuditEntry[];
  };
}

interface LiveDashboardPayload {
  telemetry: Array<
    Pick<
      SessionTelemetryRecord,
      "timestamp" | "session_id" | "skills_triggered" | "errors_encountered" | "total_tool_calls"
    >
  >;
  skills: Array<
    Pick<
      SkillUsageRecord,
      "timestamp" | "session_id" | "skill_name" | "skill_path" | "query" | "triggered" | "source"
    >
  >;
  queries: Array<Pick<QueryLogRecord, never>>;
  evolution: Array<Pick<EvolutionAuditEntry, "timestamp" | "proposal_id" | "action" | "details">>;
  evidence: Array<Pick<EvolutionEvidenceEntry, never>>;
  decisions: DashboardData["decisions"];
  computed: DashboardData["computed"] & { unmatched_count: number };
  counts: {
    telemetry: number;
    skills: number;
    queries: number;
    evolution: number;
    evidence: number;
    decisions: number;
  };
}

function findViewerHTML(): string {
  const candidates = [
    join(dirname(import.meta.dir), "..", "dashboard", "index.html"),
    join(dirname(import.meta.dir), "dashboard", "index.html"),
    resolve("dashboard", "index.html"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error("Could not find dashboard/index.html. Ensure it exists in the selftune repo.");
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

function collectData(): DashboardData {
  const telemetry = readJsonl<SessionTelemetryRecord>(TELEMETRY_LOG);
  const skills = filterActionableSkillUsageRecords(readEffectiveSkillUsageRecords());
  const queries = readJsonl<QueryLogRecord>(QUERY_LOG);
  const actionableQueries = filterActionableQueryRecords(queries);
  const evolution = readJsonl<EvolutionAuditEntry>(EVOLUTION_AUDIT_LOG);
  const evidence = readEvidenceTrail();
  const decisions = readDecisions();

  // Compute per-skill monitoring snapshots
  const skillNames = [...new Set(skills.map((r) => r.skill_name))];
  const snapshots: Record<string, ReturnType<typeof computeMonitoringSnapshot>> = {};
  for (const name of skillNames) {
    const lastDeployed = getLastDeployedProposal(name);
    const baselinePassRate = lastDeployed?.eval_snapshot?.pass_rate ?? 0.5;
    snapshots[name] = computeMonitoringSnapshot(
      name,
      telemetry,
      skills,
      actionableQueries,
      DEFAULT_WINDOW_SESSIONS,
      baselinePassRate,
    );
  }

  // Compute unmatched queries
  const triggeredQueries = new Set(
    skills
      .filter((r) => r.triggered && typeof r.query === "string")
      .map((r) => r.query.toLowerCase().trim()),
  );
  const unmatched = actionableQueries
    .filter((q) => !triggeredQueries.has(q.query.toLowerCase().trim()))
    .map((q) => ({
      timestamp: q.timestamp,
      session_id: q.session_id,
      query: q.query,
    }));

  // Compute pending proposals (reuse already-loaded evolution entries)
  const proposalStatus: Record<string, string[]> = {};
  for (const e of evolution) {
    if (!proposalStatus[e.proposal_id]) proposalStatus[e.proposal_id] = [];
    proposalStatus[e.proposal_id].push(e.action);
  }
  const terminalActions = new Set(["deployed", "rejected", "rolled_back"]);
  const seenProposals = new Set<string>();
  const pendingProposals = evolution.filter((e) => {
    if (e.action !== "created" && e.action !== "validated") return false;
    if (seenProposals.has(e.proposal_id)) return false;
    const actions = proposalStatus[e.proposal_id] || [];
    const isPending = !actions.some((a: string) => terminalActions.has(a));
    if (isPending) seenProposals.add(e.proposal_id);
    return isPending;
  });

  return {
    telemetry,
    skills,
    queries: actionableQueries,
    evolution,
    evidence,
    decisions,
    computed: { snapshots, unmatched, pendingProposals },
  };
}

function computeStatusFromLogs(): StatusResult {
  const telemetry = readJsonl<SessionTelemetryRecord>(TELEMETRY_LOG);
  const skillRecords = readEffectiveSkillUsageRecords();
  const queryRecords = readJsonl<QueryLogRecord>(QUERY_LOG);
  const auditEntries = readJsonl<EvolutionAuditEntry>(EVOLUTION_AUDIT_LOG);
  const doctorResult = doctor();
  return computeStatus(telemetry, skillRecords, queryRecords, auditEntries, doctorResult);
}

function buildLivePayload(data: DashboardData): LiveDashboardPayload {
  return {
    telemetry: data.telemetry.map((record) => ({
      timestamp: record.timestamp,
      session_id: record.session_id,
      skills_triggered: record.skills_triggered,
      errors_encountered: record.errors_encountered,
      total_tool_calls: record.total_tool_calls,
    })),
    skills: data.skills.map((record) => ({
      timestamp: record.timestamp,
      session_id: record.session_id,
      skill_name: record.skill_name,
      skill_path: record.skill_path,
      query: record.query,
      triggered: record.triggered,
      source: record.source,
    })),
    queries: [],
    evolution: data.evolution.map((record) => ({
      timestamp: record.timestamp,
      proposal_id: record.proposal_id,
      action: record.action,
      details: record.details,
    })),
    evidence: [],
    decisions: data.decisions,
    computed: {
      ...data.computed,
      unmatched: data.computed.unmatched.slice(0, 500),
      unmatched_count: data.computed.unmatched.length,
    },
    counts: {
      telemetry: data.telemetry.length,
      skills: data.skills.length,
      queries: data.queries.length,
      evolution: data.evolution.length,
      evidence: data.evidence.length,
      decisions: data.decisions.length,
    },
  };
}

function buildLiveHTML(): string {
  const template = readFileSync(findViewerHTML(), "utf-8");
  const liveFlag = "<script>window.__SELFTUNE_LIVE__ = true;</script>";

  return template.replace("</body>", `${liveFlag}\n</body>`);
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
  const getDashboardData = options?.dataLoader ?? collectData;
  const getStatusResult = options?.statusLoader ?? computeStatusFromLogs;
  const getEvidenceEntries = options?.evidenceLoader ?? readEvidenceTrail;
  const executeAction = options?.actionRunner ?? runAction;

  // -- SPA serving -------------------------------------------------------------
  const spaDir = findSpaDir();
  if (spaDir) {
    console.log(`SPA found at ${spaDir}, serving as default dashboard`);
  } else {
    console.log("SPA build not found, serving legacy dashboard at /");
  }

  // -- SQLite v2 data layer ---------------------------------------------------
  const db: Database = openDb();
  materializeIncremental(db);
  let lastV2MaterializedAt = Date.now();
  const V2_MATERIALIZE_TTL_MS = 15_000;

  function refreshV2Data(): void {
    if (Date.now() - lastV2MaterializedAt < V2_MATERIALIZE_TTL_MS) return;
    try {
      materializeIncremental(db);
      lastV2MaterializedAt = Date.now();
    } catch (error) {
      console.error("Failed to refresh v2 dashboard data", error);
      // Keep serving the last successful materialization.
    }
  }

  const sseClients = new Set<ReadableStreamDefaultController>();
  let cachedDashboardData: DashboardData | null = null;
  let cachedLivePayload: LiveDashboardPayload | null = null;
  let cachedStatusResult: StatusResult | null = null;
  let lastDataCacheRefreshAt = 0;
  let lastStatusCacheRefreshAt = 0;
  let dataRefreshPromise: Promise<void> | null = null;
  let statusRefreshPromise: Promise<void> | null = null;

  async function refreshLiveCache(force = false): Promise<void> {
    const cacheIsFresh =
      cachedDashboardData !== null && Date.now() - lastDataCacheRefreshAt < LIVE_CACHE_TTL_MS;
    if (!force && cacheIsFresh) return;
    if (dataRefreshPromise) return dataRefreshPromise;

    dataRefreshPromise = (async () => {
      const data = getDashboardData();
      cachedDashboardData = data;
      cachedLivePayload = buildLivePayload(data);
      lastDataCacheRefreshAt = Date.now();
    })();

    try {
      await dataRefreshPromise;
    } finally {
      dataRefreshPromise = null;
    }
  }

  async function refreshStatusCache(force = false): Promise<void> {
    const cacheIsFresh =
      cachedStatusResult !== null && Date.now() - lastStatusCacheRefreshAt < LIVE_CACHE_TTL_MS;
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

  async function getCachedLivePayload(): Promise<LiveDashboardPayload> {
    if (!cachedLivePayload) {
      await refreshLiveCache(true);
    } else {
      void refreshLiveCache(false);
    }
    return cachedLivePayload as LiveDashboardPayload;
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

      // ---- SPA static assets ---- Serve from dist/assets/
      if (spaDir && req.method === "GET" && url.pathname.startsWith("/assets/")) {
        const filePath = resolve(spaDir, `.${url.pathname}`);
        const rel = relative(spaDir, filePath);
        if (
          !rel.startsWith("..") &&
          !isAbsolute(rel) &&
          existsSync(filePath) &&
          statSync(filePath).isFile()
        ) {
          const ext = extname(filePath);
          const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
          const file = readFileSync(filePath);
          return new Response(file, {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
              ...corsHeaders(),
            },
          });
        }
      }

      // ---- GET / ---- Serve SPA (or legacy fallback)
      if (url.pathname === "/" && req.method === "GET") {
        if (spaDir) {
          const html = readFileSync(join(spaDir, "index.html"), "utf-8");
          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
          });
        }
        const html = buildLiveHTML();
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
        });
      }

      // ---- GET /legacy/ ---- Serve old dashboard HTML
      if (url.pathname === "/legacy/" && req.method === "GET") {
        const html = buildLiveHTML();
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
        });
      }

      // ---- GET /api/data ---- JSON data endpoint
      if (url.pathname === "/api/data" && req.method === "GET") {
        const payload = await getCachedLivePayload();
        return Response.json(payload, { headers: corsHeaders() });
      }

      // ---- GET /api/events ---- SSE stream
      if (url.pathname === "/api/events" && req.method === "GET") {
        const stream = new ReadableStream({
          async start(controller) {
            sseClients.add(controller);

            // Send initial data immediately
            const initialPayload = await getCachedLivePayload();
            const payload = `event: data\ndata: ${JSON.stringify(initialPayload)}\n\n`;
            controller.enqueue(new TextEncoder().encode(payload));

            // Set up periodic updates every 5 seconds
            const interval = setInterval(async () => {
              try {
                const freshPayload = await getCachedLivePayload();
                const msg = `event: data\ndata: ${JSON.stringify(freshPayload)}\n\n`;
                controller.enqueue(new TextEncoder().encode(msg));
              } catch {
                clearInterval(interval);
                sseClients.delete(controller);
              }
            }, 5000);

            // Clean up when client disconnects
            req.signal.addEventListener("abort", () => {
              clearInterval(interval);
              sseClients.delete(controller);
              try {
                controller.close();
              } catch {
                // already closed
              }
            });
          },
          cancel() {
            // Stream cancelled by client
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...corsHeaders(),
          },
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
        const skillName = decodeURIComponent(url.pathname.slice("/badge/".length));
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
        const skillName = decodeURIComponent(url.pathname.slice("/report/".length));
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

      // ---- GET /api/evaluations/:skillName ----
      if (url.pathname.startsWith("/api/evaluations/") && req.method === "GET") {
        const skillName = decodeURIComponent(url.pathname.slice("/api/evaluations/".length));
        const skills = readEffectiveSkillUsageRecords();
        const filtered = skills
          .filter((r) => r.skill_name === skillName)
          .map((r) => ({
            timestamp: r.timestamp,
            session_id: r.session_id,
            query: r.query,
            skill_name: r.skill_name,
            triggered: r.triggered,
            source: r.source ?? null,
          }));
        return Response.json(filtered, { headers: corsHeaders() });
      }

      // ---- GET /api/v2/overview ---- SQLite-backed overview
      if (url.pathname === "/api/v2/overview" && req.method === "GET") {
        refreshV2Data();
        const overview = getOverviewPayload(db);
        const skills = getSkillsList(db);
        return Response.json({ overview, skills }, { headers: corsHeaders() });
      }

      // ---- GET /api/v2/skills/:name ---- SQLite-backed skill report
      if (url.pathname.startsWith("/api/v2/skills/") && req.method === "GET") {
        const skillName = decodeURIComponent(url.pathname.slice("/api/v2/skills/".length));
        refreshV2Data();
        const report = getSkillReportPayload(db, skillName);
        if (report.usage.total_checks === 0 && report.recent_invocations.length === 0) {
          return Response.json(
            { error: "Skill not found" },
            { status: 404, headers: corsHeaders() },
          );
        }

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

        // 2. Pending proposals
        const pendingRows = db
          .query(
            `SELECT ea.proposal_id, ea.action, ea.timestamp, ea.details, ea.skill_name
             FROM evolution_audit ea
             WHERE ea.skill_name = ?
               AND ea.action IN ('created', 'validated')
               AND ea.proposal_id NOT IN (
                 SELECT ea2.proposal_id FROM evolution_audit ea2
                 WHERE ea2.action IN ('deployed', 'rejected', 'rolled_back')
               )
             ORDER BY ea.timestamp DESC`,
          )
          .all(skillName) as Array<{
          proposal_id: string;
          action: string;
          timestamp: string;
          details: string;
          skill_name: string;
        }>;
        const seenIds = new Set<string>();
        const pending_proposals = pendingRows.filter((row) => {
          if (seenIds.has(row.proposal_id)) return false;
          seenIds.add(row.proposal_id);
          return true;
        });

        // 3. Token usage aggregated from sessions that used this skill
        const tokenUsage = db
          .query(
            `SELECT
               COALESCE(SUM(st.input_tokens), 0) as total_input_tokens,
               COALESCE(SUM(st.output_tokens), 0) as total_output_tokens
             FROM session_telemetry st
             WHERE st.session_id IN (
               SELECT DISTINCT session_id FROM skill_usage WHERE skill_name = ?
             )`,
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

        // 5. Duration stats from execution_facts for sessions using this skill
        const durationStats = db
          .query(
            `SELECT
               COALESCE(AVG(ef.duration_ms), 0) as avg_duration_ms,
               COALESCE(SUM(ef.duration_ms), 0) as total_duration_ms,
               COUNT(*) as execution_count,
               COALESCE(SUM(ef.errors_encountered), 0) as total_errors
             FROM execution_facts ef
             WHERE ef.session_id IN (
               SELECT DISTINCT session_id FROM skill_usage WHERE skill_name = ?
             )`,
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
            `SELECT p.prompt_text, p.prompt_kind, p.is_actionable, p.occurred_at, p.session_id
             FROM prompts p
             WHERE p.session_id IN (
               SELECT DISTINCT session_id FROM skill_usage WHERE skill_name = ?
             )
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
            `SELECT s.session_id, s.platform, s.model, s.agent_cli, s.branch,
                    s.workspace_path, s.started_at, s.ended_at, s.completion_status
             FROM sessions s
             WHERE s.session_id IN (
               SELECT DISTINCT session_id FROM skill_usage WHERE skill_name = ?
             )
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
        const html = readFileSync(join(spaDir, "index.html"), "utf-8");
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
    for (const client of sseClients) {
      try {
        client.close();
      } catch {
        // already closed
      }
    }
    sseClients.clear();
    db.close();
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
