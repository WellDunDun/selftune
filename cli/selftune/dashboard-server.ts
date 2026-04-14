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
 *   GET  /api/v2/analytics     — Performance analytics (trends, rankings, heatmap)
 *   GET  /api/v2/skills/:name  — SQLite-backed per-skill report
 *   POST /api/actions/watch    — Trigger `selftune watch` for a skill
 *   POST /api/actions/evolve   — Trigger `selftune evolve` for a skill
 *   POST /api/actions/rollback — Trigger `selftune rollback` for a skill
 *   POST /api/actions/watchlist — Persist creator watchlist preferences
 *   GET  /badge/:name          — Skill health badge
 *   GET  /report/:name         — Skill health report HTML
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync, unwatchFile, watchFile } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import type { BadgeFormat } from "./badge/badge-data.js";
import { getCachedUpdateStatus } from "./auto-update.js";
import { DASHBOARD_ACTION_STREAM_LOG, LOG_DIR, SELFTUNE_CONFIG_DIR } from "./constants.js";
import type {
  DashboardActionEvent,
  HealthResponse,
  OverviewResponse,
  SkillReportResponse,
} from "./dashboard-contract.js";
import { readEvidenceTrail } from "./evolution/evidence.js";
import { closeSingleton, DB_PATH, getDb } from "./localdb/db.js";
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
  handleAnalytics,
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
import type { EvolutionAuditEntry, EvolutionEvidenceEntry } from "./types.js";
import { readJsonlFrom } from "./utils/jsonl.js";

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  spaDir?: string;
  spaProxyUrl?: string;
  openBrowser?: boolean;
  runtimeMode?: HealthResponse["process_mode"];
  statusLoader?: () => StatusResult | Promise<StatusResult>;
  evidenceLoader?: () => EvolutionEvidenceEntry[];
  overviewLoader?: () => OverviewResponse;
  skillReportLoader?: (skillName: string) => SkillReportResponse | null;
  actionRunner?: ActionRunner;
}

interface DashboardSocketData {
  upstreamUrl?: string;
}

interface ActionEventHistoryEntry {
  eventId: string;
  updatedAt: number;
  finished: boolean;
  events: DashboardActionEvent[];
}

/** Read selftune version from package.json (fresh on each call to pick up auto-updates). */
const VERSION_PKG_PATH = join(import.meta.dir, "..", "..", "package.json");
function getSelftuneVersion(): string {
  try {
    return JSON.parse(readFileSync(VERSION_PKG_PATH, "utf-8")).version;
  } catch {
    return "unknown";
  }
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

function getSpaBuildId(): string {
  return process.env.SELFTUNE_SPA_BUILD_ID || getSelftuneVersion();
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

function allowedDashboardOrigins(hostname: string, port: number): Set<string> {
  const origins = new Set<string>([`http://${hostname}:${port}`]);
  if (hostname === "localhost") {
    origins.add(`http://127.0.0.1:${port}`);
  } else if (hostname === "127.0.0.1") {
    origins.add(`http://localhost:${port}`);
  }
  return origins;
}

function normalizeSpaProxyUrl(rawValue: string | undefined): URL | null {
  if (!rawValue) return null;
  try {
    const url = new URL(rawValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function shouldProxySpaRequest(pathname: string): boolean {
  return (
    !pathname.startsWith("/api/") &&
    !pathname.startsWith("/badge/") &&
    !pathname.startsWith("/report/")
  );
}

async function proxySpaRequest(req: Request, proxyBaseUrl: URL, url: URL): Promise<Response> {
  const targetUrl = new URL(`${url.pathname}${url.search}`, proxyBaseUrl);
  const headers = new Headers(req.headers);
  headers.set("host", targetUrl.host);
  const upstreamResponse = await fetch(targetUrl, {
    method: req.method,
    headers,
    redirect: "manual",
  });
  const proxiedHeaders = new Headers(upstreamResponse.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    proxiedHeaders.set(key, value);
  }
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: proxiedHeaders,
  });
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

async function serveSpaShell(spaDir: string | null): Promise<Response> {
  if (!spaDir) {
    return new Response("Dashboard build not found. Run `bun run build:dashboard` first.", {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        ...corsHeaders(),
      },
    });
  }

  const indexPath = join(spaDir, "index.html");
  const indexFile = Bun.file(indexPath);
  if (!(await indexFile.exists())) {
    return new Response(
      "Dashboard assets are updating. Retry in a moment or run `selftune dashboard --restart`.",
      {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Retry-After": "1",
          ...corsHeaders(),
        },
      },
    );
  }

  try {
    const html = await indexFile.text();
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
    });
  } catch {
    return new Response(
      "Dashboard assets are updating. Retry in a moment or run `selftune dashboard --restart`.",
      {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Retry-After": "1",
          ...corsHeaders(),
        },
      },
    );
  }
}

