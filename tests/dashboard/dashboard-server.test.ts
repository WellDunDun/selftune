import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  OverviewResponse,
  SkillReportResponse,
} from "../../cli/selftune/dashboard-contract.js";

let startDashboardServer: typeof import("../../cli/selftune/dashboard-server.js").startDashboardServer;
let testSpaDir: string;

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
    },
  ],
  version: "0.2.1-test",
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
  duration_stats: {
    avg_duration_ms: 0,
    total_duration_ms: 0,
    execution_count: 0,
    total_errors: 0,
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

beforeAll(async () => {
  const mod = await import("../../cli/selftune/dashboard-server.js");
  startDashboardServer = mod.startDashboardServer;
  testSpaDir = mkdtempSync(join(tmpdir(), "selftune-dashboard-test-"));
  mkdirSync(join(testSpaDir, "assets"), { recursive: true });
  writeFileSync(
    join(testSpaDir, "index.html"),
    `<!DOCTYPE html><html lang="en"><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`,
  );
  writeFileSync(join(testSpaDir, "assets", "app.js"), "console.log('selftune test spa');\n");
});

describe("dashboard-server", () => {
  let serverPromise: ReturnType<typeof startDashboardServer> | null = null;

  async function getServer(): Promise<Awaited<ReturnType<typeof startDashboardServer>>> {
    if (!serverPromise) {
      serverPromise = startDashboardServer({
        port: 0,
        host: "127.0.0.1",
        spaDir: testSpaDir,
        openBrowser: false,
        overviewLoader: () => overviewFixture,
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
        actionRunner: async (command) => ({
          success: command !== "rollback",
          output: `${command} ok`,
          error: command === "rollback" ? "rollback blocked in test" : null,
        }),
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
      expect(Array.isArray(data.skills)).toBe(true);
      expect(data.skills[0]?.skill_name).toBe("test-skill");
    });

    it("includes CORS headers", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v2/overview`);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill: "test-skill", skillPath: "/tmp/test-skill" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("evolve returns JSON response", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/actions/evolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill: "test-skill", skillPath: "/tmp/test-skill" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("rollback validates proposalId", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/actions/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skill: "test-skill",
          skillPath: "/tmp/test-skill",
          proposalId: "proposal-123",
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(false);
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
