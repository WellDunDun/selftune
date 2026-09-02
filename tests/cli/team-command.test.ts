import { describe, expect, test } from "bun:test";

import { runTeamCommand, type TeamCommandDependencies } from "../../apps/cli/src/commands/team";

function fixture(responses: Response[] = []) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const dependencies: TeamCommandDependencies = {
    env: { SELFTUNE_CLOUD_URL: "https://cloud.example", SELFTUNE_SERVICE_TOKEN: "stsvc_secret" },
    stdin: async () => "",
    fetch: Object.assign(
      async (url: URL | RequestInfo, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return responses.shift() ?? Response.json({ error: "not_found" }, { status: 404 });
      },
      { preconnect() {} },
    ),
    readFile: async () => new Uint8Array([1, 2, 3]),
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  };
  return { dependencies, stdout, stderr, calls };
}

describe("team command", () => {
  test("requires --yes before authoritative mutations and never sends a token argument", async () => {
    const f = fixture();
    expect(
      await runTeamCommand(["promote", "--release-id", "release-1", "--json"], f.dependencies),
    ).toBe(2);
    expect(f.calls).toHaveLength(0);
    expect(f.stderr.join(" ")).toContain("--yes");
    expect(
      await runTeamCommand(
        ["status", "--release-id", "release-1", "--token", "secret"],
        f.dependencies,
      ),
    ).toBe(2);
    expect(f.stderr.join(" ")).not.toContain("secret");
  });

  test("uses the scoped token only in authorization and emits stable JSON", async () => {
    const f = fixture([Response.json({ release_id: "release-1", lifecycle: "promoted" })]);
    expect(
      await runTeamCommand(["status", "--release-id", "release-1", "--json"], f.dependencies),
    ).toBe(0);
    expect(f.stdout).toEqual(['{"release_id":"release-1","lifecycle":"promoted"}']);
    expect(f.calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer stsvc_secret" });
    expect(JSON.stringify(f.calls)).not.toContain("SELFTUNE_SERVICE_TOKEN");
  });
});