async function computeStatusFromDb(): Promise<StatusResult> {
  const db = getDb();
  const telemetry = querySessionTelemetry(db);
  const skillRecords = querySkillUsageRecords(db);
  const queryRecords = queryQueryLog(db);
  const auditEntries = queryEvolutionAudit(db) as EvolutionAuditEntry[];
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

export async function startDashboardServer(options?: DashboardServerOptions): Promise<{
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
  port: number;
}> {
  const port = options?.port ?? 3141;
  const hostname = options?.host ?? "localhost";
  const openBrowser = options?.openBrowser ?? true;
  const runtimeMode = options?.runtimeMode ?? (import.meta.main ? "dev-server" : "test");
  const spaProxyUrl = normalizeSpaProxyUrl(options?.spaProxyUrl ?? process.env.SPA_PROXY_URL);
  const getStatusResult = options?.statusLoader ?? computeStatusFromDb;
  const getEvidenceEntries = options?.evidenceLoader ?? readEvidenceTrail;
  const getOverviewResponse = options?.overviewLoader;
  const getSkillReportResponse = options?.skillReportLoader;
  const executeAction = options?.actionRunner ?? runAction;

  // -- SPA serving -------------------------------------------------------------
  const requestedSpaDir = options?.spaDir ?? findSpaDir();
  const spaDir =
    requestedSpaDir && existsSync(join(requestedSpaDir, "index.html")) ? requestedSpaDir : null;
  const spaMode: NonNullable<HealthResponse["spa_mode"]> = spaProxyUrl
    ? "proxy"
    : spaDir
      ? "dist"
      : "missing";
  if (spaProxyUrl) {
    console.log(`SPA proxy enabled at ${spaProxyUrl.toString()}`);
  } else if (spaDir) {
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`V2 dashboard data unavailable: ${message}`);
    }
  }

  // Hooks and ingestors write directly to SQLite, so periodic materialization is
  // not part of normal runtime. These remain no-ops because they are invoked
  // from several shared request and watcher paths.
  function refreshV2Data(): void {
    // No-op: SQLite is already authoritative at runtime
  }

  function refreshV2DataImmediate(): void {
    // No-op: SQLite is already authoritative at runtime
  }

  // -- SSE (Server-Sent Events) live update layer -----------------------------
  const sseClients = new Set<ReadableStreamDefaultController>();
  const actionEventHistory = new Map<string, ActionEventHistoryEntry>();
  const MAX_ACTION_HISTORY_RUNS = 24;
  const MAX_ACTION_HISTORY_EVENTS_PER_RUN = 320;

  function trimActionEventHistory(): void {
    if (actionEventHistory.size <= MAX_ACTION_HISTORY_RUNS) return;

    const staleEntries = [...actionEventHistory.values()].sort((left, right) => {
      if (left.finished !== right.finished) {
        return left.finished ? -1 : 1;
      }
      return left.updatedAt - right.updatedAt;
    });

    while (actionEventHistory.size > MAX_ACTION_HISTORY_RUNS) {
      const next = staleEntries.shift();
      if (!next) break;
      actionEventHistory.delete(next.eventId);
    }
  }

  function rememberActionEvent(event: DashboardActionEvent): void {
    const existing = actionEventHistory.get(event.event_id);
    if (existing) {
      existing.updatedAt = event.ts;
      existing.finished = event.stage === "finished" ? true : existing.finished;
      existing.events.push(event);
      existing.events = existing.events.slice(-MAX_ACTION_HISTORY_EVENTS_PER_RUN);
      return;
    }

    actionEventHistory.set(event.event_id, {
      eventId: event.event_id,
      updatedAt: event.ts,
      finished: event.stage === "finished",
      events: [event],
    });
    trimActionEventHistory();
  }

  function recentActionEventsForBackfill(): DashboardActionEvent[] {
    return [...actionEventHistory.values()]
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .flatMap((entry) => entry.events);
  }

  function broadcastSSE(eventType: string, payload: Record<string, unknown>): void {
    if (eventType === "action") {
      rememberActionEvent(payload as DashboardActionEvent);
    }
    const message = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const controller of sseClients) {
      try {
        controller.enqueue(new TextEncoder().encode(message));
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

  // -- SQLite WAL watcher for push-based updates ------------------------------
  const walPath = `${DB_PATH}-wal`;
  let walWatcherActive = false;
  const actionStreamPath =
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG || DASHBOARD_ACTION_STREAM_LOG;
  let actionStreamWatcherActive = false;
  let actionStreamOffset = existsSync(actionStreamPath) ? statSync(actionStreamPath).size : 0;

  let fsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let actionStreamDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const FS_DEBOUNCE_MS = 500;
  const ACTION_STREAM_DEBOUNCE_MS = 100;
  const ACTION_STREAM_POLL_MS = 250;
  const proxiedSpaSockets = new Map<unknown, WebSocket>();

  function onWALChange(): void {
    if (fsDebounceTimer) return;
    fsDebounceTimer = setTimeout(() => {
      fsDebounceTimer = null;
      refreshV2DataImmediate();
      broadcastSSE("update", { type: "update", ts: Date.now() });
    }, FS_DEBOUNCE_MS);
  }

  watchFile(walPath, { interval: 500 }, onWALChange);
  walWatcherActive = true;

  function flushActionStream(): void {
    if (actionStreamDebounceTimer) return;
    actionStreamDebounceTimer = setTimeout(() => {
      actionStreamDebounceTimer = null;
      const { records, newOffset } = readJsonlFrom<DashboardActionEvent>(
        actionStreamPath,
        actionStreamOffset,
      );
      actionStreamOffset = newOffset;
      for (const record of records) {
        broadcastSSE("action", record);
      }
    }, ACTION_STREAM_DEBOUNCE_MS);
  }

  const actionStreamPoller = setInterval(() => {
    flushActionStream();
  }, ACTION_STREAM_POLL_MS);
  actionStreamWatcherActive = true;

  function getWatcherMode(): HealthResponse["watcher_mode"] {
    if (walWatcherActive && actionStreamWatcherActive) return "wal";
    return walWatcherActive || actionStreamWatcherActive ? "wal" : "none";
  }

  let cachedStatusResult: StatusResult | null = null;
  let lastStatusCacheRefreshAt = 0;
  let statusRefreshPromise: Promise<void> | null = null;
  const STATUS_CACHE_TTL_MS = 30_000;
  let boundPort = port;

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
  const server = Bun.serve<DashboardSocketData>({
    port,
    hostname,
    idleTimeout: 255,
    websocket: {
      open(ws) {
        const upstreamUrl = ws.data?.upstreamUrl;
        if (!upstreamUrl) {
          ws.close(1011, "Missing upstream websocket target");
          return;
        }
        const upstreamSocket = new WebSocket(upstreamUrl);
        proxiedSpaSockets.set(ws, upstreamSocket);
        upstreamSocket.onmessage = (event) => {
          ws.send(event.data);
        };
        upstreamSocket.onclose = (event) => {
          proxiedSpaSockets.delete(ws);
          try {
            ws.close(event.code || 1000, event.reason);
          } catch {
            ws.close();
          }
        };
        upstreamSocket.onerror = () => {
          proxiedSpaSockets.delete(ws);
          ws.close(1011, "Upstream websocket error");
        };
      },
      message(ws, message) {
        const upstreamSocket = proxiedSpaSockets.get(ws);
        if (!upstreamSocket || upstreamSocket.readyState !== WebSocket.OPEN) {
          return;
        }
        upstreamSocket.send(message);
      },
      close(ws) {
        const upstreamSocket = proxiedSpaSockets.get(ws);
        proxiedSpaSockets.delete(ws);
        upstreamSocket?.close();
      },
    },
    async fetch(req) {
      const url = new URL(req.url);

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      // ---- GET /api/health ----
      if (url.pathname === "/api/health" && req.method === "GET") {
        const updateStatus = getCachedUpdateStatus();
        const healthResponse: HealthResponse = {
          ok: true,
          service: "selftune-dashboard",
          version: getSelftuneVersion(),
          latest_version: updateStatus.latestVersion,
          update_available: updateStatus.updateAvailable,
          auto_update_supported: updateStatus.autoUpdateSupported,
          update_hint: updateStatus.updateHint,
          pid: process.pid,
          spa: Boolean(spaDir || spaProxyUrl),
          spa_mode: spaMode,
          spa_build_id: getSpaBuildId(),
          spa_proxy_url: spaProxyUrl?.toString() ?? null,
          v2_data_available: Boolean(getOverviewResponse || db),
          workspace_root: WORKSPACE_ROOT,
          git_sha: getGitSha(),
          db_path: DB_PATH,
          log_dir: LOG_DIR,
          config_dir: SELFTUNE_CONFIG_DIR,
          watcher_mode: getWatcherMode(),
          process_mode: runtimeMode,
          host: hostname,
          port: boundPort,
        };
        return Response.json(healthResponse, { headers: corsHeaders() });
      }

      if (
        spaProxyUrl &&
        req.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        shouldProxySpaRequest(url.pathname)
      ) {
        const upstreamUrl = new URL(`${url.pathname}${url.search}`, spaProxyUrl);
        upstreamUrl.protocol = spaProxyUrl.protocol === "https:" ? "wss:" : "ws:";
        if (
          server.upgrade(req, {
            data: { upstreamUrl: upstreamUrl.toString() },
          })
        ) {
          return undefined;
        }
        return new Response("WebSocket upgrade failed", {
          status: 502,
          headers: corsHeaders(),
        });
      }

      // ---- GET /api/v2/events ---- SSE stream for live updates
      if (url.pathname === "/api/v2/events" && req.method === "GET") {
        const stream = new ReadableStream({
          start(controller) {
            sseClients.add(controller);
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            for (const event of recentActionEventsForBackfill()) {
              controller.enqueue(
                new TextEncoder().encode(`event: action\ndata: ${JSON.stringify(event)}\n\n`),
              );
            }
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
      if (spaProxyUrl && req.method === "GET" && shouldProxySpaRequest(url.pathname)) {
        try {
          return await proxySpaRequest(req, spaProxyUrl, url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return new Response(
            `Dashboard SPA proxy unavailable at ${spaProxyUrl.toString()}: ${message}`,
            {
              status: 502,
              headers: {
                "Content-Type": "text/plain; charset=utf-8",
                ...corsHeaders(),
              },
            },
          );
        }
      }

      // ---- SPA static assets ----
      if (spaDir && req.method === "GET" && url.pathname.startsWith("/assets/")) {
        const filePath = resolve(spaDir, `.${url.pathname}`);
        const rel = relative(spaDir, filePath);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          return new Response("Not Found", {
            status: 404,
            headers: corsHeaders(),
          });
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
        return new Response("Not Found", {
          status: 404,
          headers: corsHeaders(),
        });
      }

      // ---- GET / ---- Serve SPA shell
      if (url.pathname === "/" && req.method === "GET") {
        return serveSpaShell(spaDir);
      }

      // ---- POST /api/actions/{watch,evolve,rollback,watchlist} ----
      if (url.pathname.startsWith("/api/actions/") && req.method === "POST") {
        const trustedActionOrigins = allowedDashboardOrigins(hostname, boundPort);
        const origin = req.headers.get("origin");
        if (!origin || !trustedActionOrigins.has(origin)) {
          return Response.json(
            {
              success: false,
              error:
                "Dashboard actions only accept same-origin requests from the local dashboard UI.",
            },
            { status: 403, headers: corsHeaders() },
          );
        }
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
        const emitActionEvent = (event: DashboardActionEvent) => {
          broadcastSSE("action", event);
        };
        return withCors(await handleAction(action, body, executeAction, emitActionEvent));
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
          return Response.json(getOverviewResponse(), {
            headers: corsHeaders(),
          });
        }
        if (!db) {
          return Response.json(
            { error: "V2 data unavailable" },
            { status: 503, headers: corsHeaders() },
          );
        }
        refreshV2Data();
        return withCors(handleOverview(db, getSelftuneVersion(), url.searchParams));
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

      // ---- GET /api/v2/analytics ----
      if (url.pathname === "/api/v2/analytics" && req.method === "GET") {
        if (!db) {
          return Response.json(
            { error: "V2 data unavailable" },
            { status: 503, headers: corsHeaders() },
          );
        }
        refreshV2Data();
        return withCors(handleAnalytics(db));
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
        return withCors(handleSkillReport(db, skillName, url.searchParams));
      }

      // ---- SPA fallback ----
      if (spaDir && req.method === "GET" && !url.pathname.startsWith("/api/")) {
        return serveSpaShell(spaDir);
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders() });
    },
  });

  boundPort = server.port ?? port;

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
    unwatchFile(walPath, onWALChange);
    clearInterval(sseKeepaliveTimer);
    clearInterval(actionStreamPoller);
    for (const c of sseClients) {
      try {
        c.close();
      } catch {
        /* already closed */
      }
    }
    sseClients.clear();
    for (const upstreamSocket of proxiedSpaSockets.values()) {
      try {
        upstreamSocket.close();
      } catch {
        /* already closed */
      }
    }
    proxiedSpaSockets.clear();
    if (fsDebounceTimer) clearTimeout(fsDebounceTimer);
    if (actionStreamDebounceTimer) clearTimeout(actionStreamDebounceTimer);
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
  startDashboardServer({
    port,
    openBrowser: false,
    runtimeMode,
    spaProxyUrl: process.env.SPA_PROXY_URL,
  });
}
