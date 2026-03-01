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
import { getLastDeployedProposal, readAuditTrail } from "./evolution/audit.js";
import { readDecisions } from "./memory/writer.js";
import { computeMonitoringSnapshot } from "./monitoring/watch.js";
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

  // Compute pending proposals
  const auditTrail = readAuditTrail();
  const proposalStatus: Record<string, string[]> = {};
  for (const e of auditTrail) {
    if (!proposalStatus[e.proposal_id]) proposalStatus[e.proposal_id] = [];
    proposalStatus[e.proposal_id].push(e.action);
  }
  const terminalActions = new Set(["deployed", "rejected", "rolled_back"]);
  const seenProposals = new Set<string>();
  const pendingProposals = auditTrail.filter((e) => {
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

function buildLiveHTML(data: DashboardData): string {
  const template = readFileSync(findViewerHTML(), "utf-8");

  // Escape </script> sequences to prevent XSS via embedded JSON
  const safeJson = JSON.stringify(data).replace(/<\/script>/gi, "<\\/script>");
  const liveFlag = '<script>window.__SELFTUNE_LIVE__ = true;</script>';
  const dataScript = `<script id="embedded-data" type="application/json">${safeJson}</script>`;

  return template.replace("</body>", `${liveFlag}\n${dataScript}\n</body>`);
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
    const indexPath = resolve("cli/selftune/index.ts");
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
        const args = ["--skill", body.skill ?? "", "--skill-path", body.skillPath ?? ""];
        const result = await runAction("watch", args);
        return Response.json(result, { headers: corsHeaders() });
      }

      // ---- POST /api/actions/evolve ----
      if (url.pathname === "/api/actions/evolve" && req.method === "POST") {
        const body = (await req.json()) as { skill?: string; skillPath?: string };
        const args = ["--skill", body.skill ?? "", "--skill-path", body.skillPath ?? ""];
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
        const args = [
          "--skill",
          body.skill ?? "",
          "--proposal-id",
          body.proposalId ?? "",
        ];
        const result = await runAction("rollback", args);
        return Response.json(result, { headers: corsHeaders() });
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
