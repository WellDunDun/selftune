import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DurableDashboardDecision,
  RemovalDecision,
  SkillConsolidationDecision,
  SkillSetConflictDecision,
  SourceMergeDecision,
} from "../../packages/runtime/dashboard-contract.js";

let startDashboardServer: typeof import("@selftune/local/dashboard-server").startDashboardServer;
let spaDirectory: string;
const consolidationToken = "PLACEHOLDER_CONSOLIDATION_TOKEN";
const decisionToken = "PLACEHOLDER_DECISION_TOKEN";

const common = {
  schema_version: 1,
  status: "pending",
  created_at: "2026-07-16T10:00:00.000Z",
  updated_at: "2026-07-16T10:00:00.000Z",
  expires_at: "2026-07-17T10:00:00.000Z",
  decided_at: null,
  receipt: null,
  failure: null,
  audit: [{ event: "prepared", at: "2026-07-16T10:00:00.000Z", reason: null }],
} as const;

const source: SourceMergeDecision = {
  ...common,
  approval_id: "12345678-1234-4234-8234-123456789abc",
  merge_id: "12345678-1234-4234-8234-123456789abc",
  requested_action: "apply_source_merge",
  skill_name: "research",
  source: "example/skills",
  harness_id: "codex",
  agent: "codex",
  model: null,
  installed_hash: "old",
  latest_hash: "new",
  upstream_diff: "diff",
  targets: [],
};
const removal: RemovalDecision = {
  ...common,
  approval_id: "22345678-1234-4234-8234-123456789abc",
  requested_action: "quarantine_skill",
  skill_name: "research",
  locations: [],
};
const consolidation: SkillConsolidationDecision = {
  ...common,
  approval_id: "42345678-1234-4234-8234-123456789abc",
  requested_action: "consolidate_skill_installations",
  skill_name: "research",
  canonical: {
    source_package_path: "/skills/research",
    source_skill_path: "/skills/research/SKILL.md",
    content_hash: "current",
    library_package_path: "/library/research/current",
  },
  targets: [],
};
const conflict: SkillSetConflictDecision = {
  ...common,
  approval_id: "32345678-1234-4234-8234-123456789abc",
  requested_action: "replace_skill_set_conflicts",
  skill_set_id: "dev",
  skill_set_name: "Development",
  skill_set_revision_hash: "revision",
  project_root: "/project",
  creates: 0,
  unchanged: 0,
  conflicts: 1,
  impacts: [],
};

beforeAll(async () => {
  spaDirectory = mkdtempSync(join(tmpdir(), "selftune-decisions-spa-"));
  mkdirSync(join(spaDirectory, "assets"), { recursive: true });
  writeFileSync(join(spaDirectory, "index.html"), '<!doctype html><div id="root"></div>');
  ({ startDashboardServer } = await import("@selftune/local/dashboard-server"));
});

afterAll(() => rmSync(spaDirectory, { force: true, recursive: true }));

describe("unified durable decision API", () => {
  test("prepares an authenticated consolidation review from exact installed paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-dashboard-consolidation-"));
    const globalPackage = join(root, "home", ".agents", "skills", "research");
    const projectPackage = join(root, "project", ".agents", "skills", "research");
    mkdirSync(globalPackage, { recursive: true });
    mkdirSync(projectPackage, { recursive: true });
    writeFileSync(
      join(globalPackage, "SKILL.md"),
      "---\nname: research\ndescription: Current research.\n---\n\n# Current\n",
    );
    writeFileSync(
      join(projectPackage, "SKILL.md"),
      "---\nname: research\ndescription: Old research.\n---\n\n# Old\n",
    );
    const server = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: spaDirectory,
      openBrowser: false,
      authToken: consolidationToken,
      skillSetConfigRoot: join(root, "config"),
      quarantineRoot: join(root, "quarantine"),
      portfolioSearchDirs: [
        join(root, "home", ".agents", "skills"),
        join(root, "project", ".agents", "skills"),
      ],
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${origin}/api/v2/decisions/consolidations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${consolidationToken}`,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          skill_name: "research",
          canonical_skill_path: join(globalPackage, "SKILL.md"),
          target_skill_paths: [join(projectPackage, "SKILL.md")],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        requested_action: "consolidate_skill_installations",
        status: "pending",
        canonical: { source_package_path: globalPackage },
        targets: [{ action: "replace_with_link", original_package_path: projectPackage }],
      });
    } finally {
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lists all typed consumers and resumes an authenticated same-origin decision", async () => {
    const decisions: DurableDashboardDecision[] = [source, removal, consolidation, conflict];
    const decided: string[] = [];
    const server = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: spaDirectory,
      openBrowser: false,
      authToken: decisionToken,
      skillSetConfigRoot: join(spaDirectory, "config"),
      durableDecisionLoader: () => decisions,
      durableDecisionDecider: (approvalId, action) => {
        const decision = decisions.find((candidate) => candidate.approval_id === approvalId);
        if (!decision) throw new Error("Decision was not found.");
        decided.push(approvalId);
        return {
          ...decision,
          status: action === "approve" ? "approved" : "declined",
          decided_at: "2026-07-16T10:05:00.000Z",
        };
      },
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const Authorization = `Bearer ${decisionToken}`;
      const listed = await fetch(`${origin}/api/v2/decisions`, { headers: { Authorization } });
      expect(listed.status).toBe(200);
      expect(
        (await listed.json()).decisions.map(
          (item: { requested_action: string }) => item.requested_action,
        ),
      ).toEqual([
        "apply_source_merge",
        "quarantine_skill",
        "consolidate_skill_installations",
        "replace_skill_set_conflicts",
      ]);

      const unauthorizedPackage = await fetch(
        `${origin}/api/v2/decisions/${source.approval_id}/run-package`,
      );
      expect(unauthorizedPackage.status).toBe(401);
      const runPackage = await fetch(
        `${origin}/api/v2/decisions/${source.approval_id}/run-package`,
        { headers: { Authorization } },
      );
      expect(runPackage.status).toBe(200);
      expect((await runPackage.json()).producer).toBe("local_source_merge");
      const summary = await fetch(`${origin}/api/v2/decisions/${source.approval_id}/summary`, {
        headers: { Authorization },
      });
      expect(summary.status).toBe(200);
      expect((await summary.json()).run_id).toBe(source.approval_id);

      const denied = await fetch(`${origin}/api/v2/decisions/${removal.approval_id}/approve`, {
        method: "POST",
        headers: { Authorization },
      });
      expect(denied.status).toBe(403);
      for (const decision of decisions) {
        const approved = await fetch(`${origin}/api/v2/decisions/${decision.approval_id}/approve`, {
          method: "POST",
          headers: { Authorization, Origin: origin },
        });
        expect(approved.status).toBe(200);
        expect((await approved.json()).status).toBe("approved");
      }
      expect(decided).toEqual(decisions.map((decision) => decision.approval_id));
    } finally {
      server.stop();
    }
  });
});
