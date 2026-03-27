import { describe, expect, it, vi } from "vitest";

// Mock heavy external dependencies to avoid import timeouts
vi.mock("@selftune/ui/components", () => ({
  ActivityPanel: () => null,
  EvidenceViewer: () => null,
  EvolutionTimeline: () => null,
  InfoTip: () => null,
  OrchestrateRunsPanel: () => null,
  RecentActivityFeed: () => null,
  SectionCards: () => null,
  SkillHealthGrid: () => null,
}));

vi.mock("@selftune/ui/primitives", () => ({
  Button: () => null,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => null,
}));

vi.mock("react-router-dom", () => ({
  Link: () => null,
  useNavigate: () => () => {},
  useParams: () => ({ name: "test-skill" }),
  useSearchParams: () => [new URLSearchParams(), () => {}],
}));

vi.mock("lucide-react", () => ({
  AlertCircleIcon: () => null,
  AlertOctagonIcon: () => null,
  ActivityIcon: () => null,
  ArrowLeftIcon: () => null,
  ChevronRightIcon: () => null,
  ClockIcon: () => null,
  CoinsIcon: () => null,
  EyeIcon: () => null,
  FlaskConicalIcon: () => null,
  FolderIcon: () => null,
  LayersIcon: () => null,
  MessageSquareTextIcon: () => null,
  RefreshCwIcon: () => null,
  RocketIcon: () => null,
  ServerIcon: () => null,
  TargetIcon: () => null,
  TrendingDownIcon: () => null,
  TrendingUpIcon: () => null,
  XIcon: () => null,
}));

vi.mock("../hooks/useOrchestrateRuns", () => ({
  useOrchestrateRuns: () => ({
    data: null,
    isPending: true,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/utils", () => ({
  deriveStatus: () => "UNKNOWN",
  sortByPassRateAndChecks: (arr: unknown[]) => arr,
}));

describe("Overview", () => {
  it("module exports Overview component", async () => {
    const { Overview } = await import("./Overview");
    expect(Overview).toBeDefined();
    expect(typeof Overview).toBe("function");
  });
});
