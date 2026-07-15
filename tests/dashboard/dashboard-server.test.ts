import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DashboardActionEvent,
  DesktopSettingsResponse,
  LibrarySnapshot,
  InsightsResponse,
  OverviewResponse,
  PortfolioAuditResult,
  SkillReportResponse,
} from "../../packages/runtime/dashboard-contract.js";

const insightsFixture: InsightsResponse = {
  snapshot: {
    snapshotId: "snapshot",
    evidenceVersion: 1,
    generatedAt: "2026-07-15T08:00:00.000Z",
    candidates: [
      {
        candidateId: "candidate",
        kind: "coverage_gap",
        title: "Prepare release notes",
        summary: "Repeated successful uncovered work.",
        skillNames: [],
        evidence: {
          evidenceVersion: 1,
          supportSessions: 3,
          projectDiversity: 3,
          temporalSpanDays: 14,
          outcomeQuality: 1,
          coUsageLift: null,
          sequenceConsistency: null,
          completionRate: null,
          confidence: 0.8,
          uncertainty: 0.5,
          exploratory: false,
        },
        supportingSessionIds: ["one", "two"],
        heldOutSessionIds: ["three"],
        redactedExcerpts: ["Prepare release notes"],
        generatedAt: "2026-07-15T08:00:00.000Z",
        status: "pending",
        decision: null,
        decisionHistory: [],
      },
    ],
  },
  portfolio_reviews: [],
  counts: {
    pending: 1,
    accepted: 0,
    drafted: 0,
    snoozed: 0,
    completed: 0,
    stale_reviews: 0,
    routing_reviews: 0,
  },
};

const libraryFixture: LibrarySnapshot = {
  generatedAt: "2026-07-15T08:00:00.000Z",
  counts: { total: 1, active: 1, library: 0, draft: 0, archived: 0 },
  skills: [
    {
      skillId: "test-skill",
      name: "test-skill",
      lifecycle: "active",
      revisions: [],
      locations: [
        {
          sourceKind: "installed",
          packagePath: "/tmp/test-skill",
          skillPath: "/tmp/test-skill/SKILL.md",
          harness: "codex",
          scope: "global",
          projectRoot: null,
          active: true,
          modifiedAt: "2026-07-15T08:00:00.000Z",
        },
      ],
    },
  ],
};

let startDashboardServer: typeof import("@selftune/local/dashboard-server").startDashboardServer;
let loadWatchedSkills: typeof import("../../packages/runtime/watchlist.js").loadWatchedSkills;
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
  const mod = await import("@selftune/local/dashboard-server");
  const watchlist = await import("../../packages/runtime/watchlist.js");
  startDashboardServer = mod.startDashboardServer;
  loadWatchedSkills = watchlist.loadWatchedSkills;
  testSpaDir = mkdtempSync(join(tmpdir(), "selftune-dashboard-test-"));
  mkdirSync(join(testSpaDir, "assets"), { recursive: true });
  writeFileSync(
    join(testSpaDir, "index.html"),
    `<!DOCTYPE html><html lang="en"><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`,
  );
  writeFileSync(join(testSpaDir, "assets", "app.js"), "console.log('selftune test spa');\n");
  writeFileSync(join(testSpaDir, "assets", "harness.jpg"), "jpeg-fixture");
});

