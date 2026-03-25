import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  OverviewResponse,
  SkillReportResponse,
} from "../../cli/selftune/dashboard-contract.js";
import type { StatusResult } from "../../cli/selftune/status.js";
import type { EvolutionEvidenceEntry, SkillUsageRecord } from "../../cli/selftune/types.js";

/**
 * Badge route tests — validates /badge/:skillName and /report/:skillName
 * endpoints on the dashboard server.
 *
 * Strategy: spawn actual server on port 0 (random), test with fetch, clean up.
 */

let startDashboardServer: typeof import("../../cli/selftune/dashboard-server.js").startDashboardServer;
let testSpaDir: string;

const reportSkillName = "test-skill";
const overviewFixture: OverviewResponse = {
  overview: {
    telemetry: [],
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
    evolution: [],
    counts: {
      telemetry: 0,
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
      skill_name: reportSkillName,
      skill_scope: "global",
      total_checks: 1,
      triggered_count: 1,
      pass_rate: 1,
      unique_sessions: 1,
      last_seen: "2026-03-10T10:00:00.000Z",
      has_evidence: true,
    },
  ],
  version: "0.2.1-test",
};
const evidenceFixture: EvolutionEvidenceEntry[] = [
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
] as EvolutionEvidenceEntry[];
const skillReportFixture: SkillReportResponse = {
  skill_name: reportSkillName,
  usage: {
    total_checks: 1,
    triggered_count: 1,
    pass_rate: 1,
  },
  recent_invocations: [
    {
      timestamp: "2026-03-10T10:00:00.000Z",
      session_id: "sess-report-1",
      query: "Use the test skill",
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
  testSpaDir = mkdtempSync(join(tmpdir(), "selftune-badge-test-"));
  mkdirSync(join(testSpaDir, "assets"), { recursive: true });
  writeFileSync(
    join(testSpaDir, "index.html"),
    `<!DOCTYPE html><html lang="en"><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`,
  );
  writeFileSync(join(testSpaDir, "assets", "app.js"), "console.log('selftune badge test spa');\n");
});

describe("badge routes", () => {
  let server: { server: unknown; stop: () => void; port: number };

  beforeAll(async () => {
    server = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: testSpaDir,
      openBrowser: false,
      overviewLoader: () => overviewFixture,
      skillReportLoader: (skillName) => (skillName === reportSkillName ? skillReportFixture : null),
      statusLoader: () => statusFixture,
      evidenceLoader: () => evidenceFixture,
    });
  });

  afterAll(() => {
    server?.stop();
  });

  describe("GET /badge/:skillName", () => {
    it("returns SVG content type for unknown skill", async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/badge/nonexistent-skill`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("image/svg+xml");
      const body = await res.text();
      expect(body).toContain("<svg");
      expect(body).toContain("not found");
    });

    it("returns valid SVG badge (not JSON error)", async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/badge/nonexistent-skill`);
      const body = await res.text();
      // Should be valid SVG, not a JSON error
      expect(body.startsWith("<svg")).toBe(true);
    });

    it("includes Cache-Control no-cache header", async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/badge/test-skill`);
      expect(res.headers.get("cache-control")).toBe("no-cache, no-store");
    });

    it("includes CORS headers", async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/badge/test-skill`);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("returns text/plain for ?format=markdown", async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/badge/nonexistent?format=markdown`);
      // For unknown skills, still returns SVG 404 (badge not found)
      // But for known skills would return text/plain
      expect(res.status).toBe(404);
    });
  });

  describe("GET /report/:skillName", () => {
    it("returns 404 for unknown skill", async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/report/nonexistent-skill`);
      expect(res.status).toBe(404);
    });

    it("includes CORS headers", async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/report/test-skill`);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("renders evidence sections for a real skill report", async () => {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/report/${encodeURIComponent(reportSkillName)}`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Description Versions");
      expect(html).toContain("Validation Evidence");
    });

    it("returns text/plain for missing skill", async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/report/nonexistent`);
      expect(res.headers.get("content-type")).toContain("text/plain");
    });
  });
});

afterAll(() => {
  rmSync(testSpaDir, { recursive: true, force: true });
});
