import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectSkillSetInput } from "@selftune/dashboard-core/models";

import {
  localDashboardModules,
  localProjectSkillSetInput,
  localProjectSkillSetTargetInput,
  localProjectSkillSetUpdateInput,
  mapLocalSkillSetPlan,
  mapLocalSkillSetReceipt,
  previewsCloudSharingGate,
  selfHostDashboardModules,
} from "./dashboard-host";
import { projectCaptureCandidatesFromLibrary } from "./project-capture-candidates";
import {
  connectionDisplayName,
  connectionNames,
  localMergeConnections,
  mapLocalLibraryInventory,
  resolveLocalMergeRequest,
} from "./local-library-model";
import {
  localSkillSetSuggestionReviewInput,
  mapLocalSkillSetIntelligence,
} from "./project-skill-intelligence";
import { applyProjectSkillSet, DashboardApiError } from "./api";
import type {
  AnalyticsResponse,
  HarnessConnection,
  LibrarySnapshot,
  PortfolioAuditEntry,
  PortfolioResponse,
  SkillIntelligenceReport,
} from "./types";

describe("cloud sharing conversion preview", () => {
  it("forces the gate only for the explicit development preview URL", () => {
    expect(previewsCloudSharingGate("?preview=cloud-sharing-gate", true)).toBe(true);
    expect(previewsCloudSharingGate("?preview=cloud-sharing-gate", false)).toBe(false);
    expect(previewsCloudSharingGate("?preview=other", true)).toBe(false);
  });
});

const mergeHarnesses: HarnessConnection[] = [
  {
    id: "codex",
    name: "Codex",
    description: "Codex CLI",
    icon: {
      src: "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E",
      fit: "contain",
      inset: "sm",
    },
    documentation_url: null,
    source_merge: { model_override: true },
    status: "connected",
    detected: true,
    connected: true,
    import_available: true,
    hooks_supported: true,
    hooks_installed: true,
    detail: "Ready",
  },
  {
    id: "cline",
    name: "Cline",
    description: "Cline task hooks",
    icon: {
      src: "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E",
      fit: "contain",
      inset: "sm",
    },
    documentation_url: null,
    source_merge: null,
    status: "connected",
    detected: true,
    connected: true,
    import_available: false,
    hooks_supported: true,
    hooks_installed: true,
    detail: "Ready",
  },
];

describe("project capture candidates", () => {
  it("groups active project skills by workspace without another fetch", () => {
    const location = {
      sourceKind: "installed" as const,
      packagePath: "/projects/mobile-app/.agents/skills/serve-sim",
      skillPath: "/projects/mobile-app/.agents/skills/serve-sim/SKILL.md",
      harness: "codex" as const,
      scope: "project" as const,
      projectRoot: "/projects/mobile-app",
      active: true,
      modifiedAt: "2026-07-15T09:00:00.000Z",
      lastUsedAt: "2026-07-16T09:00:00.000Z",
      origin: null,
      updateStatus: "untracked" as const,
    };
    const snapshot: LibrarySnapshot = {
      generatedAt: "2026-07-16T10:00:00.000Z",
      counts: { total: 2, active: 2, library: 0, draft: 0, archived: 0 },
      skills: ["serve-sim", "flutter"].map((name) => ({
        skillId: name,
        name,
        lifecycle: "active" as const,
        revisions: [],
        locations: [
          location,
          {
            ...location,
            packagePath: `/projects/mobile-app/.pi/agent/skills/${name}`,
            skillPath: `/projects/mobile-app/.pi/agent/skills/${name}/SKILL.md`,
            harness: "pi" as const,
          },
          {
            ...location,
            projectRoot: "/projects/mobile-app/.claude/worktrees/agent-123",
            packagePath: `/projects/mobile-app/.claude/worktrees/agent-123/.agents/skills/${name}`,
            skillPath: `/projects/mobile-app/.claude/worktrees/agent-123/.agents/skills/${name}/SKILL.md`,
          },
        ],
        lastUsedAt: location.lastUsedAt,
        lastModifiedAt: location.modifiedAt,
        origins: [],
        updateStatus: "untracked" as const,
      })),
    };

    expect(projectCaptureCandidatesFromLibrary(snapshot)).toEqual([
      {
        projectRoot: "/projects/mobile-app",
        name: "Mobile App",
        connections: ["codex", "pi"],
        skillCount: 2,
        lastUsedAt: "2026-07-16T09:00:00.000Z",
      },
    ]);
  });
});