describe("dashboard settings endpoints", () => {
  it("returns harness state and enforces same-origin schedule mutations", async () => {
    const settingsFixture: DesktopSettingsResponse = {
      harnesses: [
        {
          id: "codex",
          name: "Codex",
          status: "connected",
          detected: true,
          connected: true,
          import_available: true,
          hooks_supported: true,
          hooks_installed: true,
          detail: "SelfTune telemetry is connected",
          config_path: "/tmp/.codex/hooks.json",
        },
      ],
      onboarding: {
        version: 1,
        completed: true,
        import_sources: {
          claude_code: false,
          codex: true,
          opencode: false,
          openclaw: false,
          pi: false,
        },
        hook_harnesses: {
          claude_code: false,
          codex: true,
          opencode: false,
          pi: false,
        },
        features: {
          observability: true,
          health_recommendations: true,
          autonomous_improvement: false,
        },
      },
      remote_library: {
        configured: false,
        url: null,
        preferences: {
          releasedSkills: true,
          drafts: false,
          skillSets: true,
          metadata: true,
          decisionHistory: true,
        },
      },
      schedule: {
        supported: true,
        format: "launchd",
        settings_path: "/tmp/.selftune/schedule/desktop-settings.json",
        jobs: [
          {
            id: "selftune-sync",
            label: "Sync telemetry",
            description: "Sync source-truth telemetry every 30 minutes",
            command: "selftune sync",
            default_schedule: "*/30 * * * *",
            schedule: "*/30 * * * *",
            enabled: false,
            active: false,
          },
        ],
      },
    };
    let updateCount = 0;
    let onboardingCount = 0;
    let remoteUpdateCount = 0;
    const remoteActions: string[] = [];
    const shareActions: string[] = [];
    const server = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: testSpaDir,
      openBrowser: false,
      authToken: "desktop-settings-token",
      overviewLoader: () => overviewFixture,
      skillReportLoader: () => skillReportFixture,
      settingsLoader: () => settingsFixture,
      settingsUpdater: () => {
        updateCount += 1;
        return settingsFixture;
      },
      remoteSettingsUpdater: () => {
        remoteUpdateCount += 1;
        return settingsFixture;
      },
      remoteLibraryAction: (action) => {
        remoteActions.push(action);
        return action === "status"
          ? {
              url: "https://library.example.com",
              head: null,
              diagnostics: {
                objectCount: 0,
                snapshotCount: 0,
                totalBytes: 0,
                missingObjects: [],
                orphanedObjects: [],
              },
            }
          : { action };
      },
      remoteLibraryShareAction: (action) => {
        shareActions.push(action);
        return action === "list" ? { inbox: [], outbox: [] } : { id: "share-1", action };
      },
      onboardingUpdater: () => {
        onboardingCount += 1;
        return { ...settingsFixture, install_results: [] };
      },
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const authorization = "Bearer desktop-settings-token";
      const response = await fetch(`${baseUrl}/api/v2/settings`, {
        headers: { Authorization: authorization },
      });
      expect(response.status).toBe(200);
      const settings = (await response.json()) as DesktopSettingsResponse;
      expect(settings.harnesses[0]?.id).toBe("codex");

      const rejected = await fetch(`${baseUrl}/api/v2/settings/schedule`, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ jobs: [] }),
      });
      expect(rejected.status).toBe(403);
      expect(updateCount).toBe(0);

      const accepted = await fetch(`${baseUrl}/api/v2/settings/schedule`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Origin: baseUrl,
        },
        body: JSON.stringify({ jobs: [] }),
      });
      expect(accepted.status).toBe(200);
      expect(updateCount).toBe(1);

      const remoteRejected = await fetch(`${baseUrl}/api/v2/settings/remote-library`, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(remoteRejected.status).toBe(403);

      const remoteAccepted = await fetch(`${baseUrl}/api/v2/settings/remote-library`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Origin: baseUrl,
        },
        body: JSON.stringify({
          url: "https://library.example.com",
          api_key: "device-key",
          preferences: settingsFixture.remote_library.preferences,
        }),
      });
      expect(remoteAccepted.status).toBe(200);
      expect(remoteUpdateCount).toBe(1);

      const remoteStatus = await fetch(`${baseUrl}/api/v2/settings/remote-library/status`, {
        headers: { Authorization: authorization },
      });
      expect(remoteStatus.status).toBe(200);
      const remoteSyncRejected = await fetch(`${baseUrl}/api/v2/settings/remote-library/sync`, {
        method: "POST",
        headers: { Authorization: authorization },
      });
      expect(remoteSyncRejected.status).toBe(403);
      const remoteSyncAccepted = await fetch(`${baseUrl}/api/v2/settings/remote-library/sync`, {
        method: "POST",
        headers: { Authorization: authorization, Origin: baseUrl },
      });
      expect(remoteSyncAccepted.status).toBe(200);
      expect(remoteActions).toEqual(["status", "sync"]);

      const shares = await fetch(`${baseUrl}/api/v2/settings/remote-library/shares`, {
        headers: { Authorization: authorization },
      });
      expect(shares.status).toBe(200);
      expect(await shares.json()).toEqual({ inbox: [], outbox: [] });
      const shareRejected = await fetch(`${baseUrl}/api/v2/settings/remote-library/shares`, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(shareRejected.status).toBe(403);
      const shareCreated = await fetch(`${baseUrl}/api/v2/settings/remote-library/shares`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Origin: baseUrl,
        },
        body: JSON.stringify({
          snapshot_id: "snapshot-1",
          artifact_id: "skill/research/revision-1",
          recipient_email: "recipient@example.com",
        }),
      });
      expect(shareCreated.status).toBe(200);
      const shareAccepted = await fetch(
        `${baseUrl}/api/v2/settings/remote-library/shares/share-1/accept`,
        {
          method: "POST",
          headers: { Authorization: authorization, Origin: baseUrl },
        },
      );
      expect(shareAccepted.status).toBe(200);
      expect(shareActions).toEqual(["list", "create", "accept"]);
      const malformedShare = await fetch(
        `${baseUrl}/api/v2/settings/remote-library/shares/%E0%A4%A/accept`,
        {
          method: "POST",
          headers: { Authorization: authorization, Origin: baseUrl },
        },
      );
      expect(malformedShare.status).toBe(400);
      expect(await malformedShare.json()).toMatchObject({
        error: { code: "INVALID_FLAG" },
      });
      expect(shareActions).toEqual(["list", "create", "accept"]);

      const onboardingRejected = await fetch(`${baseUrl}/api/v2/settings/onboarding`, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(onboardingRejected.status).toBe(403);

      const onboardingAccepted = await fetch(`${baseUrl}/api/v2/settings/onboarding`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Origin: baseUrl,
        },
        body: JSON.stringify({
          import_sources: ["codex"],
          hook_harnesses: ["codex"],
          features: {
            observability: true,
            health_recommendations: true,
            autonomous_improvement: false,
          },
        }),
      });
      expect(onboardingAccepted.status).toBe(200);
      expect(onboardingCount).toBe(1);
    } finally {
      server.stop();
    }
  });
});

