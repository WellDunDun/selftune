import { describe, expect, it } from "vitest";

import type { DurableDashboardDecision } from "./types";
import { mapDurableDecision } from "./dashboard-host";

describe("local durable consolidation decision mapping", () => {
  it("preserves canonical, archive, link, and rollback evidence", () => {
    const decision: DurableDashboardDecision = {
      schema_version: 1,
      approval_id: "approval-1",
      requested_action: "consolidate_skill_installations",
      status: "approved",
      skill_name: "research",
      canonical: {
        source_package_path: "/skills/research",
        source_skill_path: "/skills/research/SKILL.md",
        content_hash: "current-hash",
        library_package_path: "/selftune/library/research/current-hash",
      },
      targets: [
        {
          action: "replace_with_link",
          harness: "codex",
          project_root: "/projects/example",
          original_package_path: "/projects/example/.agents/skills/research",
          original_skill_path: "/projects/example/.agents/skills/research/SKILL.md",
          original_content_hash: "old-hash",
          archive_destination: "/selftune/quarantine/project-research",
          quarantine_id: "quarantine-1",
        },
      ],
      created_at: "2026-07-22T10:00:00.000Z",
      updated_at: "2026-07-22T10:01:00.000Z",
      expires_at: "2026-07-22T11:00:00.000Z",
      decided_at: "2026-07-22T10:01:00.000Z",
      receipt: {
        receipt_id: "receipt-1",
        status: "applied",
        quarantine_ids: ["quarantine-1"],
        linked_paths: ["/projects/example/.agents/skills/research"],
        applied_at: "2026-07-22T10:01:00.000Z",
        rolled_back_at: null,
        rollback_behavior: "Remove links and restore archived copies.",
      },
      failure: null,
      audit: [{ event: "approved", at: "2026-07-22T10:01:00.000Z", reason: null }],
    };

    expect(mapDurableDecision(decision)).toMatchObject({
      kind: "skill_consolidation",
      canonicalContentHash: "current-hash",
      canonicalPackagePath: "/selftune/library/research/current-hash",
      recoveryStatus: "applied",
      targets: [
        {
          action: "replace_with_link",
          projectRoot: "/projects/example",
          originalContentHash: "old-hash",
          archiveDestination: "/selftune/quarantine/project-research",
        },
      ],
    });
  });
});