describe("local Library location identity", () => {
  it("groups agent folders and an unclassified package under their containing project", () => {
    const projectRoot = "/workspaces/kyoto-v1";
    const baseLocation = {
      sourceKind: "installed" as const,
      skillPath: `${projectRoot}/.agents/skills/adversarial-reviewer/SKILL.md`,
      harness: "codex" as const,
      scope: "project" as const,
      projectRoot,
      active: true,
      modifiedAt: "2026-07-20T10:00:00.000Z",
      lastUsedAt: null,
      origin: null,
      updateStatus: "untracked" as const,
    };
    const snapshot: LibrarySnapshot = {
      generatedAt: "2026-07-20T10:00:00.000Z",
      counts: { total: 1, active: 1, library: 0, draft: 0, archived: 0 },
      skills: [
        {
          skillId: "adversarial-reviewer",
          name: "adversarial-reviewer",
          lifecycle: "active",
          revisions: [],
          locations: [
            { ...baseLocation, packagePath: `${projectRoot}/.agents/skills/adversarial-reviewer` },
            {
              ...baseLocation,
              packagePath: `${projectRoot}/.claude/skills/adversarial-reviewer`,
              skillPath: `${projectRoot}/.claude/skills/adversarial-reviewer/SKILL.md`,
              harness: "claude_code",
            },
            {
              ...baseLocation,
              packagePath: `${projectRoot}/skills/adversarial-reviewer`,
              skillPath: `${projectRoot}/skills/adversarial-reviewer/SKILL.md`,
              harness: null,
              scope: "unknown",
              projectRoot: null,
            },
          ],
          lastUsedAt: null,
          lastModifiedAt: baseLocation.modifiedAt,
          origins: [],
          updateStatus: "untracked",
        },
      ],
    };

    const locations = mapLocalLibraryInventory(snapshot, null, null, mergeHarnesses).skills[0]!
      .locations;
    expect(locations).toHaveLength(3);
    expect(new Set(locations.map((location) => location.groupId))).toEqual(
      new Set([`project:${projectRoot}`]),
    );
    expect(new Set(locations.map((location) => location.label))).toEqual(new Set(["kyoto-v1"]));
    expect(new Set(locations.map((location) => location.rootPath))).toEqual(new Set([projectRoot]));
  });
});

