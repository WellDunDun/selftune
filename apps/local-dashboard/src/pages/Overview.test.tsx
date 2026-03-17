import { describe, expect, it, vi } from "vitest";

// Mock heavy external dependencies to avoid import timeouts
vi.mock("@selftune/ui/components", () => ({
  ActivityPanel: () => null,
  OrchestrateRunsPanel: () => null,
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
}));

vi.mock("lucide-react", () => ({
  AlertCircleIcon: () => null,
  RefreshCwIcon: () => null,
  RocketIcon: () => null,
  LayersIcon: () => null,
  ActivityIcon: () => null,
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
