#!/usr/bin/env bun
/**
 * selftune badge service -- Bun.serve entry point.
 *
 * Hosted at selftune.dev, serves dynamic SVG badges and HTML reports
 * from aggregated community contribution data.
 *
 * Endpoints:
 *   POST /api/submit        -- Accept contribution bundles
 *   GET  /badge/:skillName  -- Dynamic SVG badge
 *   GET  /report/:skillName -- HTML skill report
 *   GET  /health            -- Deployment health check
 */

import { loadConfig } from "./config.js";
import { handleBadgeRoute } from "./routes/badge.js";
import { handleHealthRoute } from "./routes/health.js";
import { handleReportRoute } from "./routes/report.js";
import { handleSubmitRoute } from "./routes/submit.js";
import { Store } from "./storage/store.js";

const config = loadConfig();
const store = new Store(config.dbPath);

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const server = Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ---- POST /api/submit ----
    if (url.pathname === "/api/submit" && req.method === "POST") {
      const res = await handleSubmitRoute(req, store, config);
      return withCors(res);
    }

    // ---- GET /badge/:skillName ----
    if (url.pathname.startsWith("/badge/") && req.method === "GET") {
      return withCors(handleBadgeRoute(url, store, config));
    }

    // ---- GET /report/:skillName ----
    if (url.pathname.startsWith("/report/") && req.method === "GET") {
      return withCors(handleReportRoute(url, store));
    }

    // ---- GET /health ----
    if (url.pathname === "/health" && req.method === "GET") {
      return withCors(handleHealthRoute(store));
    }

    // ---- 404 ----
    return withCors(new Response("Not Found", { status: 404 }));
  },
});

console.log(`selftune badge service running on port ${server.port}`);
store.logAudit("startup", `Server started on port ${server.port}`);

// Graceful shutdown
const shutdown = () => {
  console.log("Shutting down...");
  store.close();
  server.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
