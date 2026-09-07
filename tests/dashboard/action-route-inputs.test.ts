import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DashboardActionEvent } from "../../packages/runtime/dashboard-contract.js";
import type { StatusResult } from "../../packages/runtime/status.js";
import type { DashboardCoreRouteOverrides } from "@selftune/local/routes/core";

let createDashboardCoreRoutes: typeof import("@selftune/local/routes/core").createDashboardCoreRoutes;
let watchedSkillsPath: string;
const previousConfig = process.env.SELFTUNE_CONFIG_DIR;
const root = mkdtempSync(join(tmpdir(), "selftune-action-inputs-"));
const databases: Database[] = [];
const origin = "http://127.0.0.1:3145";
const status: StatusResult = {
  skills: [],
  unmatchedQueries: 0,
  pendingProposals: 0,
  lastSession: null,
  system: { healthy: true, pass: 1, fail: 0, warn: 0 },
};
const skill = { skill: "example", skillPath: join(root, "missing-skill", "SKILL.md") };

beforeAll(async () => {
  process.env.SELFTUNE_CONFIG_DIR = root;
  ({ createDashboardCoreRoutes } = await import("@selftune/local/routes/core"));
  ({ WATCHED_SKILLS_PATH: watchedSkillsPath } =
    await import("../../packages/runtime/constants.js"));
  if (!watchedSkillsPath.startsWith(`${root}/`)) throw new Error("Watchlist test is not isolated");
});
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
afterAll(() => {
  if (previousConfig === undefined) delete process.env.SELFTUNE_CONFIG_DIR;
  else process.env.SELFTUNE_CONFIG_DIR = previousConfig;
  rmSync(root, { recursive: true, force: true });
});

function createRoutes(overrides: DashboardCoreRouteOverrides = {}) {
  const database = new Database(":memory:");
  databases.push(database);
  const invocations: Array<{ command: string; args: string[] }> = [];
  const events: DashboardActionEvent[] = [];
  const routes = createDashboardCoreRoutes({
    database,
    version: () => "test",
    statusLoader: () => status,
    onActionEvent: (event) => events.push(event),
    actionRunner: async (command, args, hooks) => {
      invocations.push({ command, args });
      hooks?.onStdout?.("done");
      hooks?.onStderr?.("note");
      return { success: true, output: "done", error: null, exitCode: 0 };
    },
    ...overrides,
  });
  async function post(action: string, body: string, requestOrigin = origin) {
    const url = new URL(`/api/actions/${action}`, origin);
    const response = await routes.handle(
      new Request(url, {
        method: "POST",
        headers: { origin: requestOrigin },
        body,
      }),
      url,
      new Set([origin]),
    );
    if (!response) throw new Error("Action route was not handled");
    return response;
  }
  return { routes, post, invocations, events };
}

