// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DashboardSkillConsolidationDecisionModel } from "../../models";
import { DurableDecisionCard } from "./DurableDecisionCard";

afterEach(cleanup);

const consolidation: DashboardSkillConsolidationDecisionModel = {
  id: "consolidation-research",
  kind: "skill_consolidation",
  status: "approved",
  title: "Consolidate research",
  summary: "Use one managed revision",
  createdAt: "2026-07-23T10:00:00.000Z",
  updatedAt: "2026-07-23T10:01:00.000Z",
  expiresAt: "2026-07-24T10:00:00.000Z",
  decidedAt: "2026-07-23T10:01:00.000Z",
  failure: null,
  audit: [],
  hasRecoveryReceipt: true,
  skillName: "research",
  canonicalContentHash: "canonical-revision",
  canonicalPackagePath: "/library/research",
  targets: [
    {
      action: "replace_with_link",
      connection: "Codex",
      projectRoot: "/project",
      originalPackagePath: "/project/.agents/skills/research",
      originalContentHash: "project-revision",
      archiveDestination: "/archive/project-research",
    },
  ],
  recoveryStatus: "applied",
};

describe("durable consolidation undo", () => {
  it("uses a contextual label and requires confirmation before restoring the receipt", () => {
    const rollback = vi.fn();
    render(<DurableDecisionCard decision={consolidation} onRollback={rollback} />);

    fireEvent.click(screen.getByRole("button", { name: "Undo consolidation" }));

    expect(screen.getByText("Undo research consolidation?")).toBeTruthy();
    expect(
      screen.getByText(
        "This removes 1 managed project link and restores 1 archived original copy from the recovery receipt.",
      ),
    ).toBeTruthy();
    expect(rollback).not.toHaveBeenCalled();

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Undo consolidation" }),
    );
    expect(rollback).toHaveBeenCalledTimes(1);
  });
});
