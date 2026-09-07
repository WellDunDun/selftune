import { describe, expect, test } from "bun:test";

import type {
  HostedSkillSetAssignment,
  HostedSkillSetInstallationReceiptRequest,
  LibrarySnapshot,
} from "@selftune/control-plane";

import { makeHostedStateOperations } from "../src/hosted-state.js";
import { defaultSyncPreferences } from "@selftune/control-plane";
import type { RemoteLibraryConfig } from "@selftune/library/remote/config";

const revision = "1".repeat(64);
const envelope = "2".repeat(64);
const connection: RemoteLibraryConfig = {
  version: 2,
  url: "https://cloud.selftune.dev",
  apiKey: "device_token",
  credentialProvider: "file",
  preferences: defaultSyncPreferences,
};

const assignment: HostedSkillSetAssignment = {
  assignment_id: "assignment_01",
  request_id: "assignment_request_01",
  release_id: "release_01",
  skill_set_id: "engineering",
  name: "Engineering",
  description: "Pinned engineering workflow",
  publisher_name: "Platform team",
  sequence: 1,
  skill_set_revision_sha256: revision,
  envelope_sha256: envelope,
  byte_length: 14,
  assigned_at: Date.parse("2026-08-31T10:00:00.000Z"),
  update_policy: "ask_before_updating",
  components: [{ name: "review", license_expression: "MIT" }],
  harnesses: ["codex"],
  readiness: { status: "ready", checked_components: 1, blocked_components: 0 },
  observed: {
    status: "unknown",
    lifecycle_sequence: null,
    receipt_id: null,
    observed_release_id: null,
    observed_at: null,
    failure_code: null,
  },
};

const library: LibrarySnapshot = {
  skills: [],
  counts: { total: 0, active: 0, library: 0, draft: 0, archived: 0 },
  generatedAt: "2026-08-31T10:00:00.000Z",
};

describe("Desktop hosted Skill Set assignments adapter", () => {
  test("publishes only the bounded revalidation lifecycle contract", async () => {
    const bodies: unknown[] = [];
    const request = {
      request_id: "revalidation_01",
      assignment_id: assignment.assignment_id,
      release_id: assignment.release_id,
      lifecycle_sequence: 10,
      status: "needs_review" as const,
      observed_at: 10,
    };
    const operations = makeHostedStateOperations("/config", () => library, {
      loadConfig: () => connection,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          summary_id: "summary_01",
          ...request,
          recorded_at: 11,
          idempotent: false,
        });
      },
    });

    const receipt = await operations.publishRevalidationSummary(request);

    expect(bodies).toEqual([request]);
    expect(JSON.stringify(bodies)).not.toContain("model");
    expect(JSON.stringify(bodies)).not.toContain("evidence");
    expect(receipt.summary_id).toBe("summary_01");
  });

  test("uses the linked-device list and package wire contracts", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const packageBytes = new TextEncoder().encode("package bytes!");
    const operations = makeHostedStateOperations("/config", () => library, {
      loadConfig: () => connection,
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/api/v1/desktop/assignments/list")) {
          return Response.json({ assignments: [assignment] });
        }
        return new Response(packageBytes, {
          headers: {
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
            "content-length": String(packageBytes.byteLength),
            "x-selftune-assignment-id": assignment.assignment_id,
            "x-selftune-release-id": assignment.release_id,
            "x-selftune-envelope-sha256": assignment.envelope_sha256,
            "x-selftune-byte-length": String(packageBytes.byteLength),
          },
        });
      },
    });

    const listed = await operations.listSkillSetAssignments({ limit: 25 });
    const downloaded = await operations.downloadSkillSetAssignmentPackage(assignment.assignment_id);

    expect(listed.assignments).toEqual([assignment]);
    expect(downloaded).toEqual({
      bytes: packageBytes,
      metadata: {
        assignment_id: assignment.assignment_id,
        release_id: assignment.release_id,
        envelope_sha256: assignment.envelope_sha256,
        byte_length: packageBytes.byteLength,
      },
    });
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/v1/desktop/assignments/list",
      "/api/v1/desktop/assignments/package",
    ]);
    expect(requests.map(({ init }) => JSON.parse(String(init?.body)))).toEqual([
      { limit: 25 },
      { assignment_id: assignment.assignment_id },
    ]);
    expect(
      requests.every(
        ({ init }) => init?.headers && JSON.stringify(init.headers).includes("device_token"),
      ),
    ).toBe(true);
  });

  test("submits only the canonical privacy-safe installation receipt", async () => {
    const bodies: unknown[] = [];
    const receipt: HostedSkillSetInstallationReceiptRequest = {
      request_id: "receipt_request_01",
      assignment_id: assignment.assignment_id,
      release_id: assignment.release_id,
      lifecycle_sequence: 1,
      result: "current",
      coarse_scope: "global",
      target_agents: ["codex"],
      changed_skill_count: 1,
      blocked_skill_count: 0,
      occurred_at: Date.parse("2026-08-31T10:05:00.000Z"),
      rollback_pointer: "rollback_01",
      failure_code: null,
    };
    const operations = makeHostedStateOperations("/config", () => library, {
      loadConfig: () => connection,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          receipt_id: "hosted_receipt_01",
          assignment_id: assignment.assignment_id,
          release_id: assignment.release_id,
          lifecycle_sequence: receipt.lifecycle_sequence,
          status: "current",
          recorded_at: receipt.occurred_at,
          idempotent: false,
        });
      },
    });

    const result = await operations.submitSkillSetInstallationReceipt(receipt);

    expect(bodies).toEqual([receipt]);
    expect(JSON.stringify(bodies[0])).not.toContain("path");
    expect(result.receipt_id).toBe("hosted_receipt_01");
  });
});
