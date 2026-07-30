import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardDecisionModel } from "../../models";
import { DurableDecisionCard } from "./DurableDecisionCard";

const common = {
  id: "decision-1",
  status: "pending",
  createdAt: "2026-07-16T10:00:00.000Z",
  updatedAt: "2026-07-16T10:00:00.000Z",
  expiresAt: "2026-07-17T10:00:00.000Z",
  decidedAt: null,
  failure: null,
  audit: [{ event: "prepared", at: "2026-07-16T10:00:00.000Z", reason: null }],
  hasRecoveryReceipt: false,
} as const;

describe("shared durable decision UI", () => {
  it("renders common lifecycle and typed impact presenters for all consumers", () => {
    const decisions: DashboardDecisionModel[] = [
      {
        ...common,
        kind: "source_merge",
        title: "Merge research",
        summary: "Merge",
        skillName: "research",
        source: "example/skills",
        connection: "Codex",
        model: "gpt",
        installedHash: "old",
        latestHash: "new",
        targets: [
          {
            path: "/skills/research",
            conflicts: [],
            summary: "Merged",
            mergedDiff: "@@ -1 +1 @@\n-old\n+new",
          },
        ],
      },
      {
        ...common,
        kind: "skill_removal",
        title: "Remove research",
        summary: "Remove",
        skillName: "research",
        locations: [
          {
            connection: "Codex",
            originalPackagePath: "/skills/research",
            originalSkillPath: "/skills/research/SKILL.md",
            archiveDestination: "/quarantine/research",
            packageVersionHash: "old-package",
            quarantineId: "quarantine-1",
            recovery: "Restore receipt",
          },
        ],
      },
      {
        ...common,
        kind: "skill_set_conflict",
        title: "Replace conflicts",
        summary: "Replace",
        skillSetId: "dev",
        projectRoot: "/project",
        creates: 0,
        unchanged: 0,
        conflicts: 1,
        impacts: [
          {
            connection: "Codex",
            skillName: "research",
            targetPath: "/project/.agents/skills/research",
            replacementSourcePath: "/library/research",
            currentFingerprint: "old-project",
            replacementFingerprint: "new-library",
            backupPath: "/backup/research",
            rollback: "Restore backup",
          },
        ],
        recoveryStatus: null,
      },
      {
        ...common,
        kind: "skill_consolidation",
        title: "Consolidate research",
        summary: "Use one managed revision",
        skillName: "research",
        canonicalContentHash: "new-library",
        canonicalPackagePath: "/library/research",
        targets: [
          {
            action: "replace_with_link",
            connection: "Codex",
            projectRoot: "/project",
            originalPackagePath: "/project/.agents/skills/research",
            originalContentHash: "old-project",
            archiveDestination: "/archive/project-research",
          },
        ],
        recoveryStatus: null,
      },
    ];
    const html = decisions
      .map((decision) => renderToStaticMarkup(<DurableDecisionCard decision={decision} />))
      .join("\n");
    expect(html).toContain("Approve");
    expect(html).toContain("/skills/research");
    expect(html).toContain("Archive: /quarantine/research");
    expect(html).toContain("Replacement: /library/research");
    expect(html).toContain("Backup: /backup/research");
    expect(html).toContain("Canonical: /library/research");
    expect(html).toContain("Archive: /archive/project-research");
    expect(html).toContain("prepared");
    expect(html).toContain("Candidate diff");
    expect(html).toContain("Validation");
  });
});
