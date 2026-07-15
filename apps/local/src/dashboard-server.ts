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
 *   GET  /api/v2/shell         — Compact navigation and Library summary
 *   GET  /api/v2/analytics     — Performance analytics (trends, rankings, heatmap)
 *   GET  /api/v2/skills/:name  — SQLite-backed per-skill report
 *   GET  /api/v2/settings      — Connected harnesses and automation schedule
 *   POST /api/v2/settings/onboarding — Apply human-selected setup choices
 *   POST /api/v2/settings/schedule — Reconcile local automation jobs
 *   GET  /api/v2/library          — Canonical local Skill Library snapshot
 *   POST /api/v2/library/source-update/preview — Preview a lock-backed upstream update
 *   POST /api/v2/library/source-update/apply — Apply a backed-up upstream update
 *   GET  /api/v2/insights         — Unified synthesis and portfolio review queue
 *   POST /api/v2/insights/review  — Record an explicit synthesis decision
 *   POST /api/v2/insights/draft   — Create a draft from an accepted candidate
 *   POST /api/v2/insights/evaluate — Run immutable draft release gates
 *   POST /api/v2/insights/release — Release a passing revision to the Library
 *   GET  /api/v2/skill-sets       — List project Skill Sets and apply receipts
 *   POST /api/v2/skill-sets       — Create a content-addressed Skill Set
 *   POST /api/v2/skill-sets/update — Update a Skill Set with optimistic concurrency
 *   POST /api/v2/skill-sets/derive — Capture a project's active skills
 *   POST /api/v2/skill-sets/export — Write a portable project manifest
 *   POST /api/v2/skill-sets/plan  — Preview project materialization
 *   POST /api/v2/skill-sets/apply — Apply a conflict-free Skill Set
 *   POST /api/v2/skill-sets/rollback — Roll back receipt-owned paths
 *   POST /api/v2/settings/remote-library/preview — Inspect sync artifacts
 *   GET  /api/v2/settings/remote-library/status — Inspect sync health and integrity
 *   POST /api/v2/settings/remote-library/{sync,export,restore} — Run explicit backup actions
 *   GET/POST /api/v2/settings/remote-library/shares — Manage private shares
 *   POST /api/actions/sync         — Import configured harness sessions now
 *   POST /api/actions/create-check — Trigger `selftune create check` for a draft package
 *   POST /api/actions/watch        — Trigger `selftune watch` for a skill
 *   POST /api/actions/evolve       — Trigger `selftune evolve` for a skill
 *   POST /api/actions/rollback     — Trigger `selftune rollback` for a skill
 *   POST /api/actions/watchlist — Persist creator watchlist preferences
 *   GET  /badge/:name          — Skill health badge
 *   GET  /report/:name         — Skill health report HTML
 */

import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { getCachedUpdateStatus } from "@selftune/runtime/auto-update";
import {
  DASHBOARD_ACTION_STREAM_LOG,
  LOG_DIR,
  SELFTUNE_CONFIG_DIR,
} from "@selftune/runtime/constants";
import type { HealthResponse } from "@selftune/runtime/dashboard-contract";
import { closeSingleton, DB_PATH } from "@selftune/runtime/localdb/db";

import { createDashboardAuth } from "./dashboard-auth.js";
import { createDashboardEventHub } from "./dashboard-events.js";
import {
  DashboardOperationError,
  DashboardOperations,
  makeDashboardOperationsLayer,
  type DashboardOperationOverrides,
} from "./dashboard-operations.js";
import { dashboardCorsHeaders as corsHeaders } from "./dashboard-http.js";
import { createDashboardSpa } from "./dashboard-spa.js";
import { handleDashboardApplicationRoute } from "./routes/application.js";
import { createDashboardCoreRoutes, type DashboardCoreRouteOverrides } from "./routes/core.js";

export interface DashboardServerOptions
  extends DashboardOperationOverrides, DashboardCoreRouteOverrides {
  port?: number;
  host?: string;
  spaDir?: string;
  spaProxyUrl?: string;
  openBrowser?: boolean;
  authToken?: string;
  authCookie?: boolean;
  authCookieSecure?: boolean;
  allowedOrigins?: string[];
  externalRequestHandler?: (request: Request) => Response | null | Promise<Response | null>;
  runtimeMode?: HealthResponse["process_mode"];
  runtimeInstanceId?: string;
}

