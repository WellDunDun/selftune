// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LibrarySkillModel } from "../../models";
import {
  estimateInstructionTokens,
  OnDemandSkillsPanel,
  ON_DEMAND_SKILL_PROMPT,
  ON_DEMAND_SETUP_KEY,
} from "./OnDemandSkillsPanel";

function skill(overrides: Partial<LibrarySkillModel>): LibrarySkillModel {
  return {
    id: "skill",
    name: "skill",
    lifecycle: "library",
    status: "Stored",
    updateStatus: "untracked",
    sources: [],
    locations: [],
    revisionHashes: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OnDemandSkillsPanel", () => {
  it("shows setup once, keeps the page clear after dismissal, and can reopen", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    });
    const view = render(<OnDemandSkillsPanel skills={[]} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(values.get(ON_DEMAND_SETUP_KEY)).toBe("true");
    view.unmount();
    render(<OnDemandSkillsPanel skills={[]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("region", { name: "Context savings by harness" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use on demand" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });

  it("uses the shared harness asset in context savings", () => {
    render(
      <OnDemandSkillsPanel
        skills={[
          skill({
            locations: [
              {
                id: "codex",
                label: "Global",
                path: "/skills/demo",
                removable: true,
                connection: "Codex",
                connectionIcon: {
                  src: "/harness/codex.svg",
                  fit: "contain",
                  inset: "sm",
                  invert_in_dark: true,
                },
              },
            ],
            contextEntries: [
              {
                harness: "codex",
                scope: "global",
                projectRoot: null,
                path: "/skills/demo/SKILL.md",
                state: "active",
                metadata: {
                  name: "demo",
                  description: "Demo",
                  disableModelInvocation: false,
                  originalSkillPath: "/skills/demo/SKILL.md",
                },
              },
            ],
          }),
        ]}
      />,
    );
    expect(screen.getByTitle("Codex").getAttribute("src")).toBe("/harness/codex.svg");
    expect(screen.getByTitle("Codex").className).toContain("dark:invert");
  });
  it("does not present full instruction bytes as context savings", () => {
    render(
      <OnDemandSkillsPanel
        skills={[
          skill({ id: "one", instructionBytes: 4_000 }),
          skill({ id: "two", lifecycle: "draft", instructionBytes: 2_000 }),
          skill({ id: "active", lifecycle: "active", instructionBytes: 8_000 }),
          skill({ id: "archived", lifecycle: "archived", instructionBytes: 8_000 }),
        ]}
      />,
    );

    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.queryByText("~1.5K")).toBeNull();
    expect(screen.getByRole("region", { name: "Context savings by harness" })).toBeTruthy();
    expect(screen.getByText(/four bytes per token/i)).toBeTruthy();
  });

  it("copies the agent-operated activation request", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<OnDemandSkillsPanel skills={[]} />);
    fireEvent.click(screen.getByText("How to ask your agent"));

    fireEvent.click(screen.getByRole("button", { name: /copy example request/i }));
    expect(writeText).toHaveBeenCalledWith(ON_DEMAND_SKILL_PROMPT);
  });

  it("offers a manual fallback when clipboard access is denied", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(<OnDemandSkillsPanel skills={[]} />);
    fireEvent.click(screen.getByText("How to ask your agent"));

    fireEvent.click(screen.getByRole("button", { name: /copy example request/i }));

    expect((await screen.findByRole("status")).textContent).toMatch(/select the request text/i);
  });
});

describe("estimateInstructionTokens", () => {
  it("uses a conservative deterministic four-byte estimate", () => {
    expect(estimateInstructionTokens(0)).toBe(0);
    expect(estimateInstructionTokens(5)).toBe(2);
  });
});
