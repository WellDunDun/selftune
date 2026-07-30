import { describe, expect, it } from "vitest";

import { CloudSkillDetailSchema, createCloudApiClient, decodeUnknown } from "../index";

const detail = {
  id: "skill-1",
  name: "TDD",
  platform: "codex",
  description: null,
  sources: [
    {
      id: "source-1",
      label: "engineering-skills",
      kind: "github",
      status: "active",
      capabilityStatus: "ready",
      repoFullName: "acme/skills",
      skillPath: "skills/tdd",
      updatedAt: "2026-07-24T10:00:00.000Z",
    },
  ],
  activity: { evalSuites: 2, improvementRuns: 3, pendingProposals: 1 },
};

describe("cloud skill detail contract", () => {
  it("rejects an unrecognized source kind", () => {
    expect(
      decodeUnknown(CloudSkillDetailSchema, {
        ...detail,
        sources: [{ ...detail.sources[0], kind: "gitlab" }],
      }).success,
    ).toBe(false);
  });

  it("gets a detail through the generated client", async () => {
    const requests: Request[] = [];
    const client = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(detail);
      },
    });

    await expect(client.skillDetail("skill-1")).resolves.toEqual(detail);
    expect(requests[0]?.url).toBe("https://cloud.selftune.dev/api/v1/cloud/skills/skill-1");
  });
});
