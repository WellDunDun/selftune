import { describe, expect, it, vi } from "vitest";

// Mock heavy external dependencies to avoid import timeouts
vi.mock("lucide-react", () => ({
  AlertCircleIcon: () => null,
  BoltIcon: () => null,
  CheckCircleIcon: () => null,
  ChevronDownIcon: () => null,
  ClockIcon: () => null,
  EyeIcon: () => null,
  LayersIcon: () => null,
  RefreshCwIcon: () => null,
  RocketIcon: () => null,
  SparklesIcon: () => null,
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

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => null,
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
});
