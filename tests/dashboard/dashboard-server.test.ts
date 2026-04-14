import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DashboardActionEvent,
  OverviewResponse,
  SkillReportResponse,
} from "../../cli/selftune/dashboard-contract.js";

let startDashboardServer: typeof import("../../cli/selftune/dashboard-server.js").startDashboardServer;
let loadWatchedSkills: typeof import("../../cli/selftune/watchlist.js").loadWatchedSkills;
let testSpaDir: string;
let configDir: string;
let originalSelftuneConfigDir: string | undefined;

const overviewFixture: OverviewResponse = {
  overview: {
    telemetry: [
      {
        timestamp: "2026-03-12T10:00:00Z",
        session_id: "sess-1",
        skills_triggered: ["test-skill"],
        errors_encountered: 0,
        total_tool_calls: 3,
      },
    ],
    skills: [
      {
        timestamp: "2026-03-12T10:00:00Z",
        session_id: "sess-1",
        skill_name: "test-skill",
        skill_path: "/tmp/test-skill/SKILL.md",
        query: "test prompt",
        triggered: true,
        source: "claude_code_repair",
      },
    ],
    evolution: [],
    counts: {
      telemetry: 1,
      skills: 1,
      evolution: 0,
      evidence: 1,
      sessions: 1,
      prompts: 1,
    },
    unmatched_queries: [],
    pending_proposals: [],
    active_sessions: 0,
    recent_activity: [],
  },
  skills: [
    {
      skill_name: "test-skill",
      skill_scope: "global",
      total_checks: 1,
      triggered_count: 1,
      pass_rate: 1,
      unique_sessions: 1,
      last_seen: "2026-03-12T10:00:00Z",
      has_evidence: true,
      routing_confidence: 1,
      confidence_coverage: 1,
    },
  ],
  version: "0.2.1-test",
  watched_skills: [],
  autonomy_status: {
    level: "healthy",
    summary: "All good",
    last_run: null,
    skills_observed: 1,
    pending_reviews: 0,
    attention_required: 0,
  },
  attention_queue: [],
  trust_watchlist: [],
  recent_decisions: [],
};

const skillReportFixture: SkillReportResponse = {
  skill_name: "test-skill",
  usage: {
    total_checks: 1,
    triggered_count: 1,
    pass_rate: 1,
  },
  recent_invocations: [
    {
      timestamp: "2026-03-12T10:00:00Z",
      session_id: "sess-1",
      query: "test prompt",
      triggered: true,
      source: "claude_code_repair",
    },
  ],
  evidence: [],
  sessions_with_skill: 1,
  evolution: [],
  pending_proposals: [],
  token_usage: {
    total_input_tokens: 0,
    total_output_tokens: 0,
  },
  canonical_invocations: [],
  trust: {
    state: "validated",
    summary: "Healthy sample",
  },
  coverage: {
    checks: 1,
    sessions: 1,
    workspaces: 1,
    first_seen: "2026-03-12T10:00:00Z",
    last_seen: "2026-03-12T10:00:00Z",
  },
  evidence_quality: {
    prompt_link_rate: 1,
    inline_query_rate: 1,
    user_prompt_rate: 1,
    meta_prompt_rate: 0,
    internal_prompt_rate: 0,
    no_prompt_rate: 0,
    system_like_rate: 0,
    invocation_mode_coverage: 1,
    confidence_coverage: 1,
    source_coverage: 1,
    scope_coverage: 1,
  },
  routing_quality: {
    missed_triggers: 0,
    miss_rate: 0,
    avg_confidence: 1,
    confidence_coverage: 1,
    low_confidence_rate: 0,
  },
  evolution_state: {
    has_evidence: false,
    has_pending_proposals: false,
    latest_action: null,
    latest_timestamp: null,
    evidence_rows: 0,
    evolution_rows: 0,
  },
  data_hygiene: {
    naming_variants: [],
    source_breakdown: [],
    prompt_kind_breakdown: [],
    observation_breakdown: [],
    raw_checks: 1,
    operational_checks: 1,
    internal_prompt_rows: 0,
    internal_prompt_rate: 0,
    legacy_rows: 0,
    legacy_rate: 0,
    repaired_rows: 0,
    repaired_rate: 0,
  },
  examples: {
    good: [],
    missed: [],
    noisy: [],
  },
  duration_stats: {
    avg_duration_ms: 0,
    total_duration_ms: 0,
    execution_count: 0,
    missed_triggers: 0,
  },
  selftune_stats: {
    total_llm_calls: 0,
    total_elapsed_ms: 0,
    avg_elapsed_ms: 0,
    run_count: 0,
  },
  prompt_samples: [],
  session_metadata: [],
};

