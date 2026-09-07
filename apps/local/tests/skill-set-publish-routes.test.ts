import { describe, expect, test } from "bun:test";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { Json } from "effect/Schema";

import { DashboardOperations, makeDashboardOperationsLayer } from "../src/dashboard-operations.js";
import { handleDashboardApplicationRoute } from "../src/routes/application.js";

const origin = "http://127.0.0.1:3141";
const revisionSha256 = "1".repeat(64);
const envelopeSha256 = "2".repeat(64);
const dependencyResolution = {
  roots: ["review"],
  available_packages: [
    {
      package_id: "review",
      version: "1.0.0",
      revision_sha256: revisionSha256,
      dependencies: { requires: [], optional: [], conflicts: [] },
      compatibility: { harnesses: ["codex"], required_capabilities: [] },
      provides: [],
    },
  ],
  environment: { harness: "codex", capabilities: [] },
  current_lock: [],
} as const;
const dependencyLock = {
  entries: [
    {
      package_id: "review",
      version: "1.0.0",
      revision_sha256: revisionSha256,
      dependency_kind: "root" as const,
    },
  ],
};

function routeRequest(
  runtime: ManagedRuntime.ManagedRuntime<DashboardOperations, never>,
  path: string,
  body: Json,
) {
  const request = new Request(`${origin}${path}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return runtime.runPromise(
    handleDashboardApplicationRoute(request, new URL(request.url), {
      allowedOrigins: new Set([origin]),
    }),
  );
}

describe("Skill Set publish application routes", () => {
  test("traces preview and confirmed publish through the Desktop host operations", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const preview = {
      skillSetId: "engineering",
      name: "Engineering",
      description: "Pinned engineering workflow",
      harnesses: ["codex"],
      skillSetRevisionSha256: revisionSha256,
      envelopeSha256,
      byteLength: 1_024,
      dependencyInput: dependencyResolution,
      contents: [{ name: "review", revisionSha256, license: "MIT" }],
      dependencies: {
        lock: dependencyLock,
        impact: { added: ["review@1.0.0"], changed: [], removed: [], unchanged: [] },
      },
      checks: [
        {
          id: "portable_envelope" as const,
          status: "passed" as const,
          title: "Portable release is valid",
          detail: "SelfTune can verify this exact release before installation.",
        },
      ],
      confirmation: {
        required: true as const,
        title: "Publish Engineering to your team?",
        detail: "This uploads only the reviewed portable release shown above.",
      },
    };
    const release = {
      release_id: "release_123",
      skill_set_id: "engineering",
      sequence: 1,
      skill_set_revision_sha256: revisionSha256,
      envelope_sha256: envelopeSha256,
      published_at: Date.parse("2026-08-31T10:00:00.000Z"),
      idempotent: false,
    };
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        skillSetPublishPreviewer: (setId, dependencies) => {
          calls.push({ operation: "preview", input: { setId, dependencies } });
          return preview;
        },
        skillSetPublisher: (input) => {
          calls.push({ operation: "publish", input });
          return release;
        },
      }),
    );

    try {
      const previewResponse = await routeRequest(runtime, "/api/v2/skill-sets/publish/preview", {
        set_id: "engineering",
        dependency_resolution: dependencyResolution,
      });
      const publishResponse = await routeRequest(runtime, "/api/v2/skill-sets/publish", {
        set_id: "engineering",
        expected_skill_set_revision_sha256: revisionSha256,
        expected_envelope_sha256: envelopeSha256,
        dependency_resolution: dependencyResolution,
        expected_dependency_lock: dependencyLock,
        confirm_publish: true,
      });

      expect(previewResponse?.status).toBe(200);
      expect(await previewResponse?.json()).toEqual(preview);
      expect(publishResponse?.status).toBe(200);
      expect(await publishResponse?.json()).toEqual(release);
      expect(calls).toEqual([
        {
          operation: "preview",
          input: { setId: "engineering", dependencies: dependencyResolution },
        },
        {
          operation: "publish",
          input: {
            setId: "engineering",
            expectedSkillSetRevisionSha256: revisionSha256,
            expectedEnvelopeSha256: envelopeSha256,
            dependencyResolution,
            expectedDependencyLock: dependencyLock,
            confirmPublish: true,
          },
        },
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  test("rejects a publish request without explicit confirmation before invoking the host", async () => {
    let called = false;
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        skillSetPublisher: () => {
          called = true;
          throw new Error("should not run");
        },
      }),
    );

    try {
      const response = await routeRequest(runtime, "/api/v2/skill-sets/publish", {
        set_id: "engineering",
        expected_skill_set_revision_sha256: revisionSha256,
        expected_envelope_sha256: envelopeSha256,
        dependency_resolution: dependencyResolution,
        expected_dependency_lock: dependencyLock,
        confirm_publish: false,
      });

      expect(response?.status).toBe(400);
      expect(called).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
});