describe("local action request boundary", () => {
  test.each(["{", "null", "[]", "1", '"text"', "false"])(
    "rejects non-object JSON %s before sync",
    async (body) => {
      const { post, invocations, events } = createRoutes();
      expect((await post("sync", body)).status).toBe(400);
      expect(invocations).toEqual([]);
      expect(events).toEqual([]);
    },
  );

  test.each(
    [
      {},
      { skill: "example" },
      { ...skill, skill: 42 },
      { ...skill, skill: "" },
      { ...skill, skillPath: false },
      { ...skill, skillPath: {} },
      { ...skill, skillPath: [] },
      { ...skill, skillPath: "" },
      { ...skill, proposalId: [] },
      { ...skill, proposalId: 123 },
      { ...skill, autoSynthetic: "true" },
      { ...skill, autoSynthetic: null },
    ].map((body) => JSON.stringify(body)),
  )("rejects malformed skill action fields %#", async (body) => {
    const { post, invocations, events } = createRoutes();
    expect((await post("generate-evals", body)).status).toBe(400);
    expect(invocations).toEqual([]);
    expect(events).toEqual([]);
  });

  test("rejects unknown actions and cross-origin requests without executing", async () => {
    const { post, invocations, events } = createRoutes();
    expect((await post("missing", JSON.stringify(skill))).status).toBe(400);
    expect((await post("sync", "{}", "https://other.example")).status).toBe(403);
    expect(invocations).toEqual([]);
    expect(events).toEqual([]);
  });

  test.each([
    { action: "create-check", command: "create", args: ["check", "--skill-path", skill.skillPath] },
    {
      action: "evolve",
      command: "improve",
      args: ["--skill", skill.skill, "--skill-path", skill.skillPath, "--sync-first"],
    },
    {
      action: "rollback",
      command: "evolve",
      args: [
        "rollback",
        "--skill",
        skill.skill,
        "--skill-path",
        skill.skillPath,
        "--proposal-id",
        "proposal-1",
      ],
    },
  ])(
    "preserves $action command arguments and normalized events",
    async ({ action, command, args }) => {
      const { post, invocations, events } = createRoutes();
      expect(
        (await post(action, JSON.stringify({ ...skill, proposalId: "proposal-1" }))).status,
      ).toBe(200);
      expect(invocations).toEqual([{ command, args: [...args] }]);
      expect(events.map((event) => event.stage)).toEqual([
        "started",
        "stdout",
        "stderr",
        "finished",
      ]);
      expect(new Set(events.map((event) => event.action))).toEqual(
        new Set([action === "evolve" ? "deploy-candidate" : action]),
      );
      expect(new Set(events.map((event) => event.event_id)).size).toBe(1);
    },
  );

  test.each([true, false])("preserves the explicit synthetic flag %s", async (autoSynthetic) => {
    const { post, invocations } = createRoutes();
    expect((await post("generate-evals", JSON.stringify({ ...skill, autoSynthetic }))).status).toBe(
      200,
    );
    expect(invocations[0].command).toBe("eval");
    expect(invocations[0].args.includes("--auto-synthetic")).toBe(autoSynthetic);
  });

  test("sync retains its fixed command", async () => {
    const { post, invocations } = createRoutes();
    expect((await post("sync", "{}")).status).toBe(200);
    expect(invocations).toEqual([{ command: "sync", args: ["--no-repair"] }]);
  });

  test("invalid watchlists preserve the saved file and valid empty lists clear it", async () => {
    const { post, invocations, events } = createRoutes();
    expect(
      (await post("watchlist", JSON.stringify({ skills: [" first ", "first", "second"] }))).status,
    ).toBe(200);
    const saved = readFileSync(watchedSkillsPath, "utf8");
    for (const body of [
      {},
      { skills: null },
      { skills: "first" },
      { skills: ["first", 1] },
      { skills: {} },
    ]) {
      expect((await post("watchlist", JSON.stringify(body))).status).toBe(400);
      expect(readFileSync(watchedSkillsPath, "utf8")).toBe(saved);
    }
    const cleared = await post("watchlist", JSON.stringify({ skills: [] }));
    expect(await cleared.json()).toEqual({ success: true, watched_skills: [], error: null });
    expect(invocations).toEqual([]);
    expect(events).toEqual([]);
  });

  test.each([
    {},
    { skillNames: null },
    { skillNames: "one,two" },
    { skillNames: ["one"] },
    { skillNames: ["one", 2] },
    { skillNames: ["one", " "] },
    { skillNames: ["one", " one "] },
    { skillNames: Array.from({ length: 51 }, (_, i) => `skill-${i}`) },
  ])("rejects invalid collision input before database queries %#", async (body) => {
    const { post, invocations } = createRoutes();
    expect((await post("skill-set-collision-readiness", JSON.stringify(body))).status).toBe(400);
    expect(invocations).toEqual([]);
  });

  test("concurrent initial status requests share the refresh result", async () => {
    const pending = Promise.withResolvers<StatusResult>();
    let loads = 0;
    const { routes } = createRoutes({
      statusLoader: () => {
        loads++;
        return pending.promise;
      },
    });
    const url = new URL("/badge/missing", origin);
    const first = routes.handle(new Request(url), url, new Set([origin]));
    const second = routes.handle(new Request(url), url, new Set([origin]));
    pending.resolve(status);
    expect((await first)?.status).toBe(404);
    expect((await second)?.status).toBe(404);
    expect((await routes.handle(new Request(url), url, new Set([origin])))?.status).toBe(404);
    expect(loads).toBe(1);
  });

  test("a rejected initial status load can be retried", async () => {
    let loads = 0;
    const { routes } = createRoutes({
      statusLoader: async () => {
        loads++;
        if (loads === 1) throw new Error("fixture unavailable");
        return status;
      },
    });
    const url = new URL("/badge/missing", origin);
    await expect(routes.handle(new Request(url), url, new Set([origin]))).rejects.toThrow(
      "fixture unavailable",
    );
    expect((await routes.handle(new Request(url), url, new Set([origin])))?.status).toBe(404);
    expect(loads).toBe(2);
  });
});
