import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { DashboardOperations, makeDashboardOperationsLayer } from "../src/dashboard-operations.js";
import { handleDashboardApplicationRoute } from "../src/routes/application.js";

const origin = "http://127.0.0.1:3141";

describe("library transfer routes", () => {
  test("shares the exact immutable backup artifact for a catalog skill ID", async () => {
    const shareInputs: unknown[] = [];
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        remoteLibrarySkillBackup: (skillId) => ({
          snapshot: {
            snapshotId: "snapshot-1",
            parentSnapshotId: null,
            createdAt: "2026-07-30T00:00:00.000Z",
            artifacts: [
              {
                artifactId: "backup-skill/Another Skill/revision-other",
                artifactType: "skill_revision",
                objectHash: "object-other",
                revisionHash: "revision-other",
                updatedAt: "2026-07-30T00:00:00.000Z",
              },
              {
                artifactId: "backup-skill/Code Reviewer/revision-1",
                artifactType: "skill_revision",
                objectHash: "object-1",
                revisionHash: "revision-1",
                updatedAt: "2026-07-30T00:00:00.000Z",
              },
            ],
          },
          uploaded: 1,
          unchanged: 0,
          syncedArtifacts: [
            {
              artifactId: "backup-skill/Code Reviewer/revision-1",
              artifactType: "skill_revision",
              objectHash: "object-1",
              revisionHash: "revision-1",
              updatedAt: "2026-07-30T00:00:00.000Z",
            },
          ],
          subject: {
            skillId,
            snapshotId: "snapshot-1",
            artifactId: "backup-skill/Code Reviewer/revision-1",
          },
        }),
        remoteLibraryShareAction: (_action, input) => {
          shareInputs.push(input);
          return {
            shareId: "share-1",
            mode: "reusable_unlisted",
            delivery: "copy_link",
            shareUrl: "https://cloud.selftune.dev/share/share-1",
            expiresAt: "2026-08-06T00:00:00.000Z",
          };
        },
      }),
    );
    const request = new Request(`${origin}/api/v2/library/share`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        skill_id: "code reviewer",
        mode: "reusable_unlisted",
        delivery: "copy_link",
      }),
    });

    try {
      const response = await runtime.runPromise(
        Effect.gen(function* () {
          yield* DashboardOperations;
          return yield* handleDashboardApplicationRoute(request, new URL(request.url), {
            allowedOrigins: new Set([origin]),
          });
        }),
      );

      expect(response?.status).toBe(200);
      expect(shareInputs).toEqual([
        {
          skillId: "code reviewer",
          snapshotId: "snapshot-1",
          artifactId: "backup-skill/Code Reviewer/revision-1",
          mode: "reusable_unlisted",
          delivery: "copy_link",
        },
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  test("rejects mismatched and partial backup references before sharing", async () => {
    let shareCalls = 0;
    const cases = [
      {
        label: "mismatched",
        skillId: "mismatched request",
        subject: {
          skillId: "another skill",
          snapshotId: "snapshot-1",
          artifactId: "backup-skill/Code Reviewer/revision-1",
        },
        snapshot: {
          snapshotId: "snapshot-1",
          artifacts: [
            {
              artifactId: "backup-skill/Code Reviewer/revision-1",
              artifactType: "skill_revision",
            },
          ],
        },
      },
      {
        label: "partial",
        skillId: "partial request",
        subject: {
          skillId: "partial request",
          snapshotId: "snapshot-1",
        },
        snapshot: {
          snapshotId: "snapshot-1",
          artifacts: [
            {
              artifactId: "backup-skill/Code Reviewer/revision-1",
              artifactType: "skill_revision",
            },
          ],
        },
      },
    ];
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        remoteLibrarySkillBackup: (skillId) =>
          cases.find((candidate) => candidate.skillId === skillId),
        remoteLibraryShareAction: () => {
          shareCalls += 1;
          return { shareId: "unexpected" };
        },
      }),
    );

    try {
      const results = await Promise.all(
        cases.map(async ({ label, skillId }) => {
          const request = new Request(`${origin}/api/v2/library/share`, {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify({
              skill_id: skillId,
              mode: "reusable_unlisted",
              delivery: "copy_link",
            }),
          });
          const response = await runtime.runPromise(
            Effect.gen(function* () {
              yield* DashboardOperations;
              return yield* handleDashboardApplicationRoute(request, new URL(request.url), {
                allowedOrigins: new Set([origin]),
              });
            }),
          );
          return { label, response, payload: await response?.json() };
        }),
      );
      for (const { label, response, payload } of results) {
        expect(response?.status, label).toBe(400);
        expect(payload, label).toMatchObject({
          error: { code: "MISSING_FLAG" },
        });
      }
      expect(shareCalls).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  test("rejects email and private-claim issuance before invoking the remote", async () => {
    let calls = 0;
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        remoteLibraryShareAction: () => {
          calls += 1;
          return { shareId: "unexpected" };
        },
      }),
    );
    const unsupported = [
      {
        path: "/api/v2/library/share",
        body: {
          skill_id: "research",
          mode: "private_single_claim",
          delivery: "email",
          recipient_email: "recipient@example.test",
        },
      },
      {
        path: "/api/v2/library/share",
        body: {
          skill_id: "research",
          mode: "private_single_claim",
          delivery: "copy_link",
        },
      },
      {
        path: "/api/v2/skill-sets/share",
        body: {
          set_id: "research-set",
          mode: "private_single_claim",
          delivery: "email",
          recipient_email: "recipient@example.test",
        },
      },
      {
        path: "/api/v2/skill-sets/share",
        body: {
          set_id: "research-set",
          mode: "private_single_claim",
          delivery: "copy_link",
        },
      },
    ];

    try {
      const results = await Promise.all(
        unsupported.map(async ({ path, body }) => {
          const request = new Request(`${origin}${path}`, {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const response = await runtime.runPromise(
            Effect.gen(function* () {
              yield* DashboardOperations;
              return yield* handleDashboardApplicationRoute(request, new URL(request.url), {
                allowedOrigins: new Set([origin]),
              });
            }),
          );
          return { response, payload: await response?.json() };
        }),
      );
      for (const { response, payload } of results) {
        expect(response?.status).toBe(400);
        expect(payload).toMatchObject({
          error: { code: "MISSING_FLAG" },
        });
      }
      expect(calls).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });
});