describe("dashboard Insights review", () => {
  it("serves the unified queue and requires same-origin review actions", async () => {
    let reviewed = 0;
    let drafted = 0;
    let evaluated = 0;
    let released = 0;
    const server = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: testSpaDir,
      openBrowser: false,
      authToken: "insights-token",
      overviewLoader: () => overviewFixture,
      skillReportLoader: () => skillReportFixture,
      insightsLoader: () => insightsFixture,
      insightReviewer: () => {
        reviewed += 1;
        return insightsFixture.snapshot.candidates[0];
      },
      insightDrafter: () => {
        drafted += 1;
        return { draft: { skill_dir: "/tmp/draft" } };
      },
      insightEvaluator: () => {
        evaluated += 1;
        return { recommended: true, blockers: [] };
      },
      insightReleaser: () => {
        released += 1;
        return { package_path: "/tmp/released" };
      },
    });
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const Authorization = "Bearer insights-token";
      const response = await fetch(`${baseUrl}/api/v2/insights`, {
        headers: { Authorization },
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as InsightsResponse).counts.pending).toBe(1);

      const rejected = await fetch(`${baseUrl}/api/v2/insights/review`, {
        method: "POST",
        headers: { Authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_id: "candidate", action: "accept", reason: "reviewed" }),
      });
      expect(rejected.status).toBe(403);
      expect(reviewed).toBe(0);

      const accepted = await fetch(`${baseUrl}/api/v2/insights/review`, {
        method: "POST",
        headers: { Authorization, Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_id: "candidate", action: "accept", reason: "reviewed" }),
      });
      expect(accepted.status).toBe(200);
      expect(reviewed).toBe(1);

      const draftResponse = await fetch(`${baseUrl}/api/v2/insights/draft`, {
        method: "POST",
        headers: { Authorization, Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_id: "candidate" }),
      });
      expect(draftResponse.status).toBe(200);
      expect(drafted).toBe(1);

      const evaluationResponse = await fetch(`${baseUrl}/api/v2/insights/evaluate`, {
        method: "POST",
        headers: { Authorization, Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_id: "candidate" }),
      });
      expect(evaluationResponse.status).toBe(200);
      expect(evaluated).toBe(1);

      const releaseResponse = await fetch(`${baseUrl}/api/v2/insights/release`, {
        method: "POST",
        headers: { Authorization, Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_id: "candidate" }),
      });
      expect(releaseResponse.status).toBe(200);
      expect(released).toBe(1);
    } finally {
      server.stop();
    }
  });
});

