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

function publicationArgs(operation: string): string[] {
  const common = [
    operation,
    "--skill-set-id",
    "support",
    "--envelope",
    "release.json",
    "--revision-sha256",
    "a".repeat(64),
    "--envelope-sha256",
    "b".repeat(64),
    "--yes",
    "--json",
  ];
  return operation === "publish"
    ? common
    : [...common, "--request-id", "request-1", "--base-release-id", "release-1", "--title", "Fix"];
}

function publicationIntent(operation: string) {
  const common = { upload_url: "https://storage.example/upload", expires_at: 1000 };
  return operation === "publish"
    ? { ...common, publish_intent_id: "intent-1" }
    : { ...common, request_id: "request-1" };
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

  test.each(["{", "null", "[]", "42", '"unexpected"'])(
    "does not report malformed successful status responses as success: %s",
    async (body) => {
      const f = fixture([new Response(body)]);
      expect(
        await runTeamCommand(["status", "--release-id", "release-1", "--json"], f.dependencies),
      ).toBe(1);
      expect(f.stdout).toEqual([]);
      expect(f.stderr).toEqual(["Team API returned an invalid response."]);
    },
  );

  test.each([401, 403])(
    "keeps authentication exit status for malformed %s responses",
    async (status) => {
      const f = fixture([new Response("<html>not signed in</html>", { status })]);
      expect(await runTeamCommand(["status", "--release-id", "release-1"], f.dependencies)).toBe(3);
      expect(f.stdout).toEqual([]);
      expect(f.stderr.join(" ")).not.toContain("stsvc_secret");
    },
  );

  test.each(["publish", "contribute"])(
    "validates %s upload intents before sending bytes",
    async (operation) => {
      for (const payload of [
        {},
        { ...publicationIntent(operation), upload_url: 42 },
        { ...publicationIntent(operation), expires_at: "1000" },
      ]) {
        const f = fixture([Response.json(payload)]);
        f.dependencies.env.SELFTUNE_DEVICE_TOKEN = "device_secret";
        expect(await runTeamCommand(publicationArgs(operation), f.dependencies)).toBe(1);
        expect(f.calls).toHaveLength(1);
        expect(f.stdout).toEqual([]);
        expect(f.stderr).toEqual(["Team API returned an invalid receipt."]);
      }
    },
  );

  test.each(["publish", "contribute"])(
    "validates %s storage receipts before finalizing",
    async (operation) => {
      for (const payload of [{}, { storageId: 42 }, { storageId: "" }]) {
        const f = fixture([Response.json(publicationIntent(operation)), Response.json(payload)]);
        f.dependencies.env.SELFTUNE_DEVICE_TOKEN = "device_secret";
        expect(await runTeamCommand(publicationArgs(operation), f.dependencies)).toBe(1);
        expect(f.calls).toHaveLength(2);
        expect(f.stdout).toEqual([]);
        expect(f.stderr).toEqual(["Team API returned an invalid receipt."]);
      }
    },
  );

  test.each(["publish", "contribute"])(
    "completes a validated %s sequence with scoped credentials",
    async (operation) => {
      const f = fixture([
        Response.json(publicationIntent(operation)),
        Response.json({ storageId: "storage-1" }),
        Response.json({ id: "completed-1", extra: { retained: true } }),
      ]);
      f.dependencies.env.SELFTUNE_DEVICE_TOKEN = "device_secret";
      expect(await runTeamCommand(publicationArgs(operation), f.dependencies)).toBe(0);
      expect(f.calls).toHaveLength(3);
      expect(f.stdout).toEqual(['{"id":"completed-1","extra":{"retained":true}}']);
      expect(f.stderr).toEqual([]);
      const credential = operation === "publish" ? "stsvc_secret" : "device_secret";
      expect(new Headers(f.calls[0]?.init?.headers).get("authorization")).toBe(
        `Bearer ${credential}`,
      );
      expect(new Headers(f.calls[1]?.init?.headers).has("authorization")).toBeFalse();
      expect(new Headers(f.calls[2]?.init?.headers).get("authorization")).toBe(
        `Bearer ${credential}`,
      );
      const bytes = f.calls[1]?.init?.body;
      if (!(bytes instanceof Blob)) throw new Error("Expected binary upload body");
      expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      expect(f.calls[2]?.url.endsWith("/finalize")).toBeTrue();
      expect(f.calls[2]?.init?.body).toContain('"storage_id":"storage-1"');
    },
  );

  test.each(["assign", "rollback"])(
    "includes a reason only for %s when required",
    async (operation) => {
      const f = fixture([Response.json({ recorded: true })]);
      const args = [
        operation,
        "--request-id",
        "request-1",
        "--release-id",
        "release-1",
        "--member-id",
        "member-1",
        "--device-id",
        "device-1",
        "--yes",
      ];
      if (operation === "rollback") args.push("--reason", "Regression");
      expect(await runTeamCommand(args, f.dependencies)).toBe(0);
      expect(f.calls[0]?.init?.body).toContain('"update_policy":"ask_before_updating"');
      if (operation === "rollback")
        expect(f.calls[0]?.init?.body).toContain('"reason":"Regression"');
      else expect(f.calls[0]?.init?.body).not.toContain('"reason"');
    },
  );
});
