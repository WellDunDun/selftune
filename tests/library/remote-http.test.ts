import { afterEach, describe, expect, test } from "bun:test";
import { installFetchSpy } from "../helpers/fetch-spy.js";
import { LibraryError } from "@selftune/library/errors";
import {
  listWorkspaceSkillSetPolicies,
  resetWorkspaceSkillSetPolicy,
} from "@selftune/library/remote/policies";
import {
  listWorkspaceMembers,
  getWorkspaceTeamOverview,
  inviteWorkspaceMember,
} from "@selftune/library/remote/workspace";
import {
  createSkillShareGrant,
  listRemoteLibraryShares,
  listSkillSetPacks,
  revokeSkillSetPack,
} from "@selftune/library/remote/sharing";

const config = { url: "https://selftune.example.test", apiKey: "test-token" };
let restoreFetch: (() => void) | undefined;
afterEach(() => restoreFetch?.());

describe("remote collaboration HTTP boundaries", () => {
  test("decodes actual responses and sends authentication and body headers", async () => {
    const calls: Array<{
      url: string;
      method: string;
      contentType: string | null;
      body: BodyInit | null | undefined;
    }> = [];
    restoreFetch = installFetchSpy(async (url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-token");
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        contentType: headers.get("Content-Type"),
        body: init?.body,
      });
      switch (new URL(String(url)).pathname) {
        case "/api/v1/remote-library/policies":
          return Response.json({ current_role: "owner", policies: [] });
        case "/api/v1/remote-library/policies/engineering":
          return Response.json({ success: true });
        case "/api/v1/teams/members":
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return Response.json({
            current_user_id: "owner",
            current_role: "owner",
            members: [],
            invitations: [],
          });
        case "/api/v1/teams/invite":
          return Response.json({
            status: "invited",
            user_id: null,
            email: "person@example.test",
            role: "member",
          });
        case "/api/v1/teams/overview":
          return Response.json({
            current_user_id: "owner",
            current_role: "owner",
            reporting: { privacy: "metadata_only", raw_sessions_uploaded: false },
            members: [],
            skills: [],
          });
        case "/api/v1/remote-library/shares":
          return Response.json({ inbox: [], outbox: [] });
        case "/api/v1/remote-library/packs":
          return Response.json({ packs: [] });
        default:
          throw new Error(`Unexpected request: ${url}`);
      }
    });
    expect((await listWorkspaceSkillSetPolicies(config)).policies).toEqual([]);
    expect(await resetWorkspaceSkillSetPolicy(config, "engineering")).toEqual({ success: true });
    expect((await listWorkspaceMembers(config)).members).toEqual([]);
    expect((await getWorkspaceTeamOverview(config)).reporting.raw_sessions_uploaded).toBe(false);
    expect(
      await inviteWorkspaceMember(config, { email: "person@example.test", role: "member" }),
    ).toMatchObject({ status: "invited" });
    expect(await listRemoteLibraryShares(config)).toEqual({ inbox: [], outbox: [] });
    expect((await listSkillSetPacks(config)).packs).toEqual([]);
    expect(calls.find((call) => call.method === "POST")).toMatchObject({
      contentType: "application/json",
      body: JSON.stringify({ email: "person@example.test", role: "member" }),
    });
    expect(
      calls.filter((call) => call.method === "GET").every((call) => call.contentType === null),
    ).toBe(true);
  });

  for (const read of [
    listWorkspaceSkillSetPolicies,
    listWorkspaceMembers,
    getWorkspaceTeamOverview,
    listRemoteLibraryShares,
    listSkillSetPacks,
  ]) {
    test(`${read.name} rejects incomplete successful payloads`, async () => {
      for (const text of ["null", "{}", "{broken", '{"private":"do-not-echo"}']) {
        restoreFetch = installFetchSpy(async () => new Response(text));
        try {
          await read(config);
          throw new Error("Expected rejection");
        } catch (error) {
          expect(error).toBeInstanceOf(LibraryError);
          if (!(error instanceof LibraryError)) throw error;
          expect(error.code).toBe("OPERATION_FAILED");
          expect(error.message).not.toContain("do-not-echo");
        } finally {
          restoreFetch();
        }
      }
    });
  }

  test("preserves policy authorization and retryable service errors", async () => {
    for (const status of [401, 403, 500]) {
      restoreFetch = installFetchSpy(async () =>
        Response.json({ error: { message: "Unavailable" } }, { status }),
      );
      try {
        await listWorkspaceSkillSetPolicies(config);
        throw new Error("Expected rejection");
      } catch (error) {
        if (!(error instanceof LibraryError)) throw error;
        expect(error.message).toBe("Unavailable");
        expect(error.code).toBe(status === 500 ? "OPERATION_FAILED" : "GUARD_BLOCKED");
        expect(error.retryable).toBe(status === 500);
      } finally {
        restoreFetch();
      }
    }
  });

  test("maps pack receipts, validates skill receipts, and accepts empty successful revocation", async () => {
    restoreFetch = installFetchSpy(async (url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (String(url).endsWith("/skill-set-packs"))
        return Response.json({
          packId: "pack",
          packUrl: "https://example.test/p/token",
          expiresAt: "2026-10-01",
        });
      return Response.json({ shareId: 42 });
    });
    expect(
      await createSkillShareGrant(config, {
        skillSetId: "set",
        mode: "private_single_claim",
        delivery: "copy_link",
      }),
    ).toEqual({
      shareId: "pack",
      mode: "private_single_claim",
      delivery: "copy_link",
      shareUrl: "https://example.test/p/token",
      expiresAt: "2026-10-01",
    });
    await expect(
      createSkillShareGrant(config, {
        skillId: "skill",
        snapshotId: "snapshot",
        artifactId: "artifact",
        mode: "private_single_claim",
        delivery: "copy_link",
      }),
    ).rejects.toThrow("invalid response");
    await expect(revokeSkillSetPack(config, "pack")).resolves.toBeUndefined();
  });
});