describe("dashboard Skill Set lifecycle", () => {
  it("creates, previews, applies, and rolls back a project Skill Set", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-dashboard-sets-"));
    const sourcePackage = join(root, "installed", "research");
    const projectRoot = join(root, "project");
    mkdirSync(sourcePackage, { recursive: true });
    mkdirSync(projectRoot);
    writeFileSync(
      join(sourcePackage, "SKILL.md"),
      "---\nname: research\ndescription: Research workflow.\n---\n\n# Research\n",
    );
    const server = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: testSpaDir,
      openBrowser: false,
      authToken: "desktop-skill-sets-token",
      skillSetConfigRoot: join(root, "config"),
      overviewLoader: () => overviewFixture,
      skillReportLoader: () => skillReportFixture,
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const headers = {
        Authorization: "Bearer desktop-skill-sets-token",
        "Content-Type": "application/json",
        Origin: baseUrl,
      };
      const createdResponse = await fetch(`${baseUrl}/api/v2/skill-sets`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Research project",
          harnesses: ["codex"],
          skills: [{ name: "research", package_path: sourcePackage }],
        }),
      });
      expect(createdResponse.status).toBe(200);
      const created = await createdResponse.json();
      expect(created.set_id).toBe("research-project");

      const updatedResponse = await fetch(`${baseUrl}/api/v2/skill-sets/update`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          set_id: created.set_id,
          parent_revision_hash: created.revision_hash,
          name: created.name,
          harnesses: ["codex", "opencode"],
          skills: [{ name: "research", package_path: sourcePackage }],
        }),
      });
      expect(updatedResponse.status).toBe(200);
      const updated = await updatedResponse.json();
      expect(updated.revision).toBe(2);

      const staleUpdate = await fetch(`${baseUrl}/api/v2/skill-sets/update`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          set_id: created.set_id,
          parent_revision_hash: created.revision_hash,
          name: created.name,
          harnesses: ["codex"],
          skills: [{ name: "research", package_path: sourcePackage }],
        }),
      });
      expect(staleUpdate.status).toBe(409);

      const listResponse = await fetch(`${baseUrl}/api/v2/skill-sets`, {
        headers: { Authorization: "Bearer desktop-skill-sets-token" },
      });
      expect(listResponse.status).toBe(200);
      const library = await listResponse.json();
      expect(library.sets).toHaveLength(1);

      const planResponse = await fetch(`${baseUrl}/api/v2/skill-sets/plan`, {
        method: "POST",
        headers,
        body: JSON.stringify({ set_id: created.set_id, project_root: projectRoot }),
      });
      expect(planResponse.status).toBe(200);
      const plan = await planResponse.json();
      expect(plan.creates).toBe(2);
      expect(existsSync(join(projectRoot, ".agents"))).toBe(false);

      const applyResponse = await fetch(`${baseUrl}/api/v2/skill-sets/apply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ set_id: created.set_id, project_root: projectRoot }),
      });
      expect(applyResponse.status).toBe(200);
      const receipt = await applyResponse.json();
      expect(receipt.status).toBe("applied");
      expect(existsSync(join(projectRoot, ".agents", "skills", "research", "SKILL.md"))).toBe(true);

      const deriveResponse = await fetch(`${baseUrl}/api/v2/skill-sets/derive`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Captured project",
          project_root: projectRoot,
          harnesses: ["codex"],
        }),
      });
      expect(deriveResponse.status).toBe(200);
      expect((await deriveResponse.json()).skills).toHaveLength(1);

      const exportResponse = await fetch(`${baseUrl}/api/v2/skill-sets/export`, {
        method: "POST",
        headers,
        body: JSON.stringify({ set_id: created.set_id, project_root: projectRoot }),
      });
      expect(exportResponse.status).toBe(200);
      expect(existsSync(join(projectRoot, ".selftune", "skill-set.json"))).toBe(true);

      const rollbackResponse = await fetch(`${baseUrl}/api/v2/skill-sets/rollback`, {
        method: "POST",
        headers,
        body: JSON.stringify({ receipt_id: receipt.receipt_id }),
      });
      expect(rollbackResponse.status).toBe(200);
      const rolledBack = await rollbackResponse.json();
      expect(rolledBack.status).toBe("rolled_back");
      expect(existsSync(join(projectRoot, ".agents", "skills", "research"))).toBe(false);
    } finally {
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
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
        libraryLoader: () => libraryFixture,
        sourceUpdatePreviewer: (skillName) => ({
          skill_name: skillName,
          source: "example/skills",
          source_url: "https://github.com/example/skills",
          installed_hash: "old-tree",
          latest_hash: "new-tree",
          status: "available",
          conflicts: 0,
          can_apply: true,
          locations: [
            {
              package_path: "/tmp/test-skill",
              skill_path: "/tmp/test-skill/SKILL.md",
              scope: "global",
              project_root: null,
              canonical_target: "/tmp/test-skill",
              local_state: "clean",
              reason: "Matches the recorded upstream revision.",
            },
          ],
        }),
        sourceUpdateApplier: (skillName, strategy) => ({
          schema_version: 1,
          receipt_id: "update-receipt",
          skill_name: skillName,
          source: "example/skills",
          previous_hash: "old-tree",
          installed_hash: "new-tree",
          status: "applied",
          strategy,
          operations: [],
          applied_at: "2026-07-15T09:00:00.000Z",
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

    it("serves bundled JPEG harness logos with the correct MIME type", async () => {
      const server = await getServer();
      const response = await fetch(`http://127.0.0.1:${server.port}/assets/harness.jpg`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
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

  describe("GET /api/v2/shell", () => {
    it("returns compact navigation and Library summary data", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v2/shell`);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toHaveProperty("skills");
      expect(data).toHaveProperty("latest_evolutions");
      expect(data).toHaveProperty("pending_proposals");
      expect(data).not.toHaveProperty("overview");
      expect(data.skills[0]?.skill_name).toBe("test-skill");
    });
  });

  describe("GET /api/v2/library", () => {
    it("returns the canonical grouped Library contract", async () => {
      const server = await getServer();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v2/library`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.counts.total).toBe(1);
      expect(data.skills[0]?.skillId).toBe("test-skill");
      expect(data.skills[0]?.locations[0]?.harness).toBe("codex");
    });
  });

  describe("POST /api/v2/library/source-update/*", () => {
    it("requires the authenticated dashboard origin", async () => {
      const server = await getServer();
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/v2/library/source-update/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skill_name: "test-skill" }),
        },
      );
      expect(res.status).toBe(403);
    });

    it("previews and applies an explicit source update", async () => {
      const server = await getServer();
      const origin = `http://127.0.0.1:${server.port}`;
      const headers = { "Content-Type": "application/json", Origin: origin };
      const previewResponse = await fetch(`${origin}/api/v2/library/source-update/preview`, {
        method: "POST",
        headers,
        body: JSON.stringify({ skill_name: "test-skill" }),
      });
      expect(previewResponse.status).toBe(200);
      expect((await previewResponse.json()).latest_hash).toBe("new-tree");

      const applyResponse = await fetch(`${origin}/api/v2/library/source-update/apply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ skill_name: "test-skill", strategy: "abort" }),
      });
      expect(applyResponse.status).toBe(200);
      expect((await applyResponse.json()).receipt_id).toBe("update-receipt");
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

    it("marks watch wrapper responses failed when the measured watch result regresses", async () => {
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
        actionRunner: async () => ({
          success: true,
          output: JSON.stringify({
            skill: "test-skill",
            published: true,
            watch_started: false,
            package_evaluation: {
              status: "passed",
              evaluation_passed: true,
              replay: { validation_mode: "host_replay" },
              baseline: {
                baseline_pass_rate: 0.5,
                with_skill_pass_rate: 0.9,
                lift: 0.4,
              },
            },
            watch_result: {
              snapshot: {
                timestamp: "2026-04-14T12:30:00.000Z",
                skill_name: "test-skill",
                window_sessions: 20,
                skill_checks: 6,
                pass_rate: 0.62,
                false_negative_rate: 0.38,
                by_invocation_type: {
                  explicit: { passed: 2, total: 2 },
                  implicit: { passed: 1, total: 3 },
                  contextual: { passed: 0, total: 1 },
                  negative: { passed: 0, total: 0 },
                },
                regression_detected: true,
                baseline_pass_rate: 0.8,
              },
              alert:
                'regression detected for "test-skill": pass_rate=0.62 below baseline=0.80 minus threshold=0.10',
              rolledBack: false,
              recommendation:
                "Consider running: selftune rollback --skill test-skill --skill-path /tmp/test-skill/SKILL.md",
              recommended_command:
                "selftune rollback --skill test-skill --skill-path /tmp/test-skill/SKILL.md",
              gradeAlert: null,
              gradeRegression: null,
            },
          }),
          error: null,
          exitCode: 0,
        }),
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/actions/watch`, {
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
        const data = await res.json();
        expect(data.success).toBe(false);
        expect(data.error).toContain("regression detected");
      } finally {
        server.stop();
      }
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

    it("create-check routes draft validation through selftune create check", async () => {
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
            success: false,
            output: "ok",
            error: "Exit code 1",
            exitCode: 1,
          };
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/actions/create-check`, {
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
        expect(capturedCommand).toBe("create");
        expect(capturedArgs).toEqual(["check", "--skill-path", "/tmp/test-skill/SKILL.md"]);
      } finally {
        server.stop();
      }
    });

    it("report-package routes draft benchmark reporting through selftune create report", async () => {
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
        const res = await fetch(`http://127.0.0.1:${server.port}/api/actions/report-package`, {
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
        expect(capturedCommand).toBe("create");
        expect(capturedArgs).toEqual(["report", "--skill-path", "/tmp/test-skill/SKILL.md"]);
      } finally {
        server.stop();
      }
    });

    it("search-run routes bounded package search through selftune search-run", async () => {
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
        const res = await fetch(`http://127.0.0.1:${server.port}/api/actions/search-run`, {
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
        expect(capturedCommand).toBe("search-run");
        expect(capturedArgs).toEqual([
          "--skill",
          "test-skill",
          "--skill-path",
          "/tmp/test-skill/SKILL.md",
        ]);
      } finally {
        server.stop();
      }
    });

    it("evolve routes live deploys through selftune improve", async () => {
      lastActionInvocation = null;
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
      expect(lastActionInvocation).toEqual({
        command: "improve",
        args: ["--skill", "test-skill", "--skill-path", "/tmp/test-skill", "--sync-first"],
      });
    });

    it("watch routes draft-package publish/watch through selftune publish", async () => {
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

      const draftDir = mkdtempSync(join(tmpdir(), "selftune-dashboard-draft-"));
      writeFileSync(join(draftDir, "SKILL.md"), "# Draft\n", "utf-8");
      writeFileSync(
        join(draftDir, "selftune.create.json"),
        JSON.stringify({ version: 1 }),
        "utf-8",
      );

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/actions/watch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: `http://127.0.0.1:${server.port}`,
          },
          body: JSON.stringify({
            skill: "test-skill",
            skillPath: join(draftDir, "SKILL.md"),
          }),
        });

        expect(res.status).toBe(200);
        expect(capturedCommand).toBe("publish");
        expect(capturedArgs).toEqual(["--skill-path", join(draftDir, "SKILL.md")]);
      } finally {
        rmSync(draftDir, { recursive: true, force: true });
        server.stop();
      }
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

    it("runs a fixed global sync action from a same-origin request", async () => {
      lastActionInvocation = null;
      const server = await getServer();
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${baseUrl}/api/actions/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: baseUrl,
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, error: null });
      expect(lastActionInvocation).toEqual({ command: "sync", args: ["--no-repair"] });
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

  it("releases startup resources when binding fails", async () => {
    const first = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: testSpaDir,
      openBrowser: false,
      overviewLoader: () => overviewFixture,
      skillReportLoader: () => null,
      statusLoader,
    });
    try {
      await expect(
        startDashboardServer({
          port: first.port,
          host: "127.0.0.1",
          spaDir: testSpaDir,
          openBrowser: false,
          overviewLoader: () => overviewFixture,
          skillReportLoader: () => null,
          statusLoader,
        }),
      ).rejects.toThrow();
      const health = await fetch(`http://127.0.0.1:${first.port}/api/health`);
      expect(health.status).toBe(200);
    } finally {
      first.stop();
    }
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

