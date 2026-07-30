// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectHarnessModel, ProjectSkillOptionModel } from "../../models";
import { SkillSetEditor, SkillSetSkillPicker } from "./SkillSetEditor";

const availableSkills: ProjectSkillOptionModel[] = [
  {
    id: "tdd",
    name: "tdd",
    packagePath: "/skills/tdd",
    contentHash: "abcdef123456",
    lifecycle: "active",
  },
];

const connectedHarnesses: ProjectHarnessModel[] = [
  {
    id: "codex",
    name: "Codex",
    icon: { src: "data:image/svg+xml,Codex", fit: "contain", inset: "sm" },
  },
  {
    id: "pi",
    name: "Pi",
    icon: { src: "data:image/svg+xml,Pi", fit: "contain", inset: "sm" },
  },
];

afterEach(cleanup);

describe("SkillSetEditor draft lifecycle", () => {
  it("preserves typed fields when background inventory refreshes while the modal is open", () => {
    const props = {
      mode: "create" as const,
      open: true,
      initialValue: null,
      draftValue: null,
      captureCandidates: [],
      canCreate: true,
      canCapture: false,
      isPending: false,
      onOpenChange: vi.fn(),
      onModeChange: vi.fn(),
      onSubmit: vi.fn(),
    };
    const { rerender } = render(<SkillSetEditor {...props} availableSkills={availableSkills} />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Software Development" },
    });

    rerender(<SkillSetEditor {...props} availableSkills={[...availableSkills]} />);

    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Software Development");

    rerender(<SkillSetEditor {...props} open={false} availableSkills={availableSkills} />);
    rerender(<SkillSetEditor {...props} availableSkills={availableSkills} />);

    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("");
  });

  it("explains divergent copies with human-readable location context", async () => {
    render(
      <SkillSetSkillPicker
        skills={[
          {
            ...availableSkills[0]!,
            revisionChoices: [
              {
                contentHash: "abcdef123456",
                packagePath: "/skills/tdd",
                sourceKind: "installed",
                connection: "codex",
                scope: "global",
                projectRoot: null,
                active: true,
                modifiedAt: new Date().toISOString(),
                lastUsedAt: null,
                originLabel: null,
              },
              {
                contentHash: "fedcba654321",
                packagePath: "/projects/moscow/.claude/skills/tdd",
                sourceKind: "installed",
                connection: "claude_code",
                scope: "project",
                projectRoot: "/projects/moscow",
                active: true,
                modifiedAt: new Date().toISOString(),
                lastUsedAt: null,
                originLabel: "selftune-dev/tdd",
              },
            ],
          },
        ]}
        selectedPaths={["/skills/tdd"]}
        onValueChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "tdd copy" }).textContent).toContain(
      "Global · Codex",
    );
    fireEvent.click(screen.getByRole("combobox", { name: "tdd copy" }));

    expect(await screen.findByText("Recommended")).toBeTruthy();
    expect(screen.getByText("moscow · Claude Code")).toBeTruthy();
    expect(screen.getByText(/selftune-dev\/tdd/)).toBeTruthy();
  });

  it("offers detected projects inside the creation modal", async () => {
    render(
      <SkillSetEditor
        mode="derive"
        open
        availableSkills={availableSkills}
        initialValue={null}
        draftValue={null}
        captureCandidates={[
          {
            projectRoot: "/projects/mobile-app",
            name: "Mobile App",
            connections: ["codex", "pi"],
            skillCount: 4,
            lastUsedAt: "2026-07-18T10:00:00.000Z",
          },
        ]}
        canCreate
        canCapture
        isPending={false}
        onOpenChange={vi.fn()}
        onModeChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^From Project/ }));
    expect(await screen.findByText("Detected projects")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use Mobile App" }));
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Mobile App");
    expect(screen.getByLabelText<HTMLInputElement>("Another project folder").value).toBe(
      "/projects/mobile-app",
    );
  });

  it("opens a suggested draft on its review step", () => {
    render(
      <SkillSetEditor
        mode="create"
        open
        availableSkills={availableSkills}
        initialValue={null}
        draftValue={{
          name: "Suggested workflow",
          description: "Skills that work well together.",
          connections: ["codex"],
          skills: [
            { name: "tdd", packagePath: "/skills/tdd" },
            { name: "release-check", packagePath: "/skills/release-check" },
          ],
        }}
        captureCandidates={[]}
        connectedHarnesses={connectedHarnesses}
        canCreate
        canCapture
        isPending={false}
        onOpenChange={vi.fn()}
        onModeChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText("Review Suggested Skill Set")).toBeTruthy();
    expect(screen.getByText("Suggested workflow")).toBeTruthy();
    expect(screen.getByText("tdd")).toBeTruthy();
    expect(screen.getByText("release-check")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Pi")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Skill Set" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^From Library/ })).toBeNull();
  });
});
