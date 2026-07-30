import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { RemoteLibrary, RemoteLibraryMemory } from "@selftune/control-plane";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { startDashboardServer } from "@selftune/local/dashboard-server";
import { loadLibraryCatalog } from "../../packages/runtime/library-catalog.js";
import { openDb } from "../../packages/runtime/localdb/db.js";
import type { RemoteLibraryHandle } from "../../packages/runtime/remote-library-runtime.js";
import {
  restoreRemoteLibrary,
  syncRemoteLibrary,
} from "../../packages/runtime/remote-library-sync.js";
import { scanSynthesisCandidates } from "../../packages/runtime/synthesis.js";
import type { CreatePackageEvaluationSummary } from "../../packages/runtime/types.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function createSkill(registry: string, name: string): string {
  const path = join(registry, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} work.\n---\n# ${name}\n`,
  );
  return path;
}

function memoryHandle(): RemoteLibraryHandle {
  const runtime = ManagedRuntime.make(RemoteLibraryMemory);
  const use = <A>(program: (remote: RemoteLibrary["Service"]) => Effect.Effect<A, unknown>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        return yield* program(yield* RemoteLibrary);
      }),
    );
  return {
    capabilities: () => use((remote) => remote.capabilities),
    putObject: (objectHash, bytes) => use((remote) => remote.putObject({ objectHash, bytes })),
    hasObject: (objectHash) => use((remote) => remote.hasObject(objectHash)),
    getObject: (objectHash) => use((remote) => remote.getObject(objectHash)),
    head: () => use((remote) => remote.head),
    getSnapshot: (snapshotId) => use((remote) => remote.getSnapshot(snapshotId)),
    commitSnapshot: (snapshot) => use((remote) => remote.commitSnapshot(snapshot)),
    diagnostics: () => use((remote) => remote.diagnostics),
    dispose: () => runtime.dispose(),
  };
}

function passingPackageEvaluation(
  skillName: string,
  skillPath: string,
): CreatePackageEvaluationSummary {
  return {
    skill_name: skillName,
    skill_path: skillPath,
    mode: "package",
    status: "passed",
    evaluation_passed: true,
    next_command: null,
    replay: {
      mode: "package",
      validation_mode: "host_replay",
      agent: "claude",
      proposal_id: "desktop-library-lifecycle",
      fixture_id: "held-out-fixture",
      total: 2,
      passed: 2,
      failed: 0,
      pass_rate: 1,
    },
    baseline: {
      mode: "package",
      baseline_pass_rate: 0.5,
      with_skill_pass_rate: 1,
      lift: 0.5,
      adds_value: true,
      measured_at: "2026-07-15T00:00:00.000Z",
    },
  };
}

function insightsResponse(snapshot: Awaited<ReturnType<typeof scanSynthesisCandidates>>) {
  return {
    snapshot,
    portfolio_reviews: [],
    counts: {
      pending: snapshot.candidates.filter((item) => item.status === "pending").length,
      accepted: snapshot.candidates.filter((item) => item.status === "accepted").length,
      drafted: snapshot.candidates.filter((item) => item.status === "drafted").length,
      snoozed: snapshot.candidates.filter((item) => item.status === "snoozed").length,
      completed: snapshot.candidates.filter((item) =>
        ["rejected", "drafted", "released"].includes(item.status),
      ).length,
      stale_reviews: 0,
      routing_reviews: 0,
    },
  };
}