async function readSseEvents(
  response: Response,
  targetEventType: string,
  expectedCount: number,
): Promise<string[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing SSE response body");

  const decoder = new TextDecoder();
  const payloads: string[] = [];
  let buffer = "";

  while (payloads.length < expectedCount) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const lines = frame.split("\n");
      const eventType = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (eventType === targetEventType && data) {
        payloads.push(data);
        if (payloads.length >= expectedCount) break;
      }
    }
  }

  await reader.cancel();
  return payloads;
}

beforeAll(async () => {
  originalSelftuneConfigDir = process.env.SELFTUNE_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "selftune-dashboard-config-"));
  process.env.SELFTUNE_CONFIG_DIR = configDir;
  const mod = await import("../../cli/selftune/dashboard-server.js");
  const watchlist = await import("../../cli/selftune/watchlist.js");
  startDashboardServer = mod.startDashboardServer;
  loadWatchedSkills = watchlist.loadWatchedSkills;
  testSpaDir = mkdtempSync(join(tmpdir(), "selftune-dashboard-test-"));
  mkdirSync(join(testSpaDir, "assets"), { recursive: true });
  writeFileSync(
    join(testSpaDir, "index.html"),
    `<!DOCTYPE html><html lang="en"><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`,
  );
  writeFileSync(join(testSpaDir, "assets", "app.js"), "console.log('selftune test spa');\n");
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
  if (originalSelftuneConfigDir === undefined) {
    delete process.env.SELFTUNE_CONFIG_DIR;
  } else {
    process.env.SELFTUNE_CONFIG_DIR = originalSelftuneConfigDir;
  }
});

