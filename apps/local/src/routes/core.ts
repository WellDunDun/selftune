import type { Database } from "bun:sqlite";

import type { BadgeFormat } from "@selftune/runtime/badge/badge-data";
import type {
  DashboardActionEvent,
  OverviewResponse,
  SkillReportResponse,
} from "@selftune/runtime/dashboard-contract";
import { readEvidenceTrail } from "@selftune/runtime/evolution/evidence";
import { getDb } from "@selftune/local-store";
import {
  queryEvolutionAudit,
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "@selftune/runtime/localdb/queries";
import { doctor } from "@selftune/runtime/observability";
import type { StatusResult } from "@selftune/runtime/status";
import { computeStatus } from "@selftune/runtime/status";
import type { EvolutionAuditEntry, EvolutionEvidenceEntry } from "@selftune/runtime/types";

import { dashboardCorsHeaders, withDashboardCors } from "../dashboard-http.js";
import type { ActionRunner } from "./index.js";
import {
  handleAction,
  handleAnalytics,
  handleBadge,
  handleDashboardShell,
  handleDoctor,
  handleOrchestrateRuns,
  handleOverview,
  handleReport,
  handleSkillReport,
  runAction,
  summarizeOverview,
} from "./index.js";

export interface DashboardCoreRouteOverrides {
  readonly actionRunner?: ActionRunner;
  readonly evidenceLoader?: () => EvolutionEvidenceEntry[];
  readonly overviewLoader?: () => OverviewResponse;
  readonly skillReportLoader?: (skillName: string) => SkillReportResponse | null;
  readonly statusLoader?: () => StatusResult | Promise<StatusResult>;
}

export interface DashboardCoreRoutes {
  readonly dataAvailable: boolean;
  readonly handle: (
    request: Request,
    url: URL,
    allowedOrigins: ReadonlySet<string>,
  ) => Promise<Response | null>;
}

interface DashboardCoreRouteOptions extends DashboardCoreRouteOverrides {
  readonly database?: Database;
  readonly onActionEvent: (event: DashboardActionEvent) => void;
  readonly version: () => string;
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

async function computeStatusFromDb(db: Database): Promise<StatusResult> {
  const telemetry = querySessionTelemetry(db);
  const skillRecords = querySkillUsageRecords(db);
  const queryRecords = queryQueryLog(db);
  const auditEntries = queryEvolutionAudit(db) as EvolutionAuditEntry[];
  const doctorResult = await doctor();
  return computeStatus(telemetry, skillRecords, queryRecords, auditEntries, doctorResult);
}

function unavailableResponse(): Response {
  return Response.json(
    { error: "V2 data unavailable" },
    { status: 503, headers: dashboardCorsHeaders() },
  );
}

export function createDashboardCoreRoutes(options: DashboardCoreRouteOptions): DashboardCoreRoutes {
  const getStatusResult =
    options.statusLoader ?? (() => computeStatusFromDb(options.database ?? getDb()));
  const getEvidenceEntries = options.evidenceLoader ?? readEvidenceTrail;
  const executeAction = options.actionRunner ?? runAction;
  let database: Database | null = null;

  if (!options.overviewLoader || !options.skillReportLoader) {
    try {
      database = options.database ?? getDb();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`V2 dashboard data unavailable: ${message}`);
    }
  }

  let cachedStatus: StatusResult | null = null;
  let lastStatusRefreshAt = 0;
  let statusRefresh: Promise<void> | null = null;
  const statusCacheTtlMs = 30_000;

  const refreshStatus = async (force = false): Promise<void> => {
    const fresh = cachedStatus !== null && Date.now() - lastStatusRefreshAt < statusCacheTtlMs;
    if (!force && fresh) return;
    if (statusRefresh) return statusRefresh;
    statusRefresh = Promise.resolve(getStatusResult()).then((status) => {
      cachedStatus = status;
      lastStatusRefreshAt = Date.now();
    });
    try {
      await statusRefresh;
    } finally {
      statusRefresh = null;
    }
  };

  const getCachedStatus = async (): Promise<StatusResult> => {
    if (!cachedStatus) {
      await refreshStatus(true);
    } else {
      void refreshStatus();
    }
    return cachedStatus as StatusResult;
  };

  const handle = async (
    request: Request,
    url: URL,
    allowedOrigins: ReadonlySet<string>,
  ): Promise<Response | null> => {
    if (url.pathname === "/api/v2/doctor" && request.method === "GET") {
      return withDashboardCors(await handleDoctor());
    }

    if (url.pathname.startsWith("/api/actions/") && request.method === "POST") {
      const origin = request.headers.get("origin");
      if (!origin || !allowedOrigins.has(origin)) {
        return Response.json(
          {
            success: false,
            error:
              "Dashboard actions only accept same-origin requests from the local dashboard UI.",
          },
          { status: 403, headers: dashboardCorsHeaders() },
        );
      }
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = await request.json();
        if (typeof parsed === "object" && parsed !== null) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        return Response.json(
          {
            success: false,
            error: "Malformed JSON body. Retry with a JSON object containing skill and skillPath.",
          },
          { status: 400, headers: dashboardCorsHeaders() },
        );
      }
      const action = url.pathname.slice("/api/actions/".length);
      if (action === "sync") {
        return Response.json(await executeAction("sync", ["--no-repair"]), {
          headers: dashboardCorsHeaders(),
        });
      }
      return withDashboardCors(
        await handleAction(action, body, executeAction, options.onActionEvent),
      );
    }

    if (url.pathname.startsWith("/badge/") && request.method === "GET") {
      const skillName = decodePathSegment(url.pathname.slice("/badge/".length));
      if (skillName === null) {
        return Response.json(
          { error: "Malformed skill name" },
          { status: 400, headers: dashboardCorsHeaders() },
        );
      }
      const requestedFormat = url.searchParams.get("format");
      const validFormats = new Set(["svg", "markdown", "url"]);
      const format: BadgeFormat =
        requestedFormat && validFormats.has(requestedFormat)
          ? (requestedFormat as BadgeFormat)
          : "svg";
      return withDashboardCors(handleBadge(await getCachedStatus(), skillName, format));
    }

    if (url.pathname.startsWith("/report/") && request.method === "GET") {
      const skillName = decodePathSegment(url.pathname.slice("/report/".length));
      if (skillName === null) {
        return Response.json(
          { error: "Malformed skill name" },
          { status: 400, headers: dashboardCorsHeaders() },
        );
      }
      return withDashboardCors(
        handleReport(await getCachedStatus(), skillName, getEvidenceEntries()),
      );
    }

    if (url.pathname === "/api/v2/shell" && request.method === "GET") {
      if (options.overviewLoader) {
        return Response.json(summarizeOverview(options.overviewLoader()), {
          headers: dashboardCorsHeaders(),
        });
      }
      return database
        ? withDashboardCors(handleDashboardShell(database, options.version()))
        : unavailableResponse();
    }

    if (url.pathname === "/api/v2/overview" && request.method === "GET") {
      if (options.overviewLoader) {
        return Response.json(options.overviewLoader(), { headers: dashboardCorsHeaders() });
      }
      return database
        ? withDashboardCors(handleOverview(database, options.version(), url.searchParams))
        : unavailableResponse();
    }

    if (url.pathname === "/api/v2/orchestrate-runs" && request.method === "GET") {
      if (!database) return unavailableResponse();
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? null : Number.parseInt(rawLimit, 10);
      if (parsedLimit !== null && Number.isNaN(parsedLimit)) {
        return Response.json(
          { error: "Invalid limit" },
          { status: 400, headers: dashboardCorsHeaders() },
        );
      }
      const limit = parsedLimit === null ? 20 : Math.min(Math.max(parsedLimit, 1), 100);
      return withDashboardCors(handleOrchestrateRuns(database, limit));
    }

    if (url.pathname === "/api/v2/analytics" && request.method === "GET") {
      return database ? withDashboardCors(handleAnalytics(database)) : unavailableResponse();
    }

    if (url.pathname.startsWith("/api/v2/skills/") && request.method === "GET") {
      const skillName = decodePathSegment(url.pathname.slice("/api/v2/skills/".length));
      if (skillName === null) {
        return Response.json(
          { error: "Malformed skill name" },
          { status: 400, headers: dashboardCorsHeaders() },
        );
      }
      if (options.skillReportLoader) {
        const report = options.skillReportLoader(skillName);
        return report
          ? Response.json(report, { headers: dashboardCorsHeaders() })
          : Response.json(
              { error: "Skill not found" },
              { status: 404, headers: dashboardCorsHeaders() },
            );
      }
      return database
        ? withDashboardCors(handleSkillReport(database, skillName, url.searchParams))
        : unavailableResponse();
    }

    return null;
  };

  return {
    dataAvailable: Boolean(options.overviewLoader || database),
    handle,
  };
}
