import { describe, expect, it } from "vitest";

import { CloudGithubStatus, createCloudApiClient, decodeUnknown } from "../index";

describe("cloud GitHub contract", () => {
  it("validates a tenant-scoped status projection", () => {
    expect(
      decodeUnknown(CloudGithubStatus, {
        installations: [],
        connections: [],
        canManageConnections: true,
      }).success,
    ).toBe(true);
  });

  it("uses only the maintained cloud GitHub paths", async () => {
    const requests: Request[] = [];
    const client = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        if (new Request(input, init).url.includes("/sync"))
          return Response.json({
            connectionId: "connection-1",
            status: "published",
            version: "v1",
            sourceRef: "main",
            publishedAt: "2026-07-24T00:00:00.000Z",
            message: "Synced",
          });
        if (new Request(input, init).url.includes("/install/start"))
          return Response.json({
            url: "https://github.com/apps/selftune/installations/new?state=signed",
          });
        return Response.json({ installations: [], connections: [], canManageConnections: true });
      },
    });
    await client.githubStatus();
    await client.startGithubInstall();
    await client.syncGithubConnection("connection-1");
    expect(requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
      "GET /api/v1/cloud/github",
      "POST /api/v1/cloud/github/install/start",
      "POST /api/v1/cloud/github/connections/connection-1/sync",
    ]);
  });
});
