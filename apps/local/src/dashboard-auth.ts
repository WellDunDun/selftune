import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { dashboardCorsHeaders } from "./dashboard-http.js";

interface LoginThrottleEntry {
  blockedUntil: number;
  failures: number;
  windowStartedAt: number;
}

export interface DashboardAuth {
  readonly handleSessionRoute: (
    request: Request,
    url: URL,
    allowedOrigins: ReadonlySet<string>,
  ) => Promise<Response | null>;
  readonly authorize: (request: Request, url: URL) => Response | null;
}

export interface DashboardAuthOptions {
  readonly token?: string;
  readonly cookie?: boolean;
  readonly cookieSecure?: boolean;
}

const LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1_000;
const LOGIN_BLOCK_MS = 15 * 60 * 1_000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_THROTTLE_BUCKET_LIMIT = 2_048;

function tokenMatches(suppliedToken: string, expectedToken: string): boolean {
  const supplied = Buffer.from(suppliedToken, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function dashboardSessionToken(authToken: string): string {
  return createHash("sha256")
    .update("selftune-dashboard-session\0", "utf8")
    .update(authToken, "utf8")
    .digest("base64url");
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(valueParts.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

function hasValidToken(request: Request, expectedToken: string | undefined, allowCookie: boolean) {
  if (!expectedToken) return true;
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return tokenMatches(authorization.slice("Bearer ".length), expectedToken);
  }
  const cookieToken = allowCookie ? cookieValue(request, "selftune_session") : null;
  return cookieToken !== null && tokenMatches(cookieToken, dashboardSessionToken(expectedToken));
}

function loginCredentialFingerprint(token: string | null, key: Uint8Array): string {
  return createHmac("sha256", key)
    .update(token === null ? "missing" : `token\0${token}`, "utf8")
    .digest("base64url");
}

function pruneLoginThrottle(entries: Map<string, LoginThrottleEntry>, now: number): void {
  for (const [key, entry] of entries) {
    if (entry.blockedUntil <= now && now - entry.windowStartedAt > LOGIN_FAILURE_WINDOW_MS) {
      entries.delete(key);
    }
  }
  while (entries.size > LOGIN_THROTTLE_BUCKET_LIMIT) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}

function loginHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in to SelfTune</title>
    <style>
      :root { color-scheme: dark; --bg: #101214; --panel: #171a1e; --line: #30343a; --text: #f4f5f6; --muted: #a8adb5; --accent: #57b88a; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(380px, 100%); border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 28px; }
      .mark { width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 7px; color: var(--accent); font-weight: 700; }
      h1 { margin: 20px 0 8px; font-size: 20px; letter-spacing: 0; }
      p { margin: 0 0 20px; color: var(--muted); font-size: 13px; line-height: 1.5; }
      label { display: grid; gap: 7px; color: var(--muted); font-size: 12px; }
      input { width: 100%; min-height: 40px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); padding: 0 11px; font: inherit; }
      button { width: 100%; min-height: 40px; margin-top: 12px; border: 0; border-radius: 6px; background: var(--accent); color: #0b1711; font: inherit; font-weight: 650; cursor: pointer; }
      #error { min-height: 18px; margin: 12px 0 0; color: #ee8178; font-size: 12px; }
    </style>
  </head>
  <body>
    <main>
      <div class="mark">ST</div>
      <h1>SelfTune</h1>
      <p>Enter the access token configured by this SelfTune host.</p>
      <form id="login">
        <label>Access token<input name="token" type="password" autocomplete="current-password" required /></label>
        <button type="submit">Sign In</button>
        <p id="error"></p>
      </form>
    </main>
    <script>
      document.getElementById("login").addEventListener("submit", async (event) => {
        event.preventDefault();
        const token = new FormData(event.currentTarget).get("token");
        const response = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (response.ok) { location.replace("/"); return; }
        document.getElementById("error").textContent = "The access token is not valid.";
      });
    </script>
  </body>
</html>`;
}

export function createDashboardAuth(options: DashboardAuthOptions): DashboardAuth {
  const loginThrottle = new Map<string, LoginThrottleEntry>();
  const loginThrottleKey = randomBytes(32);

  const handleSessionRoute = async (
    request: Request,
    url: URL,
    allowedOrigins: ReadonlySet<string>,
  ): Promise<Response | null> => {
    if (!options.cookie) return null;
    if (url.pathname === "/login" && request.method === "GET") {
      if (hasValidToken(request, options.token, true)) {
        return new Response(null, { status: 302, headers: { Location: "/" } });
      }
      return new Response(loginHtml(), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
          "Content-Type": "text/html; charset=utf-8",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      });
    }

    if (url.pathname === "/api/auth/session" && request.method === "POST") {
      const requestOrigin = request.headers.get("origin");
      if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
        return Response.json(
          { error: { code: "AUTH_ORIGIN_DENIED", message: "Sign-in origin is not allowed." } },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      let token: string | null = null;
      try {
        const body: unknown = await request.json();
        if (
          typeof body === "object" &&
          body !== null &&
          "token" in body &&
          typeof body.token === "string"
        ) {
          token = body.token;
        }
      } catch {
        token = null;
      }

      if (!options.token || token === null || !tokenMatches(token, options.token)) {
        const now = Date.now();
        pruneLoginThrottle(loginThrottle, now);
        const credentialFingerprint = loginCredentialFingerprint(token, loginThrottleKey);
        const throttle = loginThrottle.get(credentialFingerprint);
        if (throttle && throttle.blockedUntil > now) {
          return Response.json(
            { error: { code: "AUTH_THROTTLED", message: "Too many failed sign-in attempts." } },
            {
              status: 429,
              headers: {
                "Cache-Control": "no-store",
                "Retry-After": String(Math.ceil((throttle.blockedUntil - now) / 1_000)),
              },
            },
          );
        }
        const activeWindow =
          throttle && now - throttle.windowStartedAt <= LOGIN_FAILURE_WINDOW_MS
            ? throttle
            : { failures: 0, windowStartedAt: now, blockedUntil: 0 };
        const failures = activeWindow.failures + 1;
        loginThrottle.set(credentialFingerprint, {
          failures,
          windowStartedAt: activeWindow.windowStartedAt,
          blockedUntil: failures >= LOGIN_FAILURE_LIMIT ? now + LOGIN_BLOCK_MS : 0,
        });
        pruneLoginThrottle(loginThrottle, now);
        return Response.json(
          { error: { code: "AUTH_INVALID", message: "The access token is not valid." } },
          { status: 401, headers: { ...dashboardCorsHeaders(), "Cache-Control": "no-store" } },
        );
      }

      const credentialFingerprint = loginCredentialFingerprint(token, loginThrottleKey);
      loginThrottle.delete(credentialFingerprint);
      const secure = options.cookieSecure ?? url.protocol === "https:";
      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": `selftune_session=${encodeURIComponent(dashboardSessionToken(options.token))}; HttpOnly; Path=/; SameSite=Strict; Max-Age=2592000${secure ? "; Secure" : ""}`,
        },
      });
    }

    if (url.pathname === "/api/auth/session" && request.method === "DELETE") {
      const requestOrigin = request.headers.get("origin");
      if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
        return Response.json(
          { error: { code: "AUTH_ORIGIN_DENIED", message: "Sign-out origin is not allowed." } },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": "selftune_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0",
        },
      });
    }
    return null;
  };

  const authorize = (request: Request, url: URL): Response | null => {
    if (hasValidToken(request, options.token, options.cookie === true)) return null;
    if (
      options.cookie &&
      request.method === "GET" &&
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/badge/") &&
      !url.pathname.startsWith("/report/")
    ) {
      return new Response(null, { status: 302, headers: { Location: "/login" } });
    }
    return Response.json(
      {
        error: {
          code: "AUTH_MISSING",
          message: "A valid local bearer token is required.",
        },
      },
      {
        status: 401,
        headers: { ...dashboardCorsHeaders(), "WWW-Authenticate": "Bearer" },
      },
    );
  };

  return { handleSessionRoute, authorize };
}
