import { describe, expect, test } from "bun:test";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { DashboardOperations, makeDashboardOperationsLayer } from "../src/dashboard-operations.js";
import { handleDashboardApplicationRoute } from "../src/routes/application.js";

const origin = "http://127.0.0.1:3141";
const revision = "1".repeat(64);
const envelope = "2".repeat(64);

function request(
  runtime: ManagedRuntime.ManagedRuntime<DashboardOperations>,
  path: string,
  body?: unknown,
) {
  const current = new Request(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? { Origin: origin }
        : { Origin: origin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return runtime.runPromise(
    handleDashboardApplicationRoute(current, new URL(current.url), {
      allowedOrigins: new Set([origin]),
    }),
  );
}

describe("assigned Skill Set application routes", () => {
  test("keeps contribution preview separate from explicit confirmed submit and sync", async () => {
    const calls: string[] = [];
    const preview = {
      ready: true as const,
      readiness: {
        status: "ready" as const,
        checkedComponents: 1,
        blockedComponents: 0 as const,
        summary: "Ready",
      },
      previewToken: "preview_01",
      assignmentId: "assignment_01",
      baseReleaseId: "release_01",
      proposedSkillSetRevisionSha256: revision,
      proposedEnvelopeSha256: envelope,
      byteLength: 100,
      sourceChoices: [
        {
          receiptId: "receipt_01",
          agent: "codex" as const,
          skillName: "review",
          selected: true,
        },
      ],
      changes: [
        {
          componentName: "review",
          changeType: "modified" as const,
          packagePaths: ["SKILL.md"],
        },
      ],
    };
    const runtime = ManagedRuntime.make(
      // Test at the local HTTP/operations seam; no Cloud or filesystem dependency.
      makeDashboardOperationsLayer({
        teamContributionPreviewer: (input) => {
          calls.push(`preview:${input.assignmentId}`);
          return preview;
        },
        teamContributionSubmitter: (input) => {
          calls.push(`submit:${input.previewToken}`);
          return { syncStatus: "pending" };
        },
        teamContributionSyncer: () => {
          calls.push("sync");
          return { sent: 1, pending: 0 };
        },
      }),
    );
    try {
      expect(
        await (
          await request(runtime, "/api/v2/skill-sets/contributions/preview", {
            assignment_id: "assignment_01",
            title: "Improve",
            message: "",
            source_receipt_ids: ["receipt_01"],
          })
        ).json(),
      ).toEqual(preview);
      expect(
        (
          await request(runtime, "/api/v2/skill-sets/contributions/submit", {
            preview_token: "preview_01",
            confirm_submit: true,
          })
        ).status,
      ).toBe(200);
      expect((await request(runtime, "/api/v2/skill-sets/contributions/sync", {})).status).toBe(
        200,
      );
      expect(calls).toEqual(["preview:assignment_01", "submit:preview_01", "sync"]);
    } finally {
      await runtime.dispose();
    }
  });

  test("traces list, preview, confirmed install, and Undo through local operations", async () => {
    const calls: Array<{ operation: string; input?: unknown }> = [];
    const list = [
      {
        assignment: {
          assignment_id: "assignment_01",
          request_id: "assignment_request_01",
          release_id: "release_01",
          skill_set_id: "engineering",
          name: "Engineering",
          description: "Pinned workflow",
          publisher_name: "Platform team",
          sequence: 1,
          skill_set_revision_sha256: revision,
          envelope_sha256: envelope,
          byte_length: 100,
          assigned_at: Date.parse("2026-08-31T10:00:00.000Z"),
          update_policy: "ask_before_updating" as const,
          components: [{ name: "review", license_expression: "MIT" }],
          harnesses: ["codex"],
          readiness: {
            status: "ready" as const,
            checked_components: 1,
            blocked_components: 0,
          },
          observed: {
            status: "unknown" as const,
            lifecycle_sequence: null,
            receipt_id: null,
            observed_release_id: null,
            observed_at: null,
            failure_code: null,
          },
        },
        localStatus: "unknown" as const,
        localReceiptId: null,
        receiptPending: false,
        syncStatus: "synced" as const,
        canInstall: true,
        canRollback: false,
      },
    ];
    const preview = {
      ready: true,
      assignmentId: "assignment_01",
      requestId: "assignment_request_01",
      releaseId: "release_01",
      releaseName: "Engineering",
      releaseSequence: 1,
      publisherName: "Platform team",
      skillSetRevisionSha256: revision,
      envelopeSha256: envelope,
      scope: "global" as const,
      skills: [
        {
          name: "review",
          licenseExpression: "MIT",
          revisionSha256: revision,
          packagePaths: ["SKILL.md"],
        },
      ],
      tools: ["codex" as const],
      checks: [
        {
          id: "binding",
          status: "passed" as const,
          title: "Verified",
          detail: "Exact bytes",
        },
      ],
      conflicts: [],
    };
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        assignedSkillSetsLoader: () => {
          calls.push({ operation: "list" });
          return list;
        },
        assignedSkillSetPreviewer: (input) => {
          calls.push({ operation: "preview", input });
          return preview;
        },
        assignedSkillSetInstaller: (input) => {
          calls.push({ operation: "install", input });
          return {
            assignmentId: input.assignmentId,
            requestId: input.requestId,
            releaseId: input.expectedReleaseId,
            receiptId: "rollback_01",
            installedAt: "2026-08-31T10:05:00.000Z",
            status: "current" as const,
            receiptPending: true,
            syncStatus: "pending" as const,
          };
        },
        assignedSkillSetRollback: (input) => {
          calls.push({ operation: "undo", input });
          return {
            assignmentId: input.assignmentId,
            requestId: "assignment_request_01",
            releaseId: "release_01",
            receiptId: input.receiptId,
            rolledBackAt: "2026-08-31T10:06:00.000Z",
            status: "rolled_back" as const,
            receiptPending: false,
            syncStatus: "synced" as const,
          };
        },
      }),
    );
    try {
      expect(await (await request(runtime, "/api/v2/skill-sets/assignments")).json()).toEqual(list);
      expect(
        await (await request(runtime, "/api/v2/skill-sets/assignments/sync", {})).json(),
      ).toEqual(list);
      expect(
        await (
          await request(runtime, "/api/v2/skill-sets/assignments/preview", {
            assignment_id: "assignment_01",
          })
        ).json(),
      ).toEqual(preview);
      expect(
        (
          await request(runtime, "/api/v2/skill-sets/assignments/install", {
            assignment_id: "assignment_01",
            request_id: "assignment_request_01",
            expected_release_id: "release_01",
            expected_skill_set_revision_sha256: revision,
            expected_envelope_sha256: envelope,
            confirm_install: true,
          })
        )?.status,
      ).toBe(200);
      expect(
        (
          await request(runtime, "/api/v2/skill-sets/assignments/undo", {
            assignment_id: "assignment_01",
            receipt_id: "rollback_01",
            confirm_rollback: true,
          })
        )?.status,
      ).toBe(200);
      expect(calls.map(({ operation }) => operation)).toEqual([
        "list",
        "list",
        "preview",
        "install",
        "undo",
      ]);
    } finally {
      await runtime.dispose();
    }
  });
});
