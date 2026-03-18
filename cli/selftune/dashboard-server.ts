/**
 * selftune dashboard server — Bun.serve HTTP server for the SPA dashboard,
 * skill report HTML, badges, and action endpoints.
 *
 * Endpoints:
 *   GET  /                     — Serve dashboard SPA shell
 *   GET  /api/v2/events        — SSE stream for live dashboard updates
 *   GET  /api/health           — Dashboard server health probe
 *   GET  /api/v2/doctor        — System health diagnostics (config, logs, hooks, evolution)
 *   GET  /api/v2/overview      — SQLite-backed overview payload
 *   GET  /api/v2/skills/:name  — SQLite-backed per-skill report
 *   POST /api/actions/watch    — Trigger `selftune watch` for a skill
 *   POST /api/actions/evolve   — Trigger `selftune evolve` for a skill
 *   POST /api/actions/rollback — Trigger `selftune rollback` for a skill
 *   GET  /badge/:name          — Skill health badge
 *   GET  /report/:name         — Skill health report HTML
 */

import type { Database } from "bun:sqlite";
import { existsSync, type FSWatcher, watch as fsWatch, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { BadgeFormat } from "./badge/badge-svg.js";
import { EVOLUTION_AUDIT_LOG, LOG_DIR, QUERY_LOG, SELFTUNE_CONFIG_DIR, TELEMETRY_LOG } from "./constants.js";
import type { HealthResponse, OverviewResponse, SkillReportResponse } from "./dashboard-contract.js";
import { readEvidenceTrail } from "./evolution/evidence.js";
import { closeSingleton, DB_PATH, getDb } from "./localdb/db.js";
import { materializeIncremental } from "./localdb/materialize.js";
import {
  queryEvolutionAudit,
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "./localdb/queries.js";
import { doctor } from "./observability.js";
import type { ActionRunner } from "./routes/index.js";
import {
  handleAction,
  handleBadge,
  handleDoctor,
  handleOrchestrateRuns,
  handleOverview,
  handleReport,
  handleSkillReport,
  runAction,
} from "./routes/index.js";
import type { StatusResult } from "./status.js";
import { computeStatus } from "./status.js";
import type { EvolutionEvidenceEntry } from "./types.js";

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  spaDir?: string;
  openBrowser?: boolean;
  runtimeMode?: HealthResponse["process_mode"];
  statusLoader?: () => StatusResult | Promise<StatusResult>;
  evidenceLoader?: () => EvolutionEvidenceEntry[];
  overviewLoader?: () => OverviewResponse;
  skillReportLoader?: (skillName: string) => SkillReportResponse | null;
  actionRunner?: ActionRunner;
}

/** Read selftune version from package.json once at startup */
let selftuneVersion = "unknown";
try {
  const pkgPath = join(import.meta.dir, "..", "..", "package.json");
  selftuneVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
} catch {
  // fallback already set
}

/** Resolve short git SHA once at startup (cached). */
let cachedGitSha: string | null = null;
function getGitSha(): string {
  if (cachedGitSha !== null) return cachedGitSha;
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
    cachedGitSha = result.stdout.toString().trim() || "unknown";
  } catch {
    cachedGitSha = "unknown";
  }
  return cachedGitSha;
}

const WORKSPACE_ROOT = resolve(import.meta.dir, "..", "..");

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

