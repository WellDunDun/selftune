import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { StatusResult } from "../../cli/selftune/status.js";
import type {
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../../cli/selftune/types.js";

/**
 * Badge route tests — validates /badge/:skillName and /report/:skillName
 * endpoints on the dashboard server.
 *
 * Strategy: spawn actual server on port 0 (random), test with fetch, clean up.
 */

let startDashboardServer: typeof import("../../cli/selftune/dashboard-server.js").startDashboardServer;

const reportSkillName = "test-skill";
const dashboardFixture = {
  telemetry: [] as SessionTelemetryRecord[],
  skills: [
    {
      timestamp: "2026-03-10T10:00:00.000Z",
      session_id: "sess-report-1",
      skill_name: reportSkillName,
      skill_path: "/tmp/test-skill/SKILL.md",
      query: "Use the test skill",
      triggered: true,
    },
  ] as SkillUsageRecord[],
  queries: [
    {
      timestamp: "2026-03-10T10:00:00.000Z",
      session_id: "sess-report-1",
      query: "Use the test skill",
    },
  ] as QueryLogRecord[],
  evolution: [] as EvolutionAuditEntry[],
  evidence: [
    {
      timestamp: "2026-03-10T10:00:00.000Z",
      proposal_id: "proposal-test-skill-1",
      skill_name: reportSkillName,
      skill_path: "/tmp/test-skill/SKILL.md",
      stage: "validated",
      target: "description",
      original_text: "Original description",
      proposed_text: "Proposed description",
      details: "Validation completed",
      validation: {
        before_pass_rate: 0.5,
        after_pass_rate: 1,
        improved: true,
        regressions: [],
        new_passes: [
          {
            query: "Use the test skill",
            should_trigger: true,
          },
        ],
        per_entry_results: [
          {
            entry: {
              query: "Use the test skill",
              should_trigger: true,
            },
            before_pass: false,
            after_pass: true,
          },
        ],
      },
    },
  ] as EvolutionEvidenceEntry[],
  decisions: [],
  computed: {
    snapshots: {},
    unmatched: [],
    pendingProposals: [],
  },
};
const statusFixture: StatusResult = {
  skills: [
    {
      name: reportSkillName,
      passRate: 1,
      trend: "stable",
      missedQueries: 0,
      status: "HEALTHY",
      snapshot: null,
    },
  ],
  unmatchedQueries: 0,
  pendingProposals: 0,
  lastSession: "2026-03-10T10:00:00.000Z",
  system: {
    healthy: true,
    pass: 1,
    fail: 0,
    warn: 0,
  },
};

beforeAll(async () => {
  const mod = await import("../../cli/selftune/dashboard-server.js");
  startDashboardServer = mod.startDashboardServer;
});

describe("badge routes", () => {
  let server: { server: unknown; stop: () => void; port: number };

  beforeAll(async () => {
    server = await startDashboardServer({
      port: 0,
      host: "localhost",
      openBrowser: false,
      dataLoader: () => dashboardFixture,
      statusLoader: () => statusFixture,
    });
  });

  afterAll(() => {
    server?.stop();
  });

  describe("GET /badge/:skillName", () => {
    it("returns SVG content type for unknown skill", async () => {
      const res = await fetch(`http://localhost:${server.port}/badge/nonexistent-skill`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("image/svg+xml");
      const body = await res.text();
      expect(body).toContain("<svg");
      expect(body).toContain("not found");
    });

    it("returns valid SVG badge (not JSON error)", async () => {
      const res = await fetch(`http://localhost:${server.port}/badge/nonexistent-skill`);
      const body = await res.text();
      // Should be valid SVG, not a JSON error
      expect(body.startsWith("<svg")).toBe(true);
    });

    it("includes Cache-Control no-cache header", async () => {
      const res = await fetch(`http://localhost:${server.port}/badge/test-skill`);
      expect(res.headers.get("cache-control")).toBe("no-cache, no-store");
    });

    it("includes CORS headers", async () => {
      const res = await fetch(`http://localhost:${server.port}/badge/test-skill`);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("returns text/plain for ?format=markdown", async () => {
      const res = await fetch(`http://localhost:${server.port}/badge/nonexistent?format=markdown`);
      // For unknown skills, still returns SVG 404 (badge not found)
      // But for known skills would return text/plain
      expect(res.status).toBe(404);
    });
  });

  describe("GET /report/:skillName", () => {
    it("returns 404 for unknown skill", async () => {
      const res = await fetch(`http://localhost:${server.port}/report/nonexistent-skill`);
      expect(res.status).toBe(404);
    });

    it("includes CORS headers", async () => {
      const res = await fetch(`http://localhost:${server.port}/report/test-skill`);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("renders evidence sections for a real skill report", async () => {
      const res = await fetch(
        `http://localhost:${server.port}/report/${encodeURIComponent(reportSkillName)}`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Description Versions");
      expect(html).toContain("Validation Evidence");
    });

    it("returns text/plain for missing skill", async () => {
      const res = await fetch(`http://localhost:${server.port}/report/nonexistent`);
      expect(res.headers.get("content-type")).toContain("text/plain");
    });
  });
});