interface DashboardSocketData {
  upstreamUrl?: string;
}

function allowedDashboardOrigins(
  hostname: string,
  port: number,
  additionalOrigins: ReadonlyArray<string> = [],
): Set<string> {
  const origins = new Set<string>([`http://${hostname}:${port}`, ...additionalOrigins]);
  if (hostname === "localhost") {
    origins.add(`http://127.0.0.1:${port}`);
  } else if (hostname === "127.0.0.1") {
    origins.add(`http://localhost:${port}`);
  }
  return origins;
}

export async function startDashboardServer(options?: DashboardServerOptions): Promise<{
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
  port: number;
}> {
  const port = options?.port ?? 3141;
  const hostname = options?.host ?? "localhost";
  const openBrowser = options?.openBrowser ?? true;
  const authToken = options?.authToken;
  const runtimeMode = options?.runtimeMode ?? (import.meta.main ? "dev-server" : "test");
  const spa = createDashboardSpa({
    directory: options?.spaDir,
    proxyUrl: options?.spaProxyUrl,
  });
  const auth = createDashboardAuth({
    token: authToken,
    cookie: options?.authCookie,
    cookieSecure: options?.authCookieSecure,
  });
  const operationsRuntime = ManagedRuntime.make(makeDashboardOperationsLayer(options));
  let backgroundRemoteSyncRunning = false;
  const runBackgroundRemoteSync = async (): Promise<void> => {
    if (backgroundRemoteSyncRunning) return;
    backgroundRemoteSyncRunning = true;
    try {
      await operationsRuntime.runPromise(
        Effect.gen(function* () {
          const operations = yield* DashboardOperations;
          return yield* operations.remoteLibrary("sync");
        }),
      );
    } catch (error) {
      if (!(error instanceof DashboardOperationError && error.code === "FILE_NOT_FOUND")) {
        process.stderr.write(
          `SelfTune Remote Library background sync failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    } finally {
      backgroundRemoteSyncRunning = false;
    }
  };
  const backgroundRemoteSyncStartup =
    runtimeMode === "standalone" ? setTimeout(() => void runBackgroundRemoteSync(), 30_000) : null;
  const backgroundRemoteSyncInterval =
    runtimeMode === "standalone"
      ? setInterval(() => void runBackgroundRemoteSync(), 4 * 60 * 60 * 1_000)
      : null;
  backgroundRemoteSyncStartup?.unref();
  backgroundRemoteSyncInterval?.unref();

  // -- SPA serving -------------------------------------------------------------
  if (spa.proxyUrl) {
    console.log(`SPA proxy enabled at ${spa.proxyUrl.toString()}`);
  } else if (spa.directory) {
    console.log(`SPA found at ${spa.directory}, serving as default dashboard`);
  } else {
    if (options?.spaDir) {
      console.warn(`Configured spaDir is missing index.html: ${options.spaDir}`);
    }
    console.warn(
      "SPA build not found. Run `bun run build:dashboard` before using `selftune dashboard`.",
    );
  }

  const eventHub = createDashboardEventHub({
    databasePath: DB_PATH,
    actionStreamPath:
      process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG || DASHBOARD_ACTION_STREAM_LOG,
  });
  const coreRoutes = createDashboardCoreRoutes({
    ...options,
    onActionEvent: eventHub.broadcastAction,
    version: spa.version,
  });
  const proxiedSpaSockets = new Map<unknown, WebSocket>();
  let resourcesStopped = false;
  const disposeOwnedResources = async (): Promise<void> => {
    if (resourcesStopped) return;
    resourcesStopped = true;
    if (backgroundRemoteSyncStartup) clearTimeout(backgroundRemoteSyncStartup);
    if (backgroundRemoteSyncInterval) clearInterval(backgroundRemoteSyncInterval);
    eventHub.stop();
    for (const upstreamSocket of proxiedSpaSockets.values()) {
      try {
        upstreamSocket.close();
      } catch {
        // The upstream socket already closed.
      }
    }
    proxiedSpaSockets.clear();
    closeSingleton();
    await operationsRuntime.dispose();
  };

  let boundPort = port;

  // -- HTTP request handler ---------------------------------------------------
  let server: ReturnType<typeof bindServer>;
  function bindServer() {
    return Bun.serve<DashboardSocketData>({
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
        const allowedOrigins = allowedDashboardOrigins(
          hostname,
          boundPort,
          options?.allowedOrigins,
        );
        const sessionResponse = await auth.handleSessionRoute(req, url, allowedOrigins);
        if (sessionResponse) return sessionResponse;

        const externalResponse = await options?.externalRequestHandler?.(req);
        if (externalResponse) {
          return externalResponse;
        }

        // Extensions own their preflight policy; local dashboard routes retain
        // the existing permissive loopback policy.
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders() });
        }

        const authFailure = auth.authorize(req, url);
        if (authFailure) return authFailure;

        // ---- GET /api/health ----
        if (url.pathname === "/api/health" && req.method === "GET") {
          const updateStatus = getCachedUpdateStatus();
          const healthResponse: HealthResponse = {
            ok: true,
            service: "selftune-dashboard",
            version: spa.version(),
            latest_version: updateStatus.latestVersion,
            update_available: updateStatus.updateAvailable,
            auto_update_supported: updateStatus.autoUpdateSupported,
            update_hint: updateStatus.updateHint,
            pid: process.pid,
            runtime_instance_id: options?.runtimeInstanceId ?? null,
            spa: spa.available,
            spa_mode: spa.mode,
            spa_build_id: spa.buildId(),
            spa_proxy_url: spa.proxyUrl?.toString() ?? null,
            v2_data_available: coreRoutes.dataAvailable,
            workspace_root: spa.workspaceRoot,
            git_sha: spa.gitSha(),
            db_path: DB_PATH,
            log_dir: LOG_DIR,
            config_dir: SELFTUNE_CONFIG_DIR,
            watcher_mode: eventHub.watcherMode(),
            process_mode: runtimeMode,
            host: hostname,
            port: boundPort,
          };
          return Response.json(healthResponse, { headers: corsHeaders() });
        }

        const upstreamUrl = spa.upgradeTarget(req, url);
        if (upstreamUrl) {
          if (
            server.upgrade(req, {
              data: { upstreamUrl },
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
          return eventHub.response();
        }

        const applicationResponse = await operationsRuntime.runPromise(
          handleDashboardApplicationRoute(req, url, {
            allowedOrigins,
          }),
        );
        if (applicationResponse) return applicationResponse;

        const spaResponse = await spa.handlePrimaryRequest(req, url);
        if (spaResponse) return spaResponse;

        const coreResponse = await coreRoutes.handle(req, url, allowedOrigins);
        if (coreResponse) return coreResponse;

        // ---- SPA fallback ----
        const spaFallback = await spa.fallback(req, url);
        if (spaFallback) return spaFallback;

        return new Response("Not Found", { status: 404, headers: corsHeaders() });
      },
    });
  }
  try {
    server = bindServer();
  } catch (error) {
    await disposeOwnedResources();
    throw error;
  }

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
  let serverStopped = false;
  const shutdownHandler = () => {
    if (serverStopped) return;
    serverStopped = true;
    server.stop();
    void disposeOwnedResources();
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
  const rawPort = process.argv.find((_, i, a) => a[i - 1] === "--port");
  const parsedPort = rawPort === undefined ? 7888 : Number.parseInt(rawPort, 10);
  const port =
    Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 7888;
  const hostname = process.argv.find((_, i, a) => a[i - 1] === "--hostname") ?? "127.0.0.1";
  const authToken =
    process.argv.find((_, i, a) => a[i - 1] === "--auth-token") ?? process.env.SELFTUNE_AUTH_TOKEN;
  const spaDir = process.argv.find((_, i, a) => a[i - 1] === "--spa-dir");
  const runtimeModeArg = process.argv.find((_, i, a) => a[i - 1] === "--runtime-mode");
  const runtimeMode =
    runtimeModeArg === "standalone" || runtimeModeArg === "dev-server" || runtimeModeArg === "test"
      ? runtimeModeArg
      : "dev-server";
  const handle = await startDashboardServer({
    port,
    host: hostname,
    authToken,
    spaDir,
    openBrowser: false,
    runtimeMode,
    spaProxyUrl: process.env.SPA_PROXY_URL,
  });
  if (process.argv.includes("--ready-sentinel")) {
    console.log(`SELFTUNE_READY:${handle.port}`);
  }
}
