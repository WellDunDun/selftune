import { describe, expect, test } from "bun:test";

import type { RemoteLibraryConfig } from "@selftune/library/remote/config";

import {
  CloudTeamCollaborationError,
  makeCloudTeamCollaborationOperations,
} from "../src/cloud-team-collaboration.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const timestamp = "2026-08-01T08:00:00.000Z";
const snapshot = {
  entries: [
    {
      id: "entry/one",
      name: "Deploy safely",
      rolloutPolicy: "manual",
      currentVersion: "1.0.0",
      pendingContributions: 1,
      installations: 1,
      conflicts: 0,
    },
  ],
  contributions: [
    {
      id: "candidate one",
      entryId: "entry/one",
      entryName: "Deploy safely",
      baseVersionId: "version-base",
      baseVersion: "1.0.0",
      candidateVersion: "1.1.0",
      candidateContentHash: hashB,
      files: [{ path: "SKILL.md", hash: hashB, size: 42 }],
      changes: [
        {
          path: "SKILL.md",
          kind: "modified",
          baseHash: hashA,
          candidateHash: hashB,
        },
      ],
      summary: "Clarify the deployment check.",
      submittedBy: "user-2",
      submittedByName: "Ada",
      status: "pending",
      reviewedBy: null,
      adoptedVersionId: null,
      createdAt: timestamp,
      reviewedAt: null,
    },
  ],
  installations: [
    {
      id: "installation-1",
      entryId: "entry/one",
      entryName: "Deploy safely",
      deviceId: "device-1",
      installedVersion: "1.0.0",
      installedContentHash: hashA,
      latestVersion: "1.0.0",
      latestContentHash: hashA,
      rolloutPolicy: "manual",
      updateStatus: "current",
      lastSyncedAt: timestamp,
      lastConflictAt: null,
      lastReceiptId: null,
    },
  ],
} as const;

const teamStatus = {
  currentUserId: "user-1",
  currentRole: "admin",
  readOnly: false,
  seatUsage: 2,
  seatLimit: 10,
  billingPath: "/settings/billing",
  members: [],
  invitations: [],
} as const;

function remoteConfig(url = "http://127.0.0.1:4399"): RemoteLibraryConfig {
  return {
    version: 2,
    url,
    apiKey: "desktop-device-key",
    credentialProvider: "environment",
    preferences: {
      releasedSkills: true,
      drafts: false,
      skillSets: true,
      metadata: true,
      decisionHistory: true,
    },
  };
}

describe("Cloud team collaboration sidecar transport", () => {
  test("uses the configured remote and stored credential for every canonical endpoint", async () => {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/cloud/team") return Response.json(teamStatus);
      if (path === "/api/v1/collaboration") return Response.json(snapshot);
      if (path.endsWith("/rollout-policy")) {
        return Response.json({ entryId: "entry/one", policy: "automatic" });
      }
      return Response.json({
        id: "candidate one",
        status: path.endsWith("/rollback") ? "rolled_back" : "adopted",
      });
    };
    const collaboration = makeCloudTeamCollaborationOperations("/unused", {
      fetch,
      loadRemoteLibraryConfig: () => remoteConfig(),
    });

    expect(await collaboration.access()).toEqual({ currentRole: "admin", readOnly: false });
    expect(await collaboration.snapshot()).toEqual(snapshot);
    await collaboration.updateRolloutPolicy("entry/one", "automatic");
    await collaboration.decide("candidate one", "adopt");
    await collaboration.decide("candidate one", "reject");
    await collaboration.decide("candidate one", "rollback");

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        "GET /api/v1/cloud/team",
        "GET /api/v1/collaboration",
        "PATCH /api/v1/collaboration/registry/entry%2Fone/rollout-policy",
        "POST /api/v1/collaboration/contributions/candidate%20one/adopt",
        "POST /api/v1/collaboration/contributions/candidate%20one/reject",
        "POST /api/v1/collaboration/contributions/candidate%20one/rollback",
      ],
    );
    expect(
      requests.every(
        (request) => request.headers.get("authorization") === "Bearer desktop-device-key",
      ),
    ).toBe(true);
    expect(
      requests.every((request) => new URL(request.url).origin === "http://127.0.0.1:4399"),
    ).toBe(true);
    expect(await requests[2]?.json()).toEqual({ policy: "automatic" });
  });

  test("rejects malformed success payloads before they reach the renderer", async () => {
    const collaboration = makeCloudTeamCollaborationOperations("/unused", {
      fetch: async () => Response.json({ entries: [], contributions: [], installations: "bad" }),
      loadRemoteLibraryConfig: () => remoteConfig(),
    });

    await expect(collaboration.snapshot()).rejects.toMatchObject({
      _tag: "CloudTeamCollaborationError",
      code: "API_ERROR",
      status: 502,
      retryable: true,
    } satisfies Partial<CloudTeamCollaborationError>);
  });

  test("preserves structured Cloud authorization failures", async () => {
    const collaboration = makeCloudTeamCollaborationOperations("/unused", {
      fetch: async () =>
        Response.json(
          { error: { code: "forbidden", message: "Admins only", retryable: false } },
          { status: 403 },
        ),
      loadRemoteLibraryConfig: () => remoteConfig(),
    });

    await expect(collaboration.decide("candidate", "adopt")).rejects.toMatchObject({
      _tag: "CloudTeamCollaborationError",
      code: "forbidden",
      message: "Admins only",
      status: 403,
      retryable: false,
    } satisfies Partial<CloudTeamCollaborationError>);
  });
});
