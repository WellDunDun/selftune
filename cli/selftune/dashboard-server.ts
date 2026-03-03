/**
 * selftune dashboard server — Live Bun.serve HTTP server with SSE, data API,
 * and action endpoints for the interactive dashboard.
 *
 * Endpoints:
 *   GET  /              — Serve dashboard HTML with embedded data + live mode flag
 *   GET  /api/data      — JSON endpoint returning current telemetry data
 *   GET  /api/events    — SSE stream sending data updates every 5 seconds
 *   POST /api/actions/watch    — Trigger `selftune watch` for a skill
 *   POST /api/actions/evolve   — Trigger `selftune evolve` for a skill
 *   POST /api/actions/rollback — Trigger `selftune rollback` for a skill
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EVOLUTION_AUDIT_LOG, QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "./constants.js";
import { getLastDeployedProposal } from "./evolution/audit.js";
import { readDecisions } from "./memory/writer.js";
import { computeMonitoringSnapshot } from "./monitoring/watch.js";
import { computeStatus } from "./status.js";
import type { StatusResult } from "./status.js";
import { doctor } from "./observability.js";
import { findSkillBadgeData } from "./badge/badge-data.js";
import type { BadgeData } from "./badge/badge-data.js";
import { renderBadgeSvg, formatBadgeOutput } from "./badge/badge-svg.js";
import type { BadgeFormat } from "./badge/badge-svg.js";
import type {
  EvolutionAuditEntry,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "./types.js";
import { readJsonl } from "./utils/jsonl.js";

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  openBrowser?: boolean;
}

interface DashboardData {
  telemetry: SessionTelemetryRecord[];
  skills: SkillUsageRecord[];
  queries: QueryLogRecord[];
  evolution: EvolutionAuditEntry[];
  decisions: import("./types.js").DecisionRecord[];
  computed: {
    snapshots: Record<string, ReturnType<typeof computeMonitoringSnapshot>>;
    unmatched: Array<{ timestamp: string; session_id: string; query: string }>;
    pendingProposals: EvolutionAuditEntry[];
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

function collectData(): DashboardData {
  const telemetry = readJsonl<SessionTelemetryRecord>(TELEMETRY_LOG);
  const skills = readJsonl<SkillUsageRecord>(SKILL_LOG);
  const queries = readJsonl<QueryLogRecord>(QUERY_LOG);
  const evolution = readJsonl<EvolutionAuditEntry>(EVOLUTION_AUDIT_LOG);
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
      queries,
      telemetry.length,
      baselinePassRate,
    );
  }

  // Compute unmatched queries
  const triggeredQueries = new Set(
    skills.filter((r) => r.triggered).map((r) => r.query.toLowerCase().trim()),
  );
  const unmatched = queries
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
    queries,
    evolution,
    decisions,
    computed: { snapshots, unmatched, pendingProposals },
  };
}

function computeStatusFromLogs(): StatusResult {
  const telemetry = readJsonl<SessionTelemetryRecord>(TELEMETRY_LOG);
  const skillRecords = readJsonl<SkillUsageRecord>(SKILL_LOG);
  const queryRecords = readJsonl<QueryLogRecord>(QUERY_LOG);
  const auditEntries = readJsonl<EvolutionAuditEntry>(EVOLUTION_AUDIT_LOG);
  const doctorResult = doctor();
  return computeStatus(telemetry, skillRecords, queryRecords, auditEntries, doctorResult);
}

function buildLiveHTML(data: DashboardData): string {
  const template = readFileSync(findViewerHTML(), "utf-8");

  // Escape </script> sequences to prevent XSS via embedded JSON
  const safeJson = JSON.stringify(data).replace(/<\/script>/gi, "<\\/script>");
  const liveFlag = "<script>window.__SELFTUNE_LIVE__ = true;</script>";
  const dataScript = `<script id="embedded-data" type="application/json">${safeJson}</script>`;

  return template.replace("</body>", `${liveFlag}\n${dataScript}\n</body>`);
}

function buildReportHTML(
  skillName: string,
  skill: import("./status.js").SkillStatus,
  statusResult: StatusResult,
): string {
  const passRateDisplay = skill.passRate !== null
    ? `${Math.round(skill.passRate * 100)}%`
    : "No data";
  const trendArrows: Record<string, string> = { up: "\u2191", down: "\u2193", stable: "\u2192", unknown: "?" };
  const trendDisplay = trendArrows[skill.trend] ?? "?";
  const statusColor = skill.status === "HEALTHY" ? "#4c1" : skill.status === "REGRESSED" ? "#e05d44" : "#9f9f9f";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>selftune report: ${escapeHtml(skillName)}</title>
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
    a { color: #0366d6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .status-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; color: #fff; font-size: 0.85rem; font-weight: 600; }
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

  ${skill.snapshot ? `
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
  </div>` : ""}

  <div class="card">
    <h2>System Overview</h2>
    <table>
      <tr><th>Metric</th><th>Value</th></tr>
      <tr><td>Total Skills</td><td>${statusResult.skills.length}</td></tr>
      <tr><td>Unmatched Queries</td><td>${statusResult.unmatchedQueries}</td></tr>
      <tr><td>Pending Proposals</td><td>${statusResult.pendingProposals}</td></tr>
      <tr><td>Last Session</td><td>${statusResult.lastSession ?? "\u2014"}</td></tr>
    </table>
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

  const sseClients = new Set<ReadableStreamDefaultController>();

  const server = Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const url = new URL(req.url);

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      // ---- GET / ---- Serve dashboard HTML
      if (url.pathname === "/" && req.method === "GET") {
        const data = collectData();
        const html = buildLiveHTML(data);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
        });
      }

      // ---- GET /api/data ---- JSON data endpoint
      if (url.pathname === "/api/data" && req.method === "GET") {
        const data = collectData();
        return Response.json(data, { headers: corsHeaders() });
      }

      // ---- GET /api/events ---- SSE stream
      if (url.pathname === "/api/events" && req.method === "GET") {
        const stream = new ReadableStream({
          start(controller) {
            sseClients.add(controller);

            // Send initial data immediately
            const data = collectData();
            const payload = `event: data\ndata: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(new TextEncoder().encode(payload));

            // Set up periodic updates every 5 seconds
            const interval = setInterval(() => {
              try {
                const freshData = collectData();
                const msg = `event: data\ndata: ${JSON.stringify(freshData)}\n\n`;
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
        const args = ["--skill", body.skill, "--skill-path", body.skillPath];
        const result = await runAction("watch", args);
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
        const args = ["--skill", body.skill, "--skill-path", body.skillPath];
        const result = await runAction("evolve", args);
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
        const result = await runAction("rollback", args);
        return Response.json(result, { headers: corsHeaders() });
      }

      // ---- GET /badge/:skillName ---- Badge SVG
      if (url.pathname.startsWith("/badge/") && req.method === "GET") {
        const skillName = decodeURIComponent(url.pathname.slice("/badge/".length));
        const format = (url.searchParams.get("format") as BadgeFormat) ?? "svg";

        const statusResult = computeStatusFromLogs();
        const badgeData = findSkillBadgeData(statusResult, skillName);

        if (!badgeData) {
          // Return a gray "not found" SVG badge (not JSON error — keeps <img> working)
          const notFoundData: BadgeData = {
            label: "Skill Health",
            passRate: null,
            trend: "unknown",
            status: "NO DATA",
            color: "#9f9f9f",
            message: "not found",
          };
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
        const statusResult = computeStatusFromLogs();
        const skill = statusResult.skills.find((s) => s.name === skillName);

        if (!skill) {
          return new Response("Skill not found", {
            status: 404,
            headers: { "Content-Type": "text/plain", ...corsHeaders() },
          });
        }

        const html = buildReportHTML(skillName, skill, statusResult);
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache, no-store",
            ...corsHeaders(),
          },
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