describe("desktop-authenticated server", () => {
  it("requires its bearer token and exposes installed portfolio inventory", async () => {
    const portfolioFixture: PortfolioAuditResult = {
      generated_at: "2026-07-14T00:00:00.000Z",
      thresholds: {
        min_sessions: 20,
        inactive_days: 30,
        min_checks: 10,
        routing_miss_rate: 0.85,
      },
      session_count: 0,
      installed_count: 1,
      counts: {
        protected: 0,
        unobserved: 1,
        under_observed: 0,
        routing_problem: 0,
        active: 0,
        inactive_candidate: 0,
        consolidation_candidate: 0,
      },
      skills: [
        {
          skill_name: "installed-only",
          skill_path: "/tmp/installed-only/SKILL.md",
          package_path: "/tmp/installed-only",
          scope: "global",
          classification: "unobserved",
          recommendation: "measure",
          reason: "No trusted observations yet.",
          evidence: {
            trusted_checks: 0,
            triggered_count: 0,
            miss_rate: null,
            last_seen_at: null,
            last_invoked_at: null,
            sessions_since_invocation: 0,
            inactive_days: 0,
            package_modified_at: "2026-07-14T00:00:00.000Z",
          },
        },
      ],
    };
    const server = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: testSpaDir,
      openBrowser: false,
      authToken: "desktop-test-token-that-is-long-enough",
      overviewLoader: () => overviewFixture,
      skillReportLoader: () => skillReportFixture,
      portfolioLoader: () => portfolioFixture,
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${baseUrl}/api/health`)).status).toBe(401);
      expect(
        (
          await fetch(`${baseUrl}/api/health`, {
            headers: { Authorization: "Bearer wrong-token" },
          })
        ).status,
      ).toBe(401);

      const response = await fetch(`${baseUrl}/api/v2/portfolio`, {
        headers: { Authorization: "Bearer desktop-test-token-that-is-long-enough" },
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { audit: PortfolioAuditResult };
      expect(payload.audit.installed_count).toBe(1);
      expect(payload.audit.skills[0]?.skill_name).toBe("installed-only");

      const crossOriginMutation = await fetch(`${baseUrl}/api/v2/portfolio/quarantine`, {
        method: "POST",
        headers: {
          Authorization: "Bearer desktop-test-token-that-is-long-enough",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ skill_name: "installed-only", confirm: true }),
      });
      expect(crossOriginMutation.status).toBe(403);
    } finally {
      server.stop();
    }
  });
});

afterAll(() => {
  rmSync(testSpaDir, { recursive: true, force: true });
});
