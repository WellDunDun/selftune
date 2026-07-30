import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Mock heavy external dependencies to avoid import timeouts
vi.mock("lucide-react", () => ({
  Activity: () => null,
  AlertCircleIcon: () => null,
  AlertTriangleIcon: () => null,
  ArrowLeft: () => null,
  BoltIcon: () => null,
  Bot: () => null,
  Boxes: () => null,
  CheckCircleIcon: () => null,
  ChevronDownIcon: () => null,
  CircleDotIcon: () => null,
  ClockIcon: () => null,
  Cpu: () => null,
  EyeIcon: () => null,
  HelpCircleIcon: () => null,
  LayersIcon: () => null,
  Loader2: () => null,
  RefreshCwIcon: () => null,
  RocketIcon: () => null,
  SparklesIcon: () => null,
  TerminalSquare: () => null,
  XCircleIcon: () => null,
}));

vi.mock("@selftune/ui/primitives", () => ({
  Badge: () => null,
  Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
  Card: ({ children }: { children: unknown }) => children,
  CardAction: ({ children }: { children: unknown }) => children,
  CardContent: ({ children }: { children: unknown }) => children,
  CardDescription: ({ children }: { children: unknown }) => children,
  CardHeader: ({ children }: { children: unknown }) => children,
  CardTitle: ({ children }: { children: unknown }) => children,
  Tabs: ({ children }: { children: unknown }) => children,
  TabsContent: ({ children }: { children: unknown }) => children,
  TabsList: ({ children }: { children: unknown }) => children,
  TabsTrigger: ({ children }: { children: unknown }) => children,
}));

vi.mock("@selftune/ui/components", () => ({
  AutonomyHeroCard: () => <div>Autonomy Hero</div>,
  SupervisionFeed: () => <div>Supervision Feed</div>,
  TrustWatchlistRail: () => <div>Trust Watchlist</div>,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => null,
}));

vi.mock("@/api", () => ({
  runDashboardAction: vi.fn(),
}));

vi.mock("@selftune/dashboard-core/screens/overview", () => ({
  OverviewCompositionSurface: ({
    cleanup,
    sectionsBeforeFeed,
  }: {
    cleanup?: {
      activeSkillCount: number;
      candidates: Array<unknown>;
      consolidationCandidates?: Array<unknown>;
    };
    sectionsBeforeFeed?: React.ReactNode;
  }) => (
    <div>
      {cleanup ? `Cleanup ${cleanup.candidates.length} of ${cleanup.activeSkillCount}` : null}
      {cleanup?.consolidationCandidates
        ? `Duplicates ${cleanup.consolidationCandidates.length}`
        : null}
      {sectionsBeforeFeed}
    </div>
  ),
}));

