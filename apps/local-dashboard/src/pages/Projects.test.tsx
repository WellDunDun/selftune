import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@selftune/ui/primitives", () => ({
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Checkbox: ({
    checked,
    "aria-label": ariaLabel,
  }: {
    checked?: boolean;
    "aria-label"?: string;
  }) => <input type="checkbox" checked={checked} readOnly aria-label={ariaLabel} />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: () => <input />,
}));

vi.mock("@/components/ui/skeleton", () => ({ Skeleton: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mutation = () => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  data: undefined,
  isPending: false,
});

vi.mock("@/hooks/useSkillSets", () => ({
  useSkillSets: () => ({
    data: {
      sets: [
        {
          schema_version: 1,
          set_id: "research-project",
          name: "Research project",
          description: "Evidence-heavy work",
          harnesses: ["codex"],
          skills: [
            {
              name: "research",
              content_hash: "a".repeat(64),
              library_package_path: "/library/research",
            },
          ],
          created_at: "2026-07-14T00:00:00.000Z",
          updated_at: "2026-07-14T00:00:00.000Z",
        },
      ],
      receipts: [],
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useCreateSkillSet: mutation,
  useDeriveSkillSet: mutation,
  useExportSkillSet: mutation,
  usePreviewSkillSet: mutation,
  useApplySkillSet: mutation,
  useRollbackSkillSet: mutation,
  useUpdateSkillSet: mutation,
}));

vi.mock("@/hooks/useLibrary", () => ({
  useLibrary: () => ({
    data: { skills: [] },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

describe("Projects", () => {
  it("renders Skill Sets as the project distribution surface", async () => {
    const { Projects } = await import("./Projects");
    const html = renderToStaticMarkup(<Projects />);

    expect(html).toContain("Projects");
    expect(html).toContain("Research project");
    expect(html).toContain("Pinned skills");
    expect(html).toContain("Project folder");
  });
});
