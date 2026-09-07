// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LibrarySkillModel } from "../../models";
import { OnDemandSkillsReview } from "./OnDemandSkillsReview";

afterEach(cleanup);

it("handles 125 skills with bounded pages and preserves selections across search", async () => {
  const execute = vi.fn().mockResolvedValue({ succeeded: 2, failed: 0, receipts: [] });
  const skills = Array.from({ length: 125 }, (_, index): LibrarySkillModel => {
    const name = `skill-${String(index).padStart(3, "0")}`;
    return {
      id: name,
      name,
      lifecycle: "active",
      status: "Ready",
      updateStatus: "current",
      sources: [],
      locations: [],
      revisionHashes: ["hash"],
      onDemandSource: {
        skillPath: `/${name}/SKILL.md`,
        packagePath: `/${name}`,
        contentHash: "hash",
      },
      contextEntries: [
        {
          harness: "codex",
          scope: "global",
          projectRoot: null,
          path: `/${name}/SKILL.md`,
          state: "active",
          metadata: {
            name,
            description: index === 124 ? "Write newsletter campaigns" : "Review code changes",
            disableModelInvocation: false,
            originalSkillPath: `/${name}/SKILL.md`,
          },
        },
      ],
    };
  });
  render(
    <OnDemandSkillsReview
      skills={skills}
      introduction={<p>Setup</p>}
      initialOpen
      refresh={vi.fn()}
      actions={{
        moveToLibraryMany: { access: "available", execute },
        restore: { access: "unavailable", reason: "test" },
      }}
    />,
  );
  const table = screen.getByRole("table", { name: "On-demand skill library" });
  expect(within(table).getAllByRole("row")).toHaveLength(21);
  fireEvent.click(screen.getByRole("checkbox", { name: "Keep skill-000 on demand" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.queryByRole("checkbox", { name: "Keep skill-000 on demand" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Search on-demand skills" }), {
    target: { value: "newsletter" },
  });
  expect(within(table).getAllByRole("row")).toHaveLength(2);
  fireEvent.click(screen.getByRole("checkbox", { name: "Keep skill-124 on demand" }));
  expect(screen.getByText("2 skills will load only on request")).toBeTruthy();
  expect(screen.getByText(/2 active installations removed/)).toBeTruthy();
  const impact = within(screen.getByRole("region", { name: "Context savings by harness" }));
  expect(impact.getByText("Now")).toBeTruthy();
  expect(impact.getByText("After")).toBeTruthy();
  expect(impact.getByText("Freed")).toBeTruthy();
  const cells = impact.getAllByRole("row")[1];
  const values = within(cells)
    .getAllByRole("cell")
    .slice(1)
    .map((cell) => Number(cell.textContent?.replace(/[~,]/g, "")));
  expect(values[0] - values[1]).toBe(values[2]);
  expect(values[2]).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Move 2 skills to on-demand" }));
  await waitFor(() =>
    expect(execute).toHaveBeenCalledWith([
      { skillName: "skill-000", skillPath: "/skill-000/SKILL.md", expectedContentHash: "hash" },
      { skillName: "skill-124", skillPath: "/skill-124/SKILL.md", expectedContentHash: "hash" },
    ]),
  );
});
const candidate: LibrarySkillModel = {
  id: "marketing",
  name: "marketing",
  lifecycle: "active",
  status: "Ready",
  updateStatus: "current",
  sources: [],
  locations: [],
  revisionHashes: ["reviewed-revision"],
  instructionBytes: 4000,
  archiveRecommendation: {
    classification: "inactive_candidate",
    reason: "No invocation in 60 days across 25 sessions.",
    skillPath: "/skills/marketing/SKILL.md",
    packagePath: "/skills/marketing",
    contentHash: "reviewed-revision",
  },
};

it("keeps setup, selection and Undo in one modal", async () => {
  const restore = vi.fn().mockResolvedValue(undefined);
  const onDismiss = vi.fn();
  render(
    <OnDemandSkillsReview
      skills={[candidate]}
      introduction={<p>On-demand setup</p>}
      initialOpen
      onDismiss={onDismiss}
      refresh={vi.fn()}
      actions={{
        moveToLibraryMany: {
          access: "available",
          execute: vi.fn().mockResolvedValue({
            succeeded: 1,
            failed: 0,
            receipts: [{ skillName: "marketing", restoreId: "receipt-modal" }],
          }),
        },
        restore: { access: "available", execute: restore },
      }}
    />,
  );
  expect(screen.getByRole("table", { name: "On-demand skill library" })).toBeTruthy();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.click(screen.getByRole("checkbox", { name: /Keep marketing on demand/ }));
  fireEvent.click(screen.getByRole("button", { name: /Move \d+ skills? to on-demand/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith("receipt-modal"));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Done" }).hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onDismiss).toHaveBeenCalledOnce();
});

it("reviews exact selected revisions, shows impact, moves only on confirmation, and undoes receipts", async () => {
  const execute = vi.fn().mockResolvedValue({
    succeeded: 1,
    failed: 0,
    receipts: [{ skillName: "marketing", restoreId: "receipt-1" }],
  });
  const restore = vi.fn().mockResolvedValue(undefined);
  const refresh = vi.fn();
  render(
    <OnDemandSkillsReview
      skills={[
        candidate,
        { ...candidate, id: "recent", name: "recent", archiveRecommendation: null },
      ]}
      actions={{
        moveToLibraryMany: { access: "available", execute },
        restore: { access: "available", execute: restore },
      }}
      refresh={refresh}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Review 1 suggestion" }));
  expect(screen.queryByRole("checkbox", { name: /recent/ })).toBeNull();
  expect(execute).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: /Keep marketing on demand/ }));
  expect(screen.getByText("1 skill will load only on request")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Move \d+ skills? to on-demand/ }));
  await waitFor(() =>
    expect(execute).toHaveBeenCalledWith([
      {
        skillName: "marketing",
        skillPath: "/skills/marketing/SKILL.md",
        expectedContentHash: "reviewed-revision",
      },
    ]),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith("receipt-1"));
  expect(await screen.findByText(/Restored the original installations/)).toBeTruthy();
});

it("keeps failed moves reviewable and reports the actual reason", async () => {
  render(
    <OnDemandSkillsReview
      skills={[candidate]}
      actions={{
        moveToLibraryMany: {
          access: "available",
          execute: vi.fn().mockResolvedValue({
            succeeded: 0,
            failed: 1,
            failures: [{ skillName: "marketing", message: "Skill changed after review" }],
          }),
        },
        restore: { access: "unavailable", reason: "offline" },
      }}
      refresh={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Review 1 suggestion" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Keep marketing on demand/ }));
  fireEvent.click(screen.getByRole("button", { name: /Move \d+ skills? to on-demand/ }));
  expect((await screen.findByRole("alert")).textContent).toContain("Skill changed after review");
  expect(screen.getByRole("dialog")).toBeTruthy();
});

it("allows an explicit choice without claiming an inactivity recommendation", () => {
  const execute = vi.fn();
  render(
    <OnDemandSkillsReview
      skills={[
        {
          ...candidate,
          archiveRecommendation: null,
          onDemandSource: {
            skillPath: "/skills/marketing/SKILL.md",
            packagePath: "/skills/marketing",
            contentHash: "reviewed-revision",
          },
        },
      ]}
      actions={{
        moveToLibraryMany: { access: "available", execute },
        restore: { access: "unavailable", reason: "offline" },
      }}
      refresh={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose skills" }));
  expect(screen.getByRole("checkbox", { name: /Keep marketing on demand/ })).toBeTruthy();
  expect(screen.getByText("No description available")).toBeTruthy();
  expect(execute).not.toHaveBeenCalled();
});

it("moves all identical installations together and restores every receipt", async () => {
  const sources = ["claude", "codex", "pi"].map((harness) => ({
    skillPath: `/${harness}/marketing/SKILL.md`,
    packagePath: `/${harness}/marketing`,
    contentHash: "reviewed-revision",
  }));
  const execute = vi.fn().mockResolvedValue({
    succeeded: 3,
    failed: 0,
    receipts: sources.map((source, index) => ({
      skillName: "marketing",
      restoreId: `receipt-${index}`,
    })),
  });
  const restore = vi.fn().mockResolvedValue(undefined);
  render(
    <OnDemandSkillsReview
      skills={[{ ...candidate, onDemandSources: sources }]}
      actions={{
        moveToLibraryMany: { access: "available", execute },
        restore: { access: "available", execute: restore },
      }}
      refresh={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose skills" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Keep marketing on demand/ }));
  fireEvent.click(screen.getByRole("button", { name: /Move \d+ skills? to on-demand/ }));
  await waitFor(() =>
    expect(execute).toHaveBeenCalledWith(
      sources.map((source) => ({
        skillName: "marketing",
        skillPath: source.skillPath,
        expectedContentHash: source.contentHash,
      })),
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(restore).toHaveBeenCalledTimes(3));
});
