import { describe, expect, it } from "vitest";

import { createCloudApiClient } from "../index";

const proposal = {
  id: "proposal-1",
  skillId: "skill-1",
  skillName: "TDD",
  proposalType: "structure",
  currentValue: "old",
  proposedValue: "new",
  rationale: null,
  passRateBefore: null,
  projectedPassRate: null,
  status: "pending",
  createdAt: "2026-07-24T10:00:00.000Z",
  reviewedAt: null,
  appliedAt: null,
  runId: null,
  candidateId: null,
  applyTarget: null,
  diffText: null,
};

describe("Cloud improve contract client", () => {
  it("uses the maintained Cloud proposal paths and decodes review responses", async () => {
    const requests: Request[] = [];
    const client = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(proposal);
      },
    });
    await expect(
      client.reviewProposal("proposal-1", { status: "approved" }),
    ).resolves.toMatchObject({ id: "proposal-1", status: "pending" });
    expect(requests[0]?.url).toBe("https://cloud.selftune.dev/api/v1/cloud/proposals/proposal-1");
    expect(requests[0]?.method).toBe("PATCH");
  });

  it("keeps run-to-proposal correlation in the typed query", async () => {
    const requests: Request[] = [];
    const client = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ proposals: [], total: 0 });
      },
    });

    await client.proposals({ runId: "run / 1" });

    expect(requests[0]?.url).toBe(
      "https://cloud.selftune.dev/api/v1/cloud/proposals?runId=run+%2F+1",
    );
  });
});
