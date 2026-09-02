// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { localDashboardModules } from "./dashboard-host";

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("Desktop assigned Skill Sets contribution", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps canonical assignment identity and keeps a missing receipt Unknown", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
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
              skill_set_revision_sha256: "1".repeat(64),
              envelope_sha256: "2".repeat(64),
              byte_length: 100,
              assigned_at: Date.parse("2026-08-31T10:00:00.000Z"),
              update_policy: "ask_before_updating",
              components: [{ name: "review", license_expression: "MIT" }],
              harnesses: ["codex"],
              readiness: {
                status: "ready",
                checked_components: 1,
                blocked_components: 0,
              },
              observed: {
                status: "unknown",
                lifecycle_sequence: null,
                receipt_id: null,
                observed_release_id: null,
                observed_at: null,
                failure_code: null,
              },
            },
            localStatus: "unknown",
            localReceiptId: null,
            receiptPending: false,
            syncStatus: "synced",
            canInstall: true,
            canRollback: false,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const contribution = localDashboardModules.skillSets.assignments;
    if (!contribution || contribution.access !== "available")
      throw new Error("Assignments unavailable");
    const { result } = renderHook(() => contribution.useAssignments(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.[0]).toMatchObject({
      assignmentId: "assignment_01",
      requestId: "assignment_request_01",
      publisherName: "Platform team",
      status: "unknown",
      receiptId: null,
      syncStatus: "synced",
      canInstall: true,
    });
  });
});
