import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const applyModule = new URL("../../packages/runtime/skill-set-remote-apply.ts", import.meta.url)
  .pathname;
const blockedPolicy = {
  skill_set_id: "engineering",
  skill_set_name: "Engineering",
  owner_scope: "workspace",
  action: "block",
  reason: "Use the approved revision.",
  updated_by: null,
  updated_at: null,
};

describe("persisted workspace policy boundary", () => {
  let root: string;
  let cachePath: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "selftune-policy-cache-"));
    cachePath = join(root, "workspace-skill-set-policies.json");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function apply(url = "") {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { applySkillSetWithRemoteDependencies } from ${JSON.stringify(applyModule)};
      try {
        await applySkillSetWithRemoteDependencies({set_id: "engineering", project_root: ${JSON.stringify(join(root, "project"))}}, {configRoot: ${JSON.stringify(root)}});
      } catch (cause) {
        console.log(cause instanceof Error ? cause.message : "Unexpected failure");
        process.exitCode = 1;
      }
    `,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          SELFTUNE_CONFIG_DIR: root,
          SELFTUNE_NO_ANALYTICS: "1",
          SELFTUNE_SKIP_UPDATE_CHECK: "1",
          SELFTUNE_REMOTE_LIBRARY_URL: url,
          SELFTUNE_REMOTE_LIBRARY_API_KEY: url ? "fixture-device-key" : "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(1);
    expect(existsSync(join(root, "project"))).toBe(false);
    return stdout;
  }

  it("enforces a saved block while offline", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ schema_version: 1, policies: [blockedPolicy], current_role: "member" }),
    );
    expect(await apply()).toContain("Use the approved revision.");
  });

  it.each([
    "{",
    "{}",
    JSON.stringify({ policies: [{ ...blockedPolicy, action: "invalid" }] }),
    JSON.stringify({ policies: [blockedPolicy], current_role: "superuser" }),
    JSON.stringify({ schema_version: 2, policies: [] }),
  ])("rejects invalid cache bytes %s without installing", async (bytes) => {
    writeFileSync(cachePath, bytes);
    expect(await apply()).toContain("Saved workspace policies could not be verified");
    expect(readFileSync(cachePath, "utf8")).toBe(bytes);
  });

  it("rejects an unreadable cache entry", async () => {
    mkdirSync(cachePath);
    expect(await apply()).toContain("Saved workspace policies could not be verified");
  });

  it("allows an unconfigured personal library to reach ordinary manifest validation", async () => {
    expect(await apply()).toContain('Skill Set "engineering" was not found');
  });

  it("keeps enforcing legacy policies without version or role fields", async () => {
    writeFileSync(cachePath, JSON.stringify({ policies: [blockedPolicy] }));
    expect(await apply()).toContain("Use the approved revision.");
  });

  it("refreshes a damaged cache from the server before enforcing policy", async () => {
    writeFileSync(cachePath, "{");
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        requests.push(new URL(request.url).pathname);
        expect(request.headers.get("Authorization")).toBe("Bearer fixture-device-key");
        return Response.json({ policies: [blockedPolicy], current_role: "member" });
      },
    });
    try {
      expect(await apply(server.url.origin)).toContain("Use the approved revision.");
      expect(requests).toEqual(["/api/v1/remote-library/policies"]);
      expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({
        schema_version: 1,
        policies: [blockedPolicy],
        current_role: "member",
      });
    } finally {
      server.stop(true);
    }
  });
});
