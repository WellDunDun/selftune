import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockSkillReportData: unknown = null;

vi.mock("@selftune/ui/primitives", () => ({
  Badge: ({ children }: { children?: unknown }) => <span>{children}</span>,
  Button: ({ children, render }: { children?: unknown; render?: unknown }) =>
    render ? render : <button>{children}</button>,
  Card: ({ children }: { children?: unknown }) => <section>{children}</section>,
  CardAction: ({ children }: { children?: unknown }) => <div>{children}</div>,
  CardContent: ({ children }: { children?: unknown }) => <div>{children}</div>,
  CardDescription: ({ children }: { children?: unknown }) => <p>{children}</p>,
  CardHeader: ({ children }: { children?: unknown }) => <header>{children}</header>,
  CardTitle: ({ children }: { children?: unknown }) => <h2>{children}</h2>,
  Table: ({ children }: { children?: unknown }) => <table>{children}</table>,
  TableBody: ({ children }: { children?: unknown }) => <tbody>{children}</tbody>,
  TableCell: ({ children, title }: { children?: unknown; title?: string }) => (
    <td title={title}>{children}</td>
  ),
  TableHead: ({ children }: { children?: unknown }) => <th>{children}</th>,
  TableHeader: ({ children }: { children?: unknown }) => <thead>{children}</thead>,
  TableRow: ({ children }: { children?: unknown }) => <tr>{children}</tr>,
  Tabs: ({ children }: { children: unknown }) => children,
  TabsList: ({ children }: { children?: unknown }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children?: unknown }) => <button>{children}</button>,
  TabsContent: ({ children }: { children?: unknown }) => <div>{children}</div>,
  Tooltip: ({ children }: { children?: unknown }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: unknown }) => <span>{children}</span>,
  TooltipTrigger: ({ children, render }: { children?: unknown; render?: React.ReactNode }) =>
    render ? (
      <>
        {render}
        {children}
      </>
    ) : (
      <>{children}</>
    ),
}));

vi.mock("@selftune/ui/components", () => ({
  EvolutionTimeline: () => <div>Evolution Timeline</div>,
  EvidenceViewer: () => <div>Evidence Viewer</div>,
  InfoTip: () => <span>i</span>,
}));

vi.mock("@selftune/ui/lib", () => ({
  formatRate: (v: number) => `${Math.round(v * 100)}%`,
  timeAgo: () => "just now",
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => null,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children?: unknown }) => <>{children}</>,
  SheetContent: ({ children }: { children?: unknown }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children?: unknown }) => <p>{children}</p>,
  SheetHeader: ({ children }: { children?: unknown }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children?: unknown }) => <h2>{children}</h2>,
}));

vi.mock("react-router-dom", () => ({
  Link: ({ children, to }: { children?: unknown; to?: string }) => <a href={to}>{children}</a>,
  useParams: () => ({ name: "test-skill" }),
  useSearchParams: () => [new URLSearchParams(), () => {}],
}));

vi.mock("lucide-react", () => ({
  AlertCircleIcon: () => null,
  ActivityIcon: () => null,
  ArrowLeftIcon: () => null,
  ArrowRightIcon: () => null,
  BarChart3Icon: () => null,
  CheckCircleIcon: () => null,
  ChevronDownIcon: () => null,
  ChevronRightIcon: () => null,
  ClockIcon: () => null,
  CoinsIcon: () => null,
  DatabaseIcon: () => null,
  EyeIcon: () => null,
  FilterIcon: () => null,
  FlaskConicalIcon: () => null,
  FolderIcon: () => null,
  GaugeIcon: () => null,
  GitBranchIcon: () => null,
  LayersIcon: () => null,
  MessageSquareTextIcon: () => null,
  RefreshCwIcon: () => null,
  RocketIcon: () => null,
  SearchIcon: () => null,
  ServerIcon: () => null,
  ShieldAlertIcon: () => null,
  ShieldCheckIcon: () => null,
  ShieldIcon: () => null,
  ShieldQuestionIcon: () => null,
  SparklesIcon: () => null,
  TargetIcon: () => null,
  AlertTriangleIcon: () => null,
  TrendingDownIcon: () => null,
  TrendingUpIcon: () => null,
  AlertOctagonIcon: () => null,
  XIcon: () => null,
}));

vi.mock("../hooks/useSkillReport", () => ({
  useSkillReport: () => ({
    data: mockSkillReportData,
    isPending: false,
    isError: false,
    error: null,
    refetch: () => {},
  }),
}));