vi.mock("react-router-dom", () => ({
  Link: () => null,
  useNavigate: () => () => {},
  useParams: () => ({ name: "test-skill" }),
  useSearchParams: () => [new URLSearchParams(), () => {}],
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock("../hooks/useOrchestrateRuns", () => ({
  useOrchestrateRuns: () => ({
    data: null,
    isPending: true,
    isError: false,
    error: null,
  }),
}));

vi.mock("../hooks/usePortfolio", () => ({
  usePortfolio: () => ({
    data: {
      audit: {
        generated_at: "2026-07-22T00:00:00.000Z",
        thresholds: {
          min_sessions: 20,
          inactive_days: 30,
          min_checks: 10,
          routing_miss_rate: 0.85,
        },
        session_count: 40,
        installed_count: 12,
        counts: {
          protected: 1,
          unobserved: 2,
          under_observed: 1,
          routing_problem: 0,
          active: 7,
          inactive_candidate: 1,
          consolidation_candidate: 0,
        },
        skills: [
          {
            skill_name: "stale-skill",
            skill_path: "/skills/stale-skill/SKILL.md",
            package_path: "/skills/stale-skill",
            scope: "global",
            classification: "inactive_candidate",
            recommendation: "review_quarantine",
            reason: "No trusted invocation for 45 days across 30 subsequent sessions.",
            evidence: {
              trusted_checks: 12,
              triggered_count: 1,
              miss_rate: 0,
              last_seen_at: "2026-06-07T00:00:00.000Z",
              last_invoked_at: "2026-06-07T00:00:00.000Z",
              sessions_since_invocation: 30,
              inactive_days: 45,
              package_modified_at: "2026-01-01T00:00:00.000Z",
            },
          },
        ],
      },
      quarantined: [],
    },
  }),
}));

vi.mock("../hooks/useLibrary", () => ({
  useLibrary: () => ({
    data: {
      generatedAt: "2026-07-22T00:00:00.000Z",
      counts: { total: 1, active: 1, library: 0, draft: 0, archived: 0 },
      skills: [
        {
          skillId: "agent-browser",
          name: "agent-browser",
          lifecycle: "active",
          revisions: [
            {
              contentHash: "current-hash",
              locations: [
                {
                  sourceKind: "installed",
                  packagePath: "/home/test/.agents/skills/agent-browser",
                  skillPath: "/home/test/.agents/skills/agent-browser/SKILL.md",
                  harness: "codex",
                  scope: "global",
                  projectRoot: null,
                  linkedPackagePath: null,
                  active: true,
                  modifiedAt: "2026-07-20T10:00:00.000Z",
                  lastUsedAt: "2026-07-20T10:00:00.000Z",
                  origin: null,
                  updateStatus: "current",
                },
                {
                  sourceKind: "installed",
                  packagePath: "/projects/app/.agents/skills/agent-browser",
                  skillPath: "/projects/app/.agents/skills/agent-browser/SKILL.md",
                  harness: "codex",
                  scope: "project",
                  projectRoot: "/projects/app",
                  linkedPackagePath: null,
                  active: true,
                  modifiedAt: "2026-07-18T10:00:00.000Z",
                  lastUsedAt: "2026-07-18T10:00:00.000Z",
                  origin: null,
                  updateStatus: "untracked",
                },
              ],
            },
          ],
          locations: [],
          lastUsedAt: "2026-07-20T10:00:00.000Z",
          lastModifiedAt: "2026-07-20T10:00:00.000Z",
          origins: [],
          updateStatus: "current",
        },
      ],
    },
  }),
}));

describe("Overview", () => {
  it("module exports Overview component", async () => {
    const { Overview } = await import("./Overview");
    expect(Overview).toBeDefined();
    expect(typeof Overview).toBe("function");
  });

  it("surfaces evidence-backed cleanup candidates after history processing", async () => {
    const { Overview } = await import("./Overview");
    const html = renderToStaticMarkup(
      <Overview
        search=""
        statusFilter="ALL"
        onStatusFilterChange={() => {}}
        overviewQuery={
          {
            data: {
              overview: {
                telemetry: [],
                skills: [],
                evolution: [],
                counts: {
                  telemetry: 0,
                  skills: 0,
                  evolution: 0,
                  evidence: 0,
                  sessions: 0,
                  prompts: 0,
                },
                unmatched_queries: [],
                pending_proposals: [],
                active_sessions: 0,
                recent_activity: [],
              },
              skills: [],
              watched_skills: [],
              autonomy_status: {
                level: "watching",
                summary: "watching",
                last_run: null,
                skills_observed: 0,
                pending_reviews: 0,
                attention_required: 0,
              },
              attention_queue: [],
              trust_watchlist: [],
              recent_decisions: [],
              creator_testing: null,
            },
            isPending: false,
            isError: false,
            error: null,
            refetch: () => Promise.resolve(),
          } as never
        }
      />,
    );

    expect(html).toContain("Cleanup 1 of 12");
    expect(html).toContain("Duplicates 1");
  });

  it("renders the creator test loop summary when overview data includes it", async () => {
    const { Overview } = await import("./Overview");
    const html = renderToStaticMarkup(
      <Overview
        search=""
        statusFilter="ALL"
        onStatusFilterChange={() => {}}
        overviewQuery={
          {
            data: {
              overview: {
                telemetry: [],
                skills: [],
                evolution: [],
                counts: {
                  telemetry: 0,
                  skills: 0,
                  evolution: 0,
                  evidence: 0,
                  sessions: 0,
                  prompts: 0,
                },
                unmatched_queries: [],
                pending_proposals: [],
                active_sessions: 0,
                recent_activity: [],
              },
              skills: [],
              watched_skills: [],
              autonomy_status: {
                level: "watching",
                summary: "watching",
                last_run: null,
                skills_observed: 0,
                pending_reviews: 0,
                attention_required: 0,
              },
              attention_queue: [],
              trust_watchlist: [],
              recent_decisions: [],
              creator_testing: {
                summary: "1 still needs evals.",
                counts: {
                  run_create_check: 0,
                  finish_package: 0,
                  generate_evals: 1,
                  run_unit_tests: 0,
                  run_replay_dry_run: 0,
                  measure_baseline: 0,
                  deploy_candidate: 0,
                  watch_deployment: 0,
                },
                priorities: [
                  {
                    skill_name: "research",
                    step: "generate_evals",
                    summary: "Trusted telemetry exists, but no canonical eval set is stored yet.",
                    recommended_command: "selftune eval generate --skill research",
                  },
                ],
              },
            },
            isPending: false,
            isError: false,
            error: null,
            refetch: () => Promise.resolve(),
          } as never
        }
      />,
    );

    expect(html).toContain("Draft skill lifecycle");
    expect(html).toContain("Generate evals");
    expect(html).toContain("Ship candidate");
    expect(html).toContain("selftune eval generate --skill research");
    expect(html).toContain("Run now");
  });

  it("renders draft-package create-check priorities in the creator test loop panel", async () => {
    const { Overview } = await import("./Overview");
    const html = renderToStaticMarkup(
      <Overview
        search=""
        statusFilter="ALL"
        onStatusFilterChange={() => {}}
        overviewQuery={
          {
            data: {
              overview: {
                telemetry: [],
                skills: [],
                evolution: [],
                counts: {
                  telemetry: 0,
                  skills: 0,
                  evolution: 0,
                  evidence: 0,
                  sessions: 0,
                  prompts: 0,
                },
                unmatched_queries: [],
                pending_proposals: [],
                active_sessions: 0,
                recent_activity: [],
              },
              skills: [],
              watched_skills: [],
              autonomy_status: {
                level: "watching",
                summary: "watching",
                last_run: null,
                skills_observed: 0,
                pending_reviews: 0,
                attention_required: 0,
              },
              attention_queue: [],
              trust_watchlist: [],
              recent_decisions: [],
              creator_testing: {
                summary: "1 need create check.",
                counts: {
                  run_create_check: 1,
                  finish_package: 0,
                  generate_evals: 0,
                  run_unit_tests: 0,
                  run_replay_dry_run: 0,
                  measure_baseline: 0,
                  deploy_candidate: 0,
                  watch_deployment: 0,
                },
                priorities: [
                  {
                    skill_name: "draft-writer",
                    step: "run_create_check",
                    summary: "Run create check before publishing.",
                    recommended_command:
                      "selftune create check --skill-path /workspace/draft-writer/SKILL.md",
                  },
                ],
              },
            },
            isPending: false,
            isError: false,
            error: null,
            refetch: () => Promise.resolve(),
          } as never
        }
      />,
    );

    expect(html).toContain("Verify draft");
    expect(html).toContain("selftune verify --skill-path /workspace/draft-writer/SKILL.md");
    expect(html).toContain("Run now");
  });
});
