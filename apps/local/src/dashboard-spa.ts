import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import type { HealthResponse } from "@selftune/runtime/dashboard-contract";
import { findSelftunePackageRoot } from "@selftune/runtime/package-root";

import { dashboardCorsHeaders } from "./dashboard-http.js";

export interface DashboardSpa {
  readonly available: boolean;
  readonly buildId: () => string;
  readonly directory: string | null;
  readonly fallback: (request: Request, url: URL) => Promise<Response | null>;
  readonly gitSha: () => string;
  readonly handlePrimaryRequest: (request: Request, url: URL) => Promise<Response | null>;
  readonly mode: NonNullable<HealthResponse["spa_mode"]>;
  readonly proxyUrl: URL | null;
  readonly upgradeTarget: (request: Request, url: URL) => string | null;
  readonly version: () => string;
  readonly workspaceRoot: string;
}

export interface DashboardSpaOptions {
  readonly directory?: string;
  readonly proxyUrl?: string;
}

const MIME_TYPES = new Map(
  Object.entries({
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  }),
);

function normalizeProxyUrl(rawValue: string | undefined): URL | null {
  if (!rawValue) return null;
  try {
    const url = new URL(rawValue);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function shouldProxy(pathname: string): boolean {
  return (
    !pathname.startsWith("/api/") &&
    !pathname.startsWith("/badge/") &&
    !pathname.startsWith("/report/")
  );
}

function discoverDirectory(workspaceRoot: string): string | null {
  const candidates = [
    join(workspaceRoot, "apps", "local-dashboard", "dist"),
    resolve("apps", "local-dashboard", "dist"),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? null;
}

async function serveShell(directory: string | null): Promise<Response> {
  if (!directory) {
    return new Response("Dashboard build not found. Run `bun run build:dashboard` first.", {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        ...dashboardCorsHeaders(),
      },
    });
  }

  const indexFile = Bun.file(join(directory, "index.html"));
  if (!(await indexFile.exists())) {
    return updatingAssetsResponse();
  }

  try {
    return new Response(await indexFile.text(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...dashboardCorsHeaders(),
      },
    });
  } catch {
    return updatingAssetsResponse();
  }
}

function updatingAssetsResponse(): Response {
  return new Response(
    "Dashboard assets are updating. Retry in a moment or run `selftune dashboard --restart`.",
    {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Retry-After": "1",
        ...dashboardCorsHeaders(),
      },
    },
  );
}

async function proxyRequest(request: Request, proxyUrl: URL, url: URL): Promise<Response> {
  const targetUrl = new URL(`${url.pathname}${url.search}`, proxyUrl);
  const headers = new Headers(request.headers);
  headers.set("host", targetUrl.host);
  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      redirect: "manual",
    });
    const responseHeaders = new Headers(upstream.headers);
    for (const [key, value] of Object.entries(dashboardCorsHeaders())) {
      responseHeaders.set(key, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Dashboard SPA proxy unavailable at ${proxyUrl.toString()}: ${message}`, {
      status: 502,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        ...dashboardCorsHeaders(),
      },
    });
  }
}

async function serveAsset(directory: string, pathname: string): Promise<Response> {
  const filePath = resolve(directory, `.${pathname}`);
  const relativePath = relative(directory, filePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return new Response("Not Found", { status: 404, headers: dashboardCorsHeaders() });
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response("Not Found", { status: 404, headers: dashboardCorsHeaders() });
  }
  const extension = extname(filePath);
  return new Response(file, {
    headers: {
      "Content-Type": MIME_TYPES.get(extension) ?? "application/octet-stream",
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      ...dashboardCorsHeaders(),
    },
  });
}

export function createDashboardSpa(options: DashboardSpaOptions = {}): DashboardSpa {
  const workspaceRoot = findSelftunePackageRoot();
  const packagePath = join(workspaceRoot, "package.json");
  const proxyUrl = normalizeProxyUrl(options.proxyUrl ?? process.env.SPA_PROXY_URL);
  const requestedDirectory = options.directory ?? discoverDirectory(workspaceRoot);
  const directory =
    requestedDirectory && existsSync(join(requestedDirectory, "index.html"))
      ? requestedDirectory
      : null;
  let cachedGitSha: string | null = null;

  const version = (): string => {
    if (process.env.SELFTUNE_VERSION) return process.env.SELFTUNE_VERSION;
    try {
      return JSON.parse(readFileSync(packagePath, "utf8")).version;
    } catch {
      return "unknown";
    }
  };

  const gitSha = (): string => {
    if (cachedGitSha !== null) return cachedGitSha;
    try {
      const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
      cachedGitSha = result.stdout.toString().trim() || "unknown";
    } catch {
      cachedGitSha = "unknown";
    }
    return cachedGitSha;
  };

  return {
    available: Boolean(directory || proxyUrl),
    buildId: () => process.env.SELFTUNE_SPA_BUILD_ID || version(),
    directory,
    fallback: (request, url) =>
      directory && request.method === "GET" && !url.pathname.startsWith("/api/")
        ? serveShell(directory)
        : Promise.resolve(null),
    gitSha,
    handlePrimaryRequest: (request, url) => {
      if (proxyUrl && request.method === "GET" && shouldProxy(url.pathname)) {
        return proxyRequest(request, proxyUrl, url);
      }
      if (directory && request.method === "GET" && url.pathname.startsWith("/assets/")) {
        return serveAsset(directory, url.pathname);
      }
      if (url.pathname === "/" && request.method === "GET") {
        return serveShell(directory);
      }
      return Promise.resolve(null);
    },
    mode: proxyUrl ? "proxy" : directory ? "dist" : "missing",
    proxyUrl,
    upgradeTarget: (request, url) => {
      if (
        !proxyUrl ||
        request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
        !shouldProxy(url.pathname)
      ) {
        return null;
      }
      const upstreamUrl = new URL(`${url.pathname}${url.search}`, proxyUrl);
      upstreamUrl.protocol = proxyUrl.protocol === "https:" ? "wss:" : "ws:";
      return upstreamUrl.toString();
    },
    version,
    workspaceRoot,
  };
}
