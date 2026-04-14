import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Mock heavy external dependencies to avoid import timeouts
vi.mock("lucide-react", () => ({
  AlertCircleIcon: () => null,
  AlertTriangleIcon: () => null,
  BoltIcon: () => null,
  CheckCircleIcon: () => null,
  ChevronDownIcon: () => null,
  CircleDotIcon: () => null,
  ClockIcon: () => null,
  EyeIcon: () => null,
  HelpCircleIcon: () => null,
  LayersIcon: () => null,
  RefreshCwIcon: () => null,
  RocketIcon: () => null,
  SparklesIcon: () => null,
  XCircleIcon: () => null,
}));

vi.mock("@selftune/ui/primitives", () => ({
  Badge: () => null,
  Button: () => null,
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

vi.mock("@selftune/dashboard-core/screens/overview", () => ({
  OverviewCompositionSurface: ({
    sectionsBeforeFeed,
  }: {
    sectionsBeforeFeed?: React.ReactNode;
  }) => <div>{sectionsBeforeFeed}</div>,
}));

vi.mock("react-router-dom", () => ({
  Link: () => null,
  useNavigate: () => () => {},
  useParams: () => ({ name: "test-skill" }),
  useSearchParams: () => [new URLSearchParams(), () => {}],
}));

vi.mock("../hooks/useOrchestrateRuns", () => ({
  useOrchestrateRuns: () => ({
    data: null,
    isPending: true,
    isError: false,
    error: null,
  }),
}));

describe("Overview", () => {
  it("module exports Overview component", async () => {
    const { Overview } = await import("./Overview");
    expect(Overview).toBeDefined();
    expect(typeof Overview).toBe("function");
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
                    next_step: "generate_evals",
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

    expect(html).toContain("Creator test loop");
    expect(html).toContain("Generate evals");
    expect(html).toContain("Deploy candidate");
    expect(html).toContain("selftune eval generate --skill research");
  });
});