beforeEach(() => {
  mockSkillReportData = {
    skill_name: "selftune",
    usage: { total_checks: 125, pass_rate: 0.84, missed_triggers: 6 },
    sessions_with_skill: 98,
    evidence: [{ proposal_id: "p1" }],
    evolution: [{ proposal_id: "p1", action: "validated", timestamp: "2026-03-31T00:00:00Z" }],
    pending_proposals: [],
    canonical_invocations: [
      {
        session_id: "sess-1",
        timestamp: "2026-03-31T00:00:00Z",
        query: "test query",
        triggered: true,
        invocation_mode: "implicit",
        confidence: 0.7,
        tool_name: null,
        agent_type: "agent-a",
        observation_kind: "canonical",
      },
    ],
    session_metadata: [
      { session_id: "sess-1", started_at: "2026-03-31T00:00:00Z", model: "claude" },
    ],
    trust: {
      state: "validated",
      summary: "Validated with evidence but not yet deployed.",
    },
    coverage: {
      checks: 125,
      sessions: 98,
      workspaces: 14,
      last_seen: "2026-03-31T00:00:00Z",
      first_seen: "2026-03-01T00:00:00Z",
    },
    evidence_quality: {
      prompt_link_rate: 0.84,
      inline_query_rate: 0.16,
      user_prompt_rate: 0.4,
      meta_prompt_rate: 0.4,
      no_prompt_rate: 0.2,
      system_like_rate: 0.06,
      invocation_mode_coverage: 0.9,
      confidence_coverage: 0.9,
      source_coverage: 0.4,
      scope_coverage: 0.2,
    },
    routing_quality: {
      missed_triggers: 6,
      miss_rate: 0.05,
      avg_confidence: 0.71,
      confidence_coverage: 0.9,
      low_confidence_rate: 0.1,
    },
    evolution_state: {
      has_evidence: true,
      has_pending_proposals: false,
      latest_action: "validated",
      latest_timestamp: "2026-03-31T00:00:00Z",
      evidence_rows: 81,
      evolution_rows: 82,
    },
    data_hygiene: {
      naming_variants: ["selftune"],
      source_breakdown: [{ source: "claude", count: 10 }],
      prompt_kind_breakdown: [{ kind: "meta", count: 10 }],
      observation_breakdown: [{ kind: "canonical", count: 10 }],
    },
    examples: {
      good: [
        {
          timestamp: "2026-03-31T00:00:00Z",
          session_id: "sess-1",
          query_text: "good query",
          triggered: true,
          confidence: 0.7,
          invocation_mode: "implicit",
          prompt_kind: "meta",
          source: null,
          platform: "codex",
          workspace_path: "/workspace",
          query_origin: "matched_prompt",
          is_system_like: false,
          observation_kind: "canonical",
        },
      ],
      missed: [],
      noisy: [],
    },
  };
});

describe("SkillReport", () => {
  it("module exports SkillReport component", async () => {
    const { SkillReport } = await import("./SkillReport");
    expect(SkillReport).toBeDefined();
    expect(typeof SkillReport).toBe("function");
  });

  it("renders tabs directly before tab-controlled content", async () => {
    const { SkillReport } = await import("./SkillReport");
    const html = renderToStaticMarkup(<SkillReport />);

    expect(html.indexOf("Trust Signals")).toBeLessThan(html.indexOf("Evidence"));
    expect(html.indexOf("Evidence")).toBeLessThan(html.indexOf("Prompt Evidence"));
    expect(html.indexOf("Prompt Evidence")).toBeLessThan(html.indexOf("Evidence Viewer"));
  });

  it("does not duplicate the latest decision block", async () => {
    const { SkillReport } = await import("./SkillReport");
    const html = renderToStaticMarkup(<SkillReport />);

    expect(html.match(/Latest Decision/g)?.length).toBe(1);
  });

  it("renders evidence and data quality panel content in their sections", async () => {
    const { SkillReport } = await import("./SkillReport");
    const html = renderToStaticMarkup(<SkillReport />);

    expect(html).toContain("Prompt Evidence");
    expect(html).toContain("Evidence Quality Rates");
    expect(html).toContain("Data Hygiene");
  });

  it("renders the plain-language education layer", async () => {
    const { SkillReport } = await import("./SkillReport");
    const html = renderToStaticMarkup(<SkillReport />);

    expect(html).toContain("How selftune is improving this skill");
    expect(html).toContain("What selftune saw");
    expect(html).toContain("Why it acted");
    expect(html).toContain("What happened next");
    expect(html).toContain("How this works");
  });
});