describe("localDashboardModules", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists the overview watchlist through the local dashboard server", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ watched_skills: ["selftune", "playwright-cli"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await localDashboardModules.overview?.mutations.updateOverviewWatchlist?.([
      "selftune",
      "playwright-cli",
    ]);

    expect(result).toEqual(["selftune", "playwright-cli"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/actions/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skills: ["selftune", "playwright-cli"] }),
    });
  });

  it("composes Self-host and Desktop from the same journey modules", () => {
    expect(localDashboardModules.capability.host).toBe("local");
    expect(selfHostDashboardModules.capability.host).toBe("selfhost");
    expect(selfHostDashboardModules.capability.features).toBe(
      localDashboardModules.capability.features,
    );
    expect(localDashboardModules.skills.library.access).toBe("available");
    expect(selfHostDashboardModules.skills.library).toBe(localDashboardModules.skills.library);
    expect(localDashboardModules.skillSets.projects.access).toBe("available");
    expect(selfHostDashboardModules.skillSets.projects).toBe(
      localDashboardModules.skillSets.projects,
    );
  });

  it("passes the selected merge connection and optional model to the runtime", () => {
    expect(connectionNames(mergeHarnesses).get("codex")).toBe("Codex");
    expect(connectionNames(mergeHarnesses).get("cline")).toBe("Cline");
    expect(connectionDisplayName("fixture", new Map())).toBe("fixture");
    expect(localMergeConnections(mergeHarnesses)).toEqual([
      {
        id: "codex",
        label: "Codex",
        supportsModelOverride: true,
        icon: mergeHarnesses[0]?.icon,
      },
    ]);
    expect(
      resolveLocalMergeRequest(
        { skillId: "agent-browser", connectionId: "codex", model: "gpt-5.4" },
        mergeHarnesses,
      ),
    ).toMatchObject({ skillName: "agent-browser", harnessId: "codex", model: "gpt-5.4" });
  });

  it("preserves classifications, source folders, connection icons, and restore receipts", () => {
    const snapshot: LibrarySnapshot = {
      generatedAt: "2026-07-16T10:00:00.000Z",
      counts: { total: 1, active: 1, library: 0, draft: 0, archived: 0 },
      skills: [
        {
          skillId: "agent-browser",
          name: "agent-browser",
          lifecycle: "active",
          revisions: [{ contentHash: "abcdef123456", locations: [] }],
          lastUsedAt: "2026-07-16T09:00:00.000Z",
          lastModifiedAt: "2026-07-15T09:00:00.000Z",
          origins: [
            {
              kind: "github",
              label: "vercel-labs/agent-browser",
              url: "https://github.com/vercel-labs/agent-browser",
            },
            {
              kind: "github",
              label: "vercel-labs/agent-browser",
              url: "https://github.com/vercel-labs/agent-browser.git",
            },
          ],
          updateStatus: "available",
          locations: [
            {
              sourceKind: "installed",
              packagePath: "/Users/test/.agents/skills/agent-browser",
              skillPath: "/Users/test/.agents/skills/agent-browser/SKILL.md",
              harness: "codex",
              scope: "global",
              projectRoot: null,
              active: true,
              modifiedAt: "2026-07-15T09:00:00.000Z",
              lastUsedAt: "2026-07-16T09:00:00.000Z",
              origin: {
                kind: "github",
                label: "vercel-labs/agent-browser",
                url: "https://github.com/vercel-labs/agent-browser",
              },
              updateStatus: "available",
            },
          ],
        },
      ],
    };
    const intelligence: SkillIntelligenceReport = {
      algorithm_version: "skill-intelligence-v3-overlapping-sets",
      evidence_version: 3,
      generated_at: "2026-07-16T10:00:00.000Z",
      sessions_analyzed: 4,
      installed_skills: 1,
      classified_skills: 1,
      thresholds: {
        min_occurrences: 3,
        min_affinity: 0.35,
        holdout_ratio: 0.25,
        min_validation_occurrences: 2,
        min_evidence_score: 0.7,
      },
      validation: { ready: false, discovery_sessions: 3, held_out_sessions: 1, cutoff_at: null },
      feedback: {
        classification_overrides: 0,
        suggestion_reviews: { accepted: 0, edited: 0, dismissed: 0 },
        calibration: {
          algorithm_version: "skill-intelligence-v3-overlapping-sets",
          status: "insufficient_evidence",
          minimum_labeled_reviews: 20,
          labeled_reviews: 0,
          positive_labels: 0,
          negative_labels: 0,
          total_reviews: 0,
          acceptance_rate: 0,
          exact_acceptance_rate: 0,
          edit_rate: 0,
          mean_edit_distance: null,
          dismissal_reasons: {},
          category_corrections: 0,
          applied_min_evidence_score: 0.7,
          balanced_accuracy: null,
        },
      },
      classifications: [
        {
          skill_id: "agent-browser",
          skill_name: "agent-browser",
          category: "agent_tooling",
          inferred_category: "agent_tooling",
          category_label: "Agent Tooling",
          source: "inferred",
          confidence: 0.95,
          reason: "Agent browser workflow terms matched.",
          override_reason: null,
          overridden_at: null,
          matched_terms: ["agent", "browser"],
          observed_queries: 4,
          co_used_with: [],
        },
      ],
      suggestions: [],
      catalog_expansions: [],
      outcomes: [],
      trace_signals: [],
      execution_patterns: [],
    };
    const portfolio: PortfolioResponse = {
      audit: {
        generated_at: "2026-07-16T10:00:00.000Z",
        thresholds: {
          min_sessions: 1,
          inactive_days: 30,
          min_checks: 5,
          routing_miss_rate: 0.2,
        },
        session_count: 4,
        installed_count: 1,
        counts: {
          protected: 0,
          unobserved: 0,
          under_observed: 0,
          routing_problem: 0,
          active: 0,
          inactive_candidate: 1,
          consolidation_candidate: 0,
        },
        skills: [
          {
            skill_name: "agent-browser",
            skill_path: "/Users/test/.agents/skills/agent-browser/SKILL.md",
            package_path: "/Users/test/.agents/skills/agent-browser",
            scope: "global",
            classification: "inactive_candidate",
            recommendation: "review_quarantine",
            reason: "No trusted use was observed during the inactive window.",
            evidence: {
              trusted_checks: 12,
              triggered_count: 1,
              miss_rate: 0,
              last_seen_at: "2026-07-16T09:00:00.000Z",
              last_invoked_at: "2026-05-01T09:00:00.000Z",
              sessions_since_invocation: 12,
              inactive_days: 76,
              package_modified_at: "2026-07-15T09:00:00.000Z",
            },
          },
        ],
      },
      quarantined: [
        {
          schema_version: 1,
          quarantine_id: "restore-1",
          status: "quarantined",
          skill_name: "agent-browser",
          skill_scope: "global",
          original_package_path: "/Users/test/.agents/skills/agent-browser",
          original_skill_path: "/Users/test/.agents/skills/agent-browser/SKILL.md",
          quarantined_package_path: "/archive/agent-browser",
          package_version_hash: "abc",
          quarantined_at: "2026-07-16T09:30:00.000Z",
          restored_at: null,
        },
      ],
    };

    const mapped = mapLocalLibraryInventory(snapshot, intelligence, portfolio, mergeHarnesses);
    expect(mapped.categoryOptions).toContainEqual({ id: "agent_tooling", label: "Agent Tooling" });
    expect(mapped.skills[0]).toMatchObject({
      category: { id: "agent_tooling", source: "inferred", confidence: 0.95 },
      restoreId: "restore-1",
      revisionHashes: ["abcdef123456"],
      sources: [{ path: "/Users/test/.agents/skills/agent-browser" }],
      locations: [
        {
          sourceKind: "installed",
          connection: "Codex",
          connectionIcon: mergeHarnesses[0]?.icon,
        },
      ],
      archiveRecommendation: {
        classification: "inactive_candidate",
        skillPath: "/Users/test/.agents/skills/agent-browser/SKILL.md",
      },
    });
    expect(mapped.skills[0]?.sources).toHaveLength(1);

    const analyticsWithoutObservations: AnalyticsResponse = {
      pass_rate_trend: [],
      skill_rankings: [],
      skill_trigger_trends: [],
      daily_activity: [],
      evolution_impact: [],
      summary: {
        total_evolutions: 0,
        avg_improvement: 0,
        total_checks_30d: 0,
        active_skills: 0,
      },
    };
    const withoutObservations = mapLocalLibraryInventory(
      snapshot,
      intelligence,
      portfolio,
      mergeHarnesses,
      analyticsWithoutObservations,
    );
    expect(withoutObservations.skills[0]).toMatchObject({
      triggerTrend: [],
      lifetimeTriggerCount: 0,
    });

    const withoutEvidence = mapLocalLibraryInventory(
      snapshot,
      intelligence,
      {
        ...portfolio,
        audit: {
          ...portfolio.audit,
          skills: portfolio.audit.skills.map(
            (entry): PortfolioAuditEntry => ({
              ...entry,
              classification: "unobserved",
              recommendation: "measure",
            }),
          ),
        },
      },
      mergeHarnesses,
    );
    expect(withoutEvidence.skills[0]?.archiveRecommendation).toBeNull();
  });

  it("maps shared create, edit, plan, apply, conflict, and rollback contracts", () => {
    const create: ProjectSkillSetInput = {
      name: "Software Development",
      description: "Engineering workflow",
      connections: ["codex"],
      skills: [{ name: "tdd", packagePath: "/skills/tdd" }],
    };
    expect(localProjectSkillSetInput(create)).toEqual({
      name: "Software Development",
      description: "Engineering workflow",
      harnesses: ["codex"],
      skills: [{ name: "tdd", package_path: "/skills/tdd" }],
    });
    expect(
      localProjectSkillSetInput({
        ...create,
        skills: [
          {
            name: "serve-sim",
            provenance: "catalog",
            catalogId: "evanbacon/serve-sim/serve-sim",
            source: "evanbacon/serve-sim",
            installSpec: "evanbacon/serve-sim@serve-sim",
            downloadUrl: "https://skills.sh/api/download/evanbacon/serve-sim/serve-sim",
          },
        ],
      }),
    ).toMatchObject({
      skills: [
        {
          name: "serve-sim",
          catalog_id: "evanbacon/serve-sim/serve-sim",
          install_spec: "evanbacon/serve-sim@serve-sim",
        },
      ],
    });
    expect(
      localProjectSkillSetUpdateInput({
        name: create.name,
        description: create.description,
        connections: create.connections,
        skills: [{ name: "tdd", packagePath: "/skills/tdd" }],
        id: "software-development",
        parentRevisionHash: "revision-1",
      }),
    ).toMatchObject({ set_id: "software-development", parent_revision_hash: "revision-1" });
    expect(
      localProjectSkillSetTargetInput({
        skillSetId: "software-development",
        projectRoot: "/projects/app",
      }),
    ).toEqual({ set_id: "software-development", project_root: "/projects/app" });

    const plan = mapLocalSkillSetPlan({
      set_id: "software-development",
      set_name: "Software Development",
      set_revision_hash: "revision-1",
      project_root: "/projects/app",
      creates: 0,
      unchanged: 0,
      conflicts: 1,
      missing_dependencies: 0,
      operations: [
        {
          harness: "codex",
          skill_name: "tdd",
          content_hash: "abc",
          source_path: "/skills/tdd",
          target_path: "/projects/app/.agents/skills/tdd",
          action: "conflict",
          reason: "Destination differs",
        },
      ],
    });
    expect(plan.conflicts).toBe(1);
    expect(plan.operations[0]?.action).toBe("conflict");

    const receipt = mapLocalSkillSetReceipt({
      schema_version: 1,
      receipt_id: "receipt-1",
      set_id: "software-development",
      set_name: "Software Development",
      set_revision_hash: "revision-1",
      project_root: "/projects/app",
      status: "applied",
      operations: [],
      applied_at: "2026-07-16T10:00:00.000Z",
      rolled_back_at: null,
      dependencies_downloaded: 2,
    });
    expect(receipt).toMatchObject({
      id: "receipt-1",
      status: "applied",
      dependenciesDownloaded: 2,
    });
  });

  it("preserves Skill Set suggestions, outcomes, and review evidence through the shared adapter", () => {
    const report: SkillIntelligenceReport = {
      algorithm_version: "skill-intelligence-v3-overlapping-sets",
      evidence_version: 3,
      generated_at: "2026-07-16T10:00:00.000Z",
      sessions_analyzed: 16,
      installed_skills: 3,
      classified_skills: 3,
      thresholds: {
        min_occurrences: 3,
        min_affinity: 0.35,
        holdout_ratio: 0.25,
        min_validation_occurrences: 2,
        min_evidence_score: 0.7,
      },
      validation: {
        ready: true,
        discovery_sessions: 12,
        held_out_sessions: 4,
        cutoff_at: "2026-07-15T10:00:00.000Z",
      },
      feedback: {
        classification_overrides: 0,
        suggestion_reviews: { accepted: 12, edited: 4, dismissed: 8 },
        calibration: {
          algorithm_version: "skill-intelligence-v3-overlapping-sets",
          status: "calibrated",
          minimum_labeled_reviews: 20,
          labeled_reviews: 24,
          positive_labels: 16,
          negative_labels: 8,
          total_reviews: 24,
          acceptance_rate: 0.667,
          exact_acceptance_rate: 0.5,
          edit_rate: 0.167,
          mean_edit_distance: 0.1,
          dismissal_reasons: { not_a_real_pattern: 8 },
          category_corrections: 0,
          applied_min_evidence_score: 0.72,
          balanced_accuracy: 0.8,
        },
      },
      classifications: [],
      suggestions: [
        {
          suggestion_id: "co-usage-set-1",
          evidence_fingerprint: "evidence-1",
          name: "Cloud UI Debugging",
          description: "An overlapping skill community.",
          pattern: "co_usage",
          skills: [
            {
              name: "diagnose",
              package_path: "/skills/diagnose",
              category: "testing_quality",
              role: "Pairs with shadcn in repeated sessions.",
              source_id: "mattpocock/skills",
              membership_score: 0.91,
            },
            {
              name: "shadcn",
              package_path: "/skills/shadcn",
              category: "design",
              role: "Pairs with diagnose in repeated sessions.",
              source_id: "vercel-labs/agent-skills",
              membership_score: 0.87,
            },
          ],
          harnesses: ["codex"],
          project_root: null,
          evidence_state: "validated",
          confidence: 0.91,
          occurrence_count: 8,
          discovery_occurrence_count: 6,
          held_out_occurrence_count: 2,
          support: 0.75,
          held_out_support: 0.5,
          affinity: 0.8,
          held_out_affinity: 0.6,
          sequence_consistency: null,
          held_out_sequence_consistency: null,
          synergy_score: null,
          discovery_edge_coverage: 1,
          held_out_edge_coverage: 0.75,
          reason: "The skills recur as an overlapping set in held-out sessions.",
        },
      ],
      catalog_expansions: [],
      outcomes: [
        {
          outcome_id: "outcome-1",
          review_id: "review-1",
          receipt_id: "receipt-1",
          set_id: "cloud-ui-debugging",
          algorithm_version: "skill-intelligence-v3-overlapping-sets",
          project_root: "/projects/app",
          activated_at: "2026-07-15T10:00:00.000Z",
          measured_at: "2026-07-16T10:00:00.000Z",
          status: "improved",
          reason: "Completion improved.",
          causal_claim: false,
          minimum_sessions: 3,
          before_session_count: 4,
          after_session_count: 5,
          metrics: {
            completion_quality: {
              before: 0.6,
              after: 0.8,
              delta: 0.2,
              direction: "improved",
              before_samples: 4,
              after_samples: 5,
            },
            error_rate: {
              before: 2,
              after: 1,
              delta: -1,
              direction: "improved",
              before_samples: 4,
              after_samples: 5,
            },
            trigger_coverage: {
              before: 0.5,
              after: 0.75,
              delta: 0.25,
              direction: "improved",
              before_samples: 4,
              after_samples: 5,
            },
            token_cost: {
              before: 1200,
              after: 1100,
              delta: -100,
              direction: "improved",
              before_samples: 4,
              after_samples: 5,
            },
            grading: {
              before: 0.65,
              after: 0.85,
              delta: 0.2,
              direction: "improved",
              before_samples: 4,
              after_samples: 5,
            },
          },
        },
      ],
      trace_signals: [
        {
          skill_name: "diagnose",
          invocation_count: 3,
          trace_count: 3,
          error_trace_count: 2,
          duration_ms: 1250,
          input_tokens: 320,
          output_tokens: 140,
          error_count: 2,
          tool_call_count: 5,
        },
      ],
      execution_patterns: [
        {
          pattern_id: "execution-pattern-diagnose",
          kind: "repeated_correlated_errors",
          skill_id: "diagnose",
          skill_name: "diagnose",
          trace_count: 3,
          matching_trace_count: 2,
          ratio: 0.667,
          evidence_state: "supported",
          causal_claim: false,
          reason: "Errors correlated with 2 of 3 traced diagnose executions.",
        },
      ],
    };

    const mapped = mapLocalSkillSetIntelligence(report);
    expect(mapped).toMatchObject({
      validation: { discoverySessions: 12, heldOutSessions: 4 },
      calibration: { labeledReviews: 24, appliedMinEvidenceScore: 0.72 },
    });
    expect(mapped.suggestions[0]).toMatchObject({
      id: "co-usage-set-1",
      evidenceFingerprint: "evidence-1",
      heldOutOccurrenceCount: 2,
      discoveryEdgeCoverage: 1,
      heldOutEdgeCoverage: 0.75,
    });
    expect(mapped.suggestions[0]?.skills[0]).toEqual({
      name: "diagnose",
      packagePath: "/skills/diagnose",
      role: "Pairs with shadcn in repeated sessions.",
      sourceId: "mattpocock/skills",
      membershipScore: 0.91,
    });
    expect(mapped.outcomes[0]).toMatchObject({
      id: "outcome-1",
      skillSetId: "cloud-ui-debugging",
      status: "improved",
    });
    expect(mapped.traceSignals).toEqual([
      {
        skillName: "diagnose",
        invocationCount: 3,
        traceCount: 3,
        errorTraceCount: 2,
        durationMs: 1250,
        inputTokens: 320,
        outputTokens: 140,
        errorCount: 2,
        toolCallCount: 5,
      },
    ]);
    expect(mapped.executionPatterns).toEqual([
      {
        id: "execution-pattern-diagnose",
        kind: "repeated_correlated_errors",
        skillId: "diagnose",
        skillName: "diagnose",
        traceCount: 3,
        matchingTraceCount: 2,
        ratio: 0.667,
        evidenceState: "supported",
        causalClaim: false,
        reason: "Errors correlated with 2 of 3 traced diagnose executions.",
      },
    ]);
    expect(
      localSkillSetSuggestionReviewInput({
        suggestionId: "co-usage-set-1",
        evidenceFingerprint: "evidence-1",
        decision: "edited",
        reasonCode: "edited_before_creation",
        resultingSkillSetId: "cloud-ui-debugging",
        resultingRevisionHash: "revision-1",
        editedFields: ["name"],
        result: {
          name: "Cloud UI Toolkit",
          description: "Edited description",
          connections: ["codex"],
          skills: ["diagnose", "shadcn"],
        },
      }),
    ).toMatchObject({
      suggestion_id: "co-usage-set-1",
      evidence_fingerprint: "evidence-1",
      decision: "edited",
      resulting_set_id: "cloud-ui-debugging",
      edited_fields: ["name"],
      result: { harnesses: ["codex"], skills: ["diagnose", "shadcn"] },
    });
  });

  it("preserves machine-readable Sync & Backup failures for the desktop UI", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "AUTH_MISSING",
            message: "Sync & Backup credentials were rejected.",
            suggestion: "Reconnect Sync & Backup in Settings.",
            retryable: false,
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );

    try {
      await applyProjectSkillSet({ set_id: "software-development", project_root: "/project" });
      throw new Error("Expected apply to fail.");
    } catch (cause) {
      expect(cause).toBeInstanceOf(DashboardApiError);
      if (!(cause instanceof DashboardApiError)) throw cause;
      expect(cause.code).toBe("AUTH_MISSING");
      expect(cause.suggestion).toBe("Reconnect Sync & Backup in Settings.");
      expect(cause.retryable).toBe(false);
    }
  });
});