describe("desktop-hosted Library lifecycle", () => {
  test("crosses the authenticated API from evidence to a clean restored client", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-desktop-lifecycle-"));
    roots.push(root);
    const configRoot = join(root, "client-a");
    const cleanRoot = join(root, "client-b");
    const codexRegistry = join(root, ".agents", "skills");
    const openCodeRegistry = join(root, ".opencode", "skills");
    createSkill(codexRegistry, "research");
    createSkill(openCodeRegistry, "research");
    const trialPath = createSkill(codexRegistry, "trial-skill");
    const batchPath = createSkill(codexRegistry, "batch-skill");
    const quarantineRoot = join(configRoot, "quarantine");

    const db = openDb(":memory:");
    for (let index = 1; index <= 3; index += 1) {
      db.run(
        `INSERT INTO session_telemetry (
          session_id, timestamp, cwd, skills_triggered_json, skills_invoked_json,
          assistant_turns, errors_encountered, last_user_query
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `session-${index}`,
          `2026-07-0${index}T00:00:00.000Z`,
          join(root, `project-${index}`),
          "[]",
          "[]",
          2,
          0,
          "Prepare release notes",
        ],
      );
    }

    const remote = memoryHandle();
    const token = "TOKEN_PLACEHOLDER";
    let primary: Awaited<ReturnType<typeof startDashboardServer>> | null = null;
    let restored: Awaited<ReturnType<typeof startDashboardServer>> | null = null;
    try {
      primary = await startDashboardServer({
        port: 0,
        host: "127.0.0.1",
        openBrowser: false,
        authToken: token,
        skillSetConfigRoot: configRoot,
        portfolioSearchDirs: [codexRegistry, openCodeRegistry],
        quarantineRoot,
        libraryLoader: () =>
          loadLibraryCatalog({
            searchDirs: [codexRegistry, openCodeRegistry],
            skillSetConfigRoot: configRoot,
            quarantineRoot,
          }),
        insightsLoader: async () =>
          insightsResponse(await scanSynthesisCandidates({ configRoot, db })),
        insightEvaluator: async (candidateId) => {
          const { evaluateSynthesisCandidate } =
            await import("../../packages/runtime/synthesis.js");
          return evaluateSynthesisCandidate(candidateId, {
            configRoot,
            runCreatePublish: async ({ skillPath }) => ({
              skill: skillPath.split("/").at(-2)!,
              skill_path: skillPath,
              published: true,
              watch_started: false,
              watch_gate_blocked: false,
              next_command: null,
              package_evaluation: passingPackageEvaluation(skillPath.split("/").at(-2)!, skillPath),
              replay_exit_code: 0,
              baseline_exit_code: 0,
              watch_exit_code: null,
              watch_result: null,
              watch_stdout: "",
              watch_stderr: "",
              watch_gate_passed: null,
              watch_gate_warnings: [],
              watch_trust_score: null,
              watch_gate_bypassed: false,
            }),
          });
        },
        remoteLibraryAction: async (action) => {
          if (action === "sync") {
            return syncRemoteLibrary({
              handle: remote,
              configRoot,
              preferences: {
                releasedSkills: true,
                drafts: true,
                skillSets: true,
                metadata: true,
                decisionHistory: true,
              },
              catalogOptions: {
                searchDirs: [codexRegistry, openCodeRegistry],
                quarantineRoot,
              },
            });
          }
          if (action === "restore") {
            return restoreRemoteLibrary({ handle: remote, targetRoot: cleanRoot });
          }
          const head = await remote.head();
          return { head, diagnostics: await remote.diagnostics() };
        },
      });
      const origin = `http://127.0.0.1:${primary.port}`;
      const request = async (path: string, body?: unknown) => {
        const response = await fetch(`${origin}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        return response.json();
      };

      const firstLibrary = await request("/api/v2/library");
      expect(
        firstLibrary.skills.find((skill: { name: string }) => skill.name === "research").locations,
      ).toHaveLength(2);

      const inbox = await request("/api/v2/insights");
      const candidate = inbox.snapshot.candidates[0];
      await request("/api/v2/insights/review", {
        candidate_id: candidate.candidateId,
        action: "accept",
        reason: "Reusable evidence across projects.",
      });
      const drafted = await request("/api/v2/insights/draft", {
        candidate_id: candidate.candidateId,
      });
      expect(existsSync(join(drafted.draft.skill_dir, "evals", "release.json"))).toBe(true);
      const releaseEvals = readFileSync(join(drafted.draft.skill_dir, "evals", "release.json"));
      expect(releaseEvals.toString()).not.toContain("session-");
      await request("/api/v2/insights/evaluate", { candidate_id: candidate.candidateId });
      const released = await request("/api/v2/insights/release", {
        candidate_id: candidate.candidateId,
      });

      const set = await request("/api/v2/skill-sets", {
        name: "Release projects",
        harnesses: ["codex", "opencode"],
        skills: [{ name: released.skill_name, package_path: released.package_path }],
      });
      const projectRoot = join(root, "materialized-project");
      mkdirSync(projectRoot);
      const plan = await request("/api/v2/skill-sets/plan", {
        set_id: set.set_id,
        project_root: projectRoot,
      });
      expect(plan.creates).toBe(2);
      const receipt = await request("/api/v2/skill-sets/apply", {
        set_id: set.set_id,
        project_root: projectRoot,
      });
      expect(receipt.status).toBe("applied");
      expect(existsSync(join(projectRoot, ".agents", "skills", released.skill_name))).toBe(true);
      expect(existsSync(join(projectRoot, ".opencode", "skills", released.skill_name))).toBe(true);

      const archived = await request("/api/v2/portfolio/quarantine-batch", {
        skills: [
          { skill_name: "trial-skill", skill_path: trialPath },
          { skill_name: "batch-skill", skill_path: batchPath },
        ],
      });
      expect(archived.receipts).toHaveLength(2);
      expect(archived.failures).toEqual([]);
      expect(existsSync(trialPath)).toBe(false);
      expect(existsSync(batchPath)).toBe(false);
      await Promise.all(
        archived.receipts.map((archiveReceipt) =>
          request("/api/v2/portfolio/restore", {
            quarantine_id: archiveReceipt.quarantine_id,
          }),
        ),
      );
      expect(existsSync(join(trialPath, "SKILL.md"))).toBe(true);
      expect(existsSync(join(batchPath, "SKILL.md"))).toBe(true);

      const synced = await request("/api/v2/settings/remote-library/sync", {});
      expect(synced.snapshot.artifacts.length).toBeGreaterThan(0);
      await request("/api/v2/settings/remote-library/restore", {});
      expect(existsSync(join(cleanRoot, "skill-sets", `${set.set_id}.json`))).toBe(true);
      expect(existsSync(join(cleanRoot, ".agents"))).toBe(false);

      restored = await startDashboardServer({
        port: 0,
        host: "127.0.0.1",
        openBrowser: false,
        authToken: token,
        skillSetConfigRoot: cleanRoot,
        libraryLoader: () => loadLibraryCatalog({ searchDirs: [], skillSetConfigRoot: cleanRoot }),
      });
      const restoredOrigin = `http://127.0.0.1:${restored.port}`;
      const restoredRequest = async (path: string, body?: unknown) => {
        const response = await fetch(`${restoredOrigin}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : { Origin: restoredOrigin, "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      const restoredLibrary = await restoredRequest("/api/v2/library");
      expect(
        restoredLibrary.skills.some(
          (skill: { name: string }) => skill.name === released.skill_name,
        ),
      ).toBe(true);
      const restoredProject = join(root, "restored-materialized-project");
      mkdirSync(restoredProject);
      const restoredPlan = await restoredRequest("/api/v2/skill-sets/plan", {
        set_id: set.set_id,
        project_root: restoredProject,
      });
      expect(restoredPlan.creates).toBe(2);
      await restoredRequest("/api/v2/skill-sets/apply", {
        set_id: set.set_id,
        project_root: restoredProject,
      });
      expect(existsSync(join(restoredProject, ".agents", "skills", released.skill_name))).toBe(
        true,
      );
    } finally {
      restored?.stop();
      primary?.stop();
      await remote.dispose();
      db.close();
    }
  });
});
