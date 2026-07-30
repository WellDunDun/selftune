import { describe, expect, it } from "vitest";
import { createCloudApiClient, decodeUnknown, TeamInviteInput } from "../index";

const STATUS = {
  currentUserId: "user-1",
  currentRole: "owner" as const,
  readOnly: false,
  seatUsage: 1,
  seatLimit: 5,
  billingPath: "/settings/billing",
  members: [],
  invitations: [],
};

describe("team contract", () => {
  it("validates an invite email and excludes owner invitations", () => {
    expect(decodeUnknown(TeamInviteInput, { email: "not-an-email", role: "member" }).success).toBe(
      false,
    );
    expect(
      decodeUnknown(TeamInviteInput, { email: "person@example.com", role: "owner" }).success,
    ).toBe(false);
    expect(
      decodeUnknown(TeamInviteInput, { email: "person@example.com", role: "admin" }).success,
    ).toBe(true);
  });

  it("uses only the maintained Team route family", async () => {
    const requests: Request[] = [];
    const client = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(STATUS);
      },
    });

    await client.teamStatus();
    await client.inviteTeamMember({ email: "person@example.com", role: "member" });
    await client.changeTeamMemberRole("user-2", { role: "admin" });
    await client.removeTeamMember("user-2");
    await client.cancelTeamInvitation("invite-1");

    expect(requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
      "GET /api/v1/cloud/team",
      "POST /api/v1/cloud/team/invitations",
      "PATCH /api/v1/cloud/team/members/user-2",
      "DELETE /api/v1/cloud/team/members/user-2",
      "DELETE /api/v1/cloud/team/invitations/invite-1",
    ]);
  });
});