describe("dashboard-server", () => {
  let serverPromise: ReturnType<typeof startDashboardServer> | null = null;
  let lastActionInvocation: { command: string; args: string[] } | null = null;

  async function getServer(): Promise<Awaited<ReturnType<typeof startDashboardServer>>> {
    if (!serverPromise) {
      serverPromise = startDashboardServer({
        port: 0,
        host: "127.0.0.1",
        spaDir: testSpaDir,
        openBrowser: false,
        overviewLoader: () => ({
          ...overviewFixture,
          watched_skills: loadWatchedSkills(),
        }),
        skillReportLoader: (skillName) => (skillName === "test-skill" ? skillReportFixture : null),
        statusLoader: () => ({
          skills: [
            {
              name: "test-skill",
              passRate: 1,
              trend: "stable",
              missedQueries: 0,
              status: "HEALTHY",
              snapshot: null,
            },
          ],
          unmatchedQueries: 0,
          pendingProposals: 0,
          lastSession: "2026-03-12T10:00:00Z",
          system: {
            healthy: true,
            pass: 1,
            fail: 0,
            warn: 0,
          },
        }),
        evidenceLoader: () => [],
        actionRunner: async (command, args) => {
          lastActionInvocation = { command, args };
          const isRollback = command === "evolve" && args[0] === "rollback";
          return {
            success: !isRollback,
            output: `${command} ok`,
            error: isRollback ? "rollback blocked in test" : null,
            exitCode: isRollback ? 1 : 0,
          };
        },
      });
    }

    return serverPromise;
  }

  async function readRootHtml(): Promise<string> {
    const server = await getServer();
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    return res.text();
  }

  afterAll(async () => {
    if (serverPromise) {
      const server = await serverPromise;
      server.stop();
    }
  });

  describe("GET /", () => {
    it("returns 200 with HTML content", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    });

    it("serves the SPA shell", async () => {
      const html = await readRootHtml();
      expect(html).toContain('<div id="root"></div>');
      expect(html).toContain("/assets/");
    });

    it("proxies SPA shell and assets when spaProxyUrl is configured", async () => {
      const proxiedRequests: string[] = [];
      const proxyServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          const url = new URL(req.url);
          proxiedRequests.push(`${req.method} ${url.pathname}`);
          if (url.pathname === "/") {
            return new Response("<!DOCTYPE html><html><body>proxied dashboard</body></html>", {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          if (url.pathname === "/src/main.tsx") {
            return new Response("console.log('proxied vite asset');", {
              headers: {
                "Content-Type": "application/javascript; charset=utf-8",
              },
            });
          }
          return new Response("Not Found", { status: 404 });
        },
      });

      const server = await startDashboardServer({
        port: 0,
        host: "127.0.0.1",
        spaProxyUrl: `http://127.0.0.1:${proxyServer.port}`,
        openBrowser: false,
        overviewLoader: () => ({
          ...overviewFixture,
          watched_skills: loadWatchedSkills(),
        }),
        skillReportLoader: (skillName) => (skillName === "test-skill" ? skillReportFixture : null),
        statusLoader: () => ({
          skills: [],
          unmatchedQueries: 0,
          pendingProposals: 0,
          lastSession: null,
          system: {
            healthy: true,
            pass: 1,
            fail: 0,
            warn: 0,
          },
        }),
        evidenceLoader: () => [],
      });

      try {
        const shellResponse = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(shellResponse.status).toBe(200);
        await expect(shellResponse.text()).resolves.toContain("proxied dashboard");

        const assetResponse = await fetch(`http://127.0.0.1:${server.port}/src/main.tsx`);
        expect(assetResponse.status).toBe(200);
        await expect(assetResponse.text()).resolves.toContain("proxied vite asset");

        const healthResponse = await fetch(`http://127.0.0.1:${server.port}/api/health`);
        const health = await healthResponse.json();
        expect(health.spa).toBe(true);
        expect(health.spa_mode).toBe("proxy");
        expect(health.spa_proxy_url).toBe(`http://127.0.0.1:${proxyServer.port}/`);

        expect(proxiedRequests).toEqual(expect.arrayContaining(["GET /", "GET /src/main.tsx"]));
      } finally {
        server.stop();
        proxyServer.stop();
      }
    });

    it("returns 503 instead of ENOENT when the SPA shell disappears mid-run", async () => {
      const flakySpaDir = mkdtempSync(join(tmpdir(), "selftune-dashboard-flaky-"));
      writeFileSync(
        join(flakySpaDir, "index.html"),
        "<!DOCTYPE html><html><body>temporary dashboard</body></html>",
      );

      const server = await startDashboardServer({
        port: 0,
        host: "127.0.0.1",
        spaDir: flakySpaDir,
        openBrowser: false,
        overviewLoader: () => ({
          ...overviewFixture,
          watched_skills: loadWatchedSkills(),
        }),
        skillReportLoader: (skillName) => (skillName === "test-skill" ? skillReportFixture : null),
        statusLoader: () => ({
          skills: [],
          unmatchedQueries: 0,
          pendingProposals: 0,
          lastSession: null,
          system: {
            healthy: true,
            pass: 1,
            fail: 0,
            warn: 0,
          },
        }),
        evidenceLoader: () => [],
      });

      try {
        rmSync(join(flakySpaDir, "index.html"), { force: true });

        const rootResponse = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(rootResponse.status).toBe(503);
        await expect(rootResponse.text()).resolves.toContain("Dashboard assets are updating");

        const routeResponse = await fetch(`http://127.0.0.1:${server.port}/skills/test-skill`);
        expect(routeResponse.status).toBe(503);
        await expect(routeResponse.text()).resolves.toContain("Dashboard assets are updating");
      } finally {
        server.stop();
        rmSync(flakySpaDir, { recursive: true, force: true });
      }
    });
  });

  describe("GET /api/v2/overview", () => {
    it("returns 200 with JSON", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v2/overview`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
    });

    it("returns the overview payload contract", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v2/overview`);
      const data = await res.json();
      expect(data).toHaveProperty("overview");
      expect(data).toHaveProperty("skills");
      expect(data).toHaveProperty("version");
      expect(Array.isArray(data.overview.telemetry)).toBe(true);
      expect(typeof data.overview.active_sessions).toBe("number");
      expect(Array.isArray(data.overview.recent_activity)).toBe(true);
      expect(Array.isArray(data.skills)).toBe(true);
      expect(Array.isArray(data.watched_skills)).toBe(true);
      expect(data.skills[0]?.skill_name).toBe("test-skill");
    });

    it("includes CORS headers", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v2/overview`);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
  });

  describe("GET /api/health", () => {
    it("returns runtime identity including the serving process pid", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.service).toBe("selftune-dashboard");
      expect(data.port).toBe(server.port);
      expect(typeof data.pid).toBe("number");
      expect(data.pid).toBeGreaterThan(0);
      expect(data.spa_mode).toBe("dist");
      expect(data.spa_build_id).toBeTruthy();
      expect(typeof data.update_available).toBe("boolean");
      expect(typeof data.auto_update_supported).toBe("boolean");
      expect(data).toHaveProperty("latest_version");
      expect(data).toHaveProperty("update_hint");
    });
  });

  describe("GET /api/v2/skills/:name", () => {
    it("returns 200 with JSON", async () => {
      const server = await getServer();
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/v2/skills/${encodeURIComponent("test-skill")}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
    });

    it("returns the skill report payload contract", async () => {
      const server = await getServer();
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/v2/skills/${encodeURIComponent("test-skill")}`,
      );
      const data = await res.json();
      expect(data.skill_name).toBe("test-skill");
      expect(data.usage.pass_rate).toBe(1);
      expect(Array.isArray(data.recent_invocations)).toBe(true);
      expect(Array.isArray(data.evolution)).toBe(true);
      expect(Array.isArray(data.pending_proposals)).toBe(true);
    });

    it("returns 404 for an unknown skill", async () => {
      const server = await getServer();
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/v2/skills/${encodeURIComponent("missing")}`,
      );
      expect(res.status).toBe(404);
    });

    it("returns 400 for malformed skill-name encoding", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v2/skills/%E0%A4%A`);
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/actions/*", () => {
    it("watch returns JSON response", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/actions/watch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `http://127.0.0.1:${server.port}`,
        },
        body: JSON.stringify({
          skill: "test-skill",
          skillPath: "/tmp/test-skill",
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("generate-evals writes to the canonical eval-set path instead of repo cwd", async () => {
      let capturedCommand: string | null = null;
      let capturedArgs: string[] = [];
      const server = await startDashboardServer({
        port: 0,
        host: "127.0.0.1",
        spaDir: testSpaDir,
        openBrowser: false,
        overviewLoader: () => ({
          ...overviewFixture,
          watched_skills: loadWatchedSkills(),
        }),
        skillReportLoader: (skillName) => (skillName === "test-skill" ? skillReportFixture : null),
        statusLoader: () => ({
          skills: [],
          unmatchedQueries: 0,
          pendingProposals: 0,
          lastSession: null,
          system: { healthy: true, pass: 1, fail: 0, warn: 0 },
        }),
        evidenceLoader: () => [],
        actionRunner: async (command, args) => {
          capturedCommand = command;
          capturedArgs = args;
          return {
            success: true,
            output: "ok",
            error: null,
            exitCode: 0,
          };
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/actions/generate-evals`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: `http://127.0.0.1:${server.port}`,
          },
          body: JSON.stringify({
            skill: "test-skill",
            skillPath: "/tmp/test-skill/SKILL.md",
          }),
        });

        expect(res.status).toBe(200);
        expect(capturedCommand).toBe("eval");
        expect(capturedArgs).toEqual([
          "generate",
          "--skill",
          "test-skill",
          "--skill-path",
          "/tmp/test-skill/SKILL.md",
          "--output",
          join(configDir, "eval-sets", "test-skill.json"),
        ]);
      } finally {
        server.stop();
      }
    });

    it("generate-unit-tests writes to the canonical unit-test path", async () => {
      let capturedCommand: string | null = null;
      let capturedArgs: string[] = [];
      const server = await startDashboardServer({
        port: 0,
        host: "127.0.0.1",
        spaDir: testSpaDir,
        openBrowser: false,
        overviewLoader: () => ({
          ...overviewFixture,
          watched_skills: loadWatchedSkills(),
        }),
        skillReportLoader: (skillName) => (skillName === "test-skill" ? skillReportFixture : null),
        statusLoader: () => ({
          skills: [],
          unmatchedQueries: 0,
          pendingProposals: 0,
          lastSession: null,
          system: { healthy: true, pass: 1, fail: 0, warn: 0 },
        }),
        evidenceLoader: () => [],
        actionRunner: async (command, args) => {
          capturedCommand = command;
          capturedArgs = args;
          return {
            success: true,
            output: "ok",
            error: null,
            exitCode: 0,
          };
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/actions/generate-unit-tests`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: `http://127.0.0.1:${server.port}`,
          },
          body: JSON.stringify({
            skill: "test-skill",
            skillPath: "/tmp/test-skill/SKILL.md",
          }),
        });

        expect(res.status).toBe(200);
        expect(capturedCommand).toBe("eval");
        expect(capturedArgs).toEqual([
          "unit-test",
          "--skill",
          "test-skill",
          "--generate",
          "--skill-path",
          "/tmp/test-skill/SKILL.md",
          "--tests",
          join(configDir, "unit-tests", "test-skill.json"),
        ]);
      } finally {
        server.stop();
      }
    });

    it("evolve returns JSON response", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/actions/evolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `http://127.0.0.1:${server.port}`,
        },
        body: JSON.stringify({
          skill: "test-skill",
          skillPath: "/tmp/test-skill",
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("rollback validates proposalId", async () => {
      lastActionInvocation = null;
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/actions/rollback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `http://127.0.0.1:${server.port}`,
        },
        body: JSON.stringify({
          skill: "test-skill",
          skillPath: "/tmp/test-skill",
          proposalId: "proposal-123",
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(lastActionInvocation).toEqual({
        command: "evolve",
        args: [
          "rollback",
          "--skill",
          "test-skill",
          "--skill-path",
          "/tmp/test-skill",
          "--proposal-id",
          "proposal-123",
        ],
      });
    });

    it("watchlist persists watched skills", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/actions/watchlist`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `http://127.0.0.1:${server.port}`,
        },
        body: JSON.stringify({ skills: ["pptx", "sc-search"] }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        success: boolean;
        watched_skills: string[];
      };
      expect(data.success).toBe(true);
      expect(data.watched_skills).toEqual(["pptx", "sc-search"]);

      server.stop();
      serverPromise = null;

      const reloadedServer = await getServer();
      const overviewRes = await fetch(`http://127.0.0.1:${reloadedServer.port}/api/v2/overview`);
      expect(overviewRes.status).toBe(200);
      const overview = (await overviewRes.json()) as OverviewResponse;
      expect(overview.watched_skills).toEqual(["pptx", "sc-search"]);
    });

    it("rejects cross-origin action requests", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/actions/watch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({
          skill: "test-skill",
          skillPath: "/tmp/test-skill",
        }),
      });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain("same-origin");
    });

    it("streams action lifecycle events over SSE", async () => {
      const server = await startDashboardServer({
        port: 0,
        host: "127.0.0.1",
        spaDir: testSpaDir,
        openBrowser: false,
        overviewLoader: () => ({
          ...overviewFixture,
          watched_skills: loadWatchedSkills(),
        }),
        skillReportLoader: (skillName) => (skillName === "test-skill" ? skillReportFixture : null),
        statusLoader: () => ({
          skills: [],
          unmatchedQueries: 0,
          pendingProposals: 0,
          lastSession: null,
          system: { healthy: true, pass: 1, fail: 0, warn: 0 },
        }),
        evidenceLoader: () => [],
        actionRunner: async (_command, _args, hooks) => {
          hooks?.onStdout?.("planning evals\n");
          hooks?.onStderr?.("warming model\n");
          await Bun.sleep(10);
          hooks?.onStdout?.("done\n");
          return {
            success: true,
            output: "planning evals\ndone\n",
            error: null,
            exitCode: 0,
          };
        },
      });

      try {
        const eventsResponse = await fetch(`http://127.0.0.1:${server.port}/api/v2/events`);
        const eventPromise = readSseEvents(eventsResponse, "action", 5);

        const actionResponse = await fetch(
          `http://127.0.0.1:${server.port}/api/actions/generate-evals`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: `http://127.0.0.1:${server.port}`,
            },
            body: JSON.stringify({
              skill: "test-skill",
              skillPath: "/tmp/test-skill/SKILL.md",
            }),
          },
        );
        expect(actionResponse.status).toBe(200);

        const payloads = (await eventPromise).map(
          (payload) => JSON.parse(payload) as DashboardActionEvent,
        );
        expect(payloads.map((payload) => payload.stage)).toEqual([
          "started",
          "stdout",
          "stderr",
          "stdout",
          "finished",
        ]);
        expect(payloads[0]?.action).toBe("generate-evals");
        expect(payloads[1]?.chunk).toContain("planning evals");
        expect(payloads[2]?.chunk).toContain("warming model");
        expect(payloads[4]?.success).toBe(true);
      } finally {
        server.stop();
      }
    });

    it("replays recent action lifecycle events to late SSE subscribers", async () => {
      const server = await startDashboardServer({
        port: 0,
        host: "127.0.0.1",
        spaDir: testSpaDir,
        openBrowser: false,
        overviewLoader: () => ({
          ...overviewFixture,
          watched_skills: loadWatchedSkills(),
        }),
        skillReportLoader: (skillName) => (skillName === "test-skill" ? skillReportFixture : null),
        statusLoader: () => ({
          skills: [],
          unmatchedQueries: 0,
          pendingProposals: 0,
          lastSession: null,
          system: { healthy: true, pass: 1, fail: 0, warn: 0 },
        }),
        evidenceLoader: () => [],
        actionRunner: async (_command, _args, hooks) => {
          hooks?.onStdout?.("planning evals\n");
          hooks?.onStderr?.("warming model\n");
          return {
            success: true,
            output: "planning evals\n",
            error: null,
            exitCode: 0,
          };
        },
      });

      try {
        const actionResponse = await fetch(
          `http://127.0.0.1:${server.port}/api/actions/generate-evals`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: `http://127.0.0.1:${server.port}`,
            },
            body: JSON.stringify({
              skill: "test-skill",
              skillPath: "/tmp/test-skill/SKILL.md",
            }),
          },
        );
        expect(actionResponse.status).toBe(200);

        const eventsResponse = await fetch(`http://127.0.0.1:${server.port}/api/v2/events`);
        const payloads = (await readSseEvents(eventsResponse, "action", 4)).map(
          (payload) => JSON.parse(payload) as DashboardActionEvent,
        );
        expect(payloads.map((payload) => payload.stage)).toEqual([
          "started",
          "stdout",
          "stderr",
          "finished",
        ]);
        expect(payloads[0]?.action).toBe("generate-evals");
        expect(payloads[3]?.success).toBe(true);
      } finally {
        server.stop();
      }
    });
  });

  describe("unknown routes", () => {
    it("returns SPA fallback for client-side routes", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/skills/test-skill`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<div id="root"></div>');
    });
  });
});

describe("server lifecycle", () => {
  const statusLoader = () => ({
    skills: [],
    unmatchedQueries: 0,
    pendingProposals: 0,
    lastSession: null,
    system: { healthy: true, pass: 0, fail: 0, warn: 0 },
  });

  it("can start and stop cleanly", async () => {
    const s = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: testSpaDir,
      openBrowser: false,
      overviewLoader: () => overviewFixture,
      skillReportLoader: () => null,
      statusLoader,
    });
    expect(typeof s.port).toBe("number");
    expect(s.port).toBeGreaterThan(0);
    s.stop();
  });

  it("exposes v2 overview after binding", async () => {
    const s = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: testSpaDir,
      openBrowser: false,
      overviewLoader: () => overviewFixture,
      skillReportLoader: () => null,
      statusLoader,
    });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/v2/overview`);
    expect(res.status).toBe(200);
    s.stop();
  });
});

describe("SPA shell loading", () => {
  it("serves / without eagerly loading the overview payload", async () => {
    let overviewLoaderCalls = 0;
    const server = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: testSpaDir,
      openBrowser: false,
      overviewLoader: () => {
        overviewLoaderCalls++;
        return overviewFixture;
      },
      skillReportLoader: () => skillReportFixture,
      statusLoader: () => ({
        skills: [],
        unmatchedQueries: 0,
        pendingProposals: 0,
        lastSession: null,
        system: {
          healthy: true,
          pass: 0,
          fail: 0,
          warn: 0,
        },
      }),
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('<div id="root"></div>');
      expect(overviewLoaderCalls).toBe(0);

      const dataRes = await fetch(`http://127.0.0.1:${server.port}/api/v2/overview`);
      expect(dataRes.status).toBe(200);
      expect(overviewLoaderCalls).toBe(1);
    } finally {
      server.stop();
    }
  });

  it("returns 503 when a configured spaDir is missing index.html", async () => {
    const brokenSpaDir = mkdtempSync(join(tmpdir(), "selftune-dashboard-broken-"));
    mkdirSync(join(brokenSpaDir, "assets"), { recursive: true });

    const server = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: brokenSpaDir,
      openBrowser: false,
      overviewLoader: () => overviewFixture,
      skillReportLoader: () => skillReportFixture,
      statusLoader: () => ({
        skills: [],
        unmatchedQueries: 0,
        pendingProposals: 0,
        lastSession: null,
        system: {
          healthy: true,
          pass: 0,
          fail: 0,
          warn: 0,
        },
      }),
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(503);
    } finally {
      server.stop();
      rmSync(brokenSpaDir, { recursive: true, force: true });
    }
  });
});

describe("report loading", () => {
  it("loads report data without touching the v2 skill-report loader", async () => {
    let skillReportLoaderCalls = 0;
    let evidenceLoaderCalls = 0;

    const server = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: testSpaDir,
      openBrowser: false,
      overviewLoader: () => overviewFixture,
      skillReportLoader: () => {
        skillReportLoaderCalls++;
        return skillReportFixture;
      },
      statusLoader: () => ({
        skills: [
          {
            name: "test-skill",
            passRate: 1,
            trend: "stable",
            missedQueries: 0,
            status: "HEALTHY",
            snapshot: null,
          },
        ],
        unmatchedQueries: 0,
        pendingProposals: 0,
        lastSession: null,
        system: {
          healthy: true,
          pass: 0,
          fail: 0,
          warn: 0,
        },
      }),
      evidenceLoader: () => {
        evidenceLoaderCalls++;
        return [];
      },
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/report/test-skill`);
      expect(res.status).toBe(200);
      expect(skillReportLoaderCalls).toBe(0);
      expect(evidenceLoaderCalls).toBe(1);
    } finally {
      server.stop();
    }
  });
});

afterAll(() => {
  rmSync(testSpaDir, { recursive: true, force: true });
});