async function computeStatusFromDb(): Promise<StatusResult> {
  const db = getDb();
  const telemetry = querySessionTelemetry(db);
  const skillRecords = querySkillUsageRecords(db);
  const queryRecords = queryQueryLog(db);
  const auditEntries = queryEvolutionAudit(db);
  const doctorResult = await doctor();
  return computeStatus(telemetry, skillRecords, queryRecords, auditEntries, doctorResult);
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/** Wrap a route handler Response with CORS headers. */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function startDashboardServer(
  options?: DashboardServerOptions,
): Promise<{ server: ReturnType<typeof Bun.serve>; stop: () => void; port: number }> {
  const port = options?.port ?? 3141;
  const hostname = options?.host ?? "localhost";
  const openBrowser = options?.openBrowser ?? true;
  const runtimeMode = options?.runtimeMode ?? (import.meta.main ? "dev-server" : "test");
  const getStatusResult = options?.statusLoader ?? computeStatusFromDb;
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
  const needsDb = !getOverviewResponse || !getSkillReportResponse;
  if (needsDb) {
    try {
      db = getDb();
      // Materializer runs once at startup to backfill any JSONL data not yet in SQLite.
      // After startup, hooks write directly to SQLite so re-materialization is unnecessary.
      materializeIncremental(db);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`V2 dashboard data unavailable: ${message}`);
    }
  }

  // Hooks write directly to SQLite, so periodic re-materialization is not needed.
  // These functions are retained as no-ops because they are called from multiple
  // places in the request handler and the file-change watcher.
  function refreshV2Data(): void {
    // No-op: materializer runs once at startup only
  }

  function refreshV2DataImmediate(): void {
    // No-op: materializer runs once at startup only
  }

  // -- SSE (Server-Sent Events) live update layer -----------------------------
  const sseClients = new Set<ReadableStreamDefaultController>();

  function broadcastSSE(eventType: string): void {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify({ type: eventType, ts: Date.now() })}\n\n`;
    for (const controller of sseClients) {
      try {
        controller.enqueue(new TextEncoder().encode(payload));
      } catch {
        sseClients.delete(controller);
      }
    }
  }

  const SSE_KEEPALIVE_MS = 30_000;
  const sseKeepaliveTimer = setInterval(() => {
    for (const controller of sseClients) {
      try {
        controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
      } catch {
        sseClients.delete(controller);
      }
    }
  }, SSE_KEEPALIVE_MS);

  // -- File watchers on JSONL logs for push-based updates ---------------------
  const WATCHED_LOGS = [TELEMETRY_LOG, QUERY_LOG, EVOLUTION_AUDIT_LOG];
  const watcherMode: HealthResponse["watcher_mode"] = WATCHED_LOGS.length > 0 ? "jsonl" : "none";

  let fsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const FS_DEBOUNCE_MS = 500;

  function onLogFileChange(): void {
    if (fsDebounceTimer) return;
    fsDebounceTimer = setTimeout(() => {
      fsDebounceTimer = null;
      refreshV2DataImmediate();
      broadcastSSE("update");
    }, FS_DEBOUNCE_MS);
  }

  const fileWatchers: FSWatcher[] = [];
  for (const logPath of WATCHED_LOGS) {
    if (existsSync(logPath)) {
      try {
        fileWatchers.push(fsWatch(logPath, onLogFileChange));
      } catch {
        // Non-fatal: fall back to polling if watch fails
      }
    }
  }

  if (runtimeMode !== "test" && watcherMode === "jsonl") {
    console.warn(
      "Dashboard freshness mode: JSONL watcher invalidation (legacy). Live updates can miss SQLite-only writes until WAL cutover lands.",
    );
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
      cachedStatusResult = await Promise.resolve(getStatusResult());
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

  // -- HTTP request handler ---------------------------------------------------
  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      // ---- GET /api/health ----
      if (url.pathname === "/api/health" && req.method === "GET") {
        const healthResponse: HealthResponse = {
          ok: true,
          service: "selftune-dashboard",
          version: selftuneVersion,
          spa: Boolean(spaDir),
          v2_data_available: Boolean(getOverviewResponse || db),
          workspace_root: WORKSPACE_ROOT,
          git_sha: getGitSha(),
          db_path: DB_PATH,
          log_dir: LOG_DIR,
          config_dir: SELFTUNE_CONFIG_DIR,
          watcher_mode: watcherMode,
          process_mode: runtimeMode,
          host: hostname,
          port: boundPort,
        };
        return Response.json(healthResponse, { headers: corsHeaders() });
      }

      // ---- GET /api/v2/events ---- SSE stream for live updates
      if (url.pathname === "/api/v2/events" && req.method === "GET") {
        const stream = new ReadableStream({
          start(controller) {
            sseClients.add(controller);
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          },
          cancel(controller) {
            sseClients.delete(controller);
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

      // ---- GET /api/v2/doctor ----
      if (url.pathname === "/api/v2/doctor" && req.method === "GET") {
        return withCors(await handleDoctor());
      }

      // ---- SPA static assets ----
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

      // ---- POST /api/actions/{watch,evolve,rollback} ----
      if (url.pathname.startsWith("/api/actions/") && req.method === "POST") {
        const action = url.pathname.slice("/api/actions/".length);
        let body: Record<string, unknown> = {};
        try {
          const parsed = await req.json();
          if (typeof parsed === "object" && parsed !== null) {
            body = parsed as Record<string, unknown>;
          }
        } catch {
          return Response.json(
            {
              success: false,
              error:
                "Malformed JSON body. Retry with a JSON object containing skill and skillPath.",
            },
            { status: 400, headers: corsHeaders() },
          );
        }
        return withCors(await handleAction(action, body, executeAction));
      }

      // ---- GET /badge/:skillName ----
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
        return withCors(handleBadge(statusResult, skillName, format));
      }

      // ---- GET /report/:skillName ----
      if (url.pathname.startsWith("/report/") && req.method === "GET") {
        const skillName = decodePathSegment(url.pathname.slice("/report/".length));
        if (skillName === null) {
          return Response.json(
            { error: "Malformed skill name" },
            { status: 400, headers: corsHeaders() },
          );
        }
        const statusResult = await getCachedStatusResult();
        const evidenceEntries = getEvidenceEntries();
        return withCors(handleReport(statusResult, skillName, evidenceEntries));
      }

      // ---- GET /api/v2/overview ----
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
        return withCors(handleOverview(db, selftuneVersion));
      }

      // ---- GET /api/v2/orchestrate-runs ----
      if (url.pathname === "/api/v2/orchestrate-runs" && req.method === "GET") {
        if (!db) {
          return Response.json(
            { error: "V2 data unavailable" },
            { status: 503, headers: corsHeaders() },
          );
        }
        refreshV2Data();
        const limitParam = url.searchParams.get("limit");
        const parsedLimit = limitParam === null ? null : Number.parseInt(limitParam, 10);
        if (parsedLimit !== null && Number.isNaN(parsedLimit)) {
          return Response.json({ error: "Invalid limit" }, { status: 400, headers: corsHeaders() });
        }
        const limit = parsedLimit === null ? 20 : Math.min(Math.max(parsedLimit, 1), 100);
        return withCors(handleOrchestrateRuns(db, limit));
      }

      // ---- GET /api/v2/skills/:name ----
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
        return withCors(handleSkillReport(db, skillName));
      }

      // ---- SPA fallback ----
      if (spaDir && req.method === "GET" && !url.pathname.startsWith("/api/")) {
        const html = await Bun.file(join(spaDir, "index.html")).text();
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
        });
      }

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
    for (const w of fileWatchers) w.close();
    clearInterval(sseKeepaliveTimer);
    for (const c of sseClients) {
      try {
        c.close();
      } catch {
        /* already closed */
      }
    }
    sseClients.clear();
    if (fsDebounceTimer) clearTimeout(fsDebounceTimer);
    closeSingleton();
    server.stop();
  };

  process.once("SIGINT", shutdownHandler);
  process.once("SIGTERM", shutdownHandler);

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

// -- Direct execution (bun run dashboard-server.ts --port XXXX) ---------------
if (import.meta.main) {
  const port = Number(process.argv.find((_, i, a) => a[i - 1] === "--port")) || 7888;
  const runtimeModeArg = process.argv.find((_, i, a) => a[i - 1] === "--runtime-mode");
  const runtimeMode =
    runtimeModeArg === "standalone" || runtimeModeArg === "dev-server" || runtimeModeArg === "test"
      ? runtimeModeArg
      : "dev-server";
  startDashboardServer({ port, openBrowser: false, runtimeMode });
}
