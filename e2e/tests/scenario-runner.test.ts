import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type LibraryLocation, type LibraryOrigin, LibrarySnapshot } from "@selftune/control-plane";
import { startDashboardServer } from "@selftune/local/dashboard-server";
import type { DevManifest } from "../../scripts/dev-local-state";

import { localLibraryUpdateJourney } from "../local/library-update.scenario";
import { acquireLocalDevStack, localTargetLayer, type LocalDevStack } from "../src/local-target";
import {
  Artifacts,
  Browser,
  capabilityUnavailable,
  FixtureData,
  LocalApi,
  RuntimeRestart,
  Target,
} from "../src/services";
import { runScenario } from "../src/scenario-runner";

describe("capability-driven E2E scenarios", () => {
  test("records an unavailable yielded capability as a structured skip", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-e2e-skip-"));
    try {
      const layer = Layer.succeed(Browser, {
        reviewAndApplyLibraryUpdate: () =>
          capabilityUnavailable("browser", "The target does not provide a browser."),
      });
      const result = await runScenario({
        target: "api-only",
        scenario: "library-update",
        source: import.meta.filename,
        runsRoot: root,
        layer,
        program: Effect.gen(function* () {
          const browser = yield* Browser;
          yield* browser.reviewAndApplyLibraryUpdate("research");
        }),
      });

      expect(result.status).toBe("skipped");
      expect(result).toMatchObject({
        target: "api-only",
        scenario: "library-update",
        missing_capability: "browser",
        skip_reason: "The target does not provide a browser.",
      });
      const skip = JSON.parse(readFileSync(join(result.run_directory, "skipped.json"), "utf8"));
      expect(skip.status).toBe("skipped");
      const second = await runScenario({
        target: "api-only",
        scenario: "library-update",
        source: import.meta.filename,
        runsRoot: root,
        layer,
        program: Effect.gen(function* () {
          const browser = yield* Browser;
          yield* browser.reviewAndApplyLibraryUpdate("research");
        }),
      });
      expect(second.run_directory).not.toBe(result.run_directory);
      expect(existsSync(join(result.run_directory, "result.json"))).toBe(true);
      expect(existsSync(join(second.run_directory, "result.json"))).toBe(true);
      const matrix = JSON.parse(readFileSync(join(root, "matrix.json"), "utf8"));
      expect(matrix.results).toEqual([
        expect.objectContaining({ target: "api-only", status: "skipped" }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("attach mode refuses an unverified worktree instance", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "selftune-e2e-attach-"));
    try {
      await expect(acquireLocalDevStack(worktree, true)).rejects.toThrow(
        "No verified #158 dev instance",
      );
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test("isolates review artifacts for a successful Local Library journey", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-e2e-pass-"));
    let currentHash = "old-tree";
    let restarted = false;
    const makeLayer = (runDirectory: string) =>
      Layer.mergeAll(
        Layer.succeed(Target, { id: "local", worktree: "/tmp/selftune" }),
        Layer.succeed(FixtureData, {
          trackedUpdate: () =>
            Effect.succeed({
              skill_name: "research",
              installed_revision_hash: "old-tree",
              expected_revision_hash: "new-tree",
              expected_source_hash: "new-tree",
            }),
        }),
        Layer.succeed(LocalApi, {
          skillState: (name) =>
            Effect.succeed({
              name,
              update_status: currentHash === "old-tree" ? "available" : "current",
              installed_hash: currentHash,
            }),
        }),
        Layer.succeed(Browser, {
          reviewAndApplyLibraryUpdate: () =>
            Effect.sync(() => {
              currentHash = "new-tree";
              writeFileSync(join(runDirectory, "trace.zip"), "trace");
              writeFileSync(join(runDirectory, "screenshots", "01-review.png"), "png");
              return {
                receipt_id: "receipt-1",
                receipt_status: "applied",
                installed_hash: "new-tree",
              };
            }),
        }),
        Layer.succeed(RuntimeRestart, {
          restart: () =>
            Effect.sync(() => {
              restarted = true;
            }),
        }),
        Layer.succeed(Artifacts, {
          runDirectory,
          log: (message) =>
            Effect.sync(() => {
              mkdirSync(join(runDirectory, "logs"), { recursive: true });
              writeFileSync(join(runDirectory, "logs", "journey.log"), `${message}\n`, {
                flag: "a",
              });
            }),
        }),
      );

    try {
      const result = await runScenario({
        target: "local",
        scenario: "library-update",
        source: new URL("../local/library-update.scenario.ts", import.meta.url).pathname,
        runsRoot: root,
        layer: makeLayer,
        program: localLibraryUpdateJourney(),
      });

      expect(result.status, JSON.stringify(result)).toBe("passed");
      expect(restarted).toBe(true);
      expect(existsSync(join(result.run_directory, "trace.zip"))).toBe(true);
      expect(existsSync(join(result.run_directory, "screenshots", "01-review.png"))).toBe(true);
      expect(readFileSync(join(result.run_directory, "logs", "journey.log"), "utf8")).toContain(
        "receipt receipt-1",
      );
      expect(existsSync(join(result.run_directory, "library-update.scenario.ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("drives the real Local dashboard and API through the browser capability", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-e2e-browser-"));
    let updated = false;
    let restarted = false;
    const origin: LibraryOrigin = {
      kind: "github",
      label: "example/skills",
      url: "https://github.com/example/skills",
    };
    const location: LibraryLocation = {
      sourceKind: "installed",
      packagePath: join(root, ".agents", "skills", "research"),
      skillPath: join(root, ".agents", "skills", "research", "SKILL.md"),
      harness: "codex",
      scope: "global",
      projectRoot: null,
      active: true,
      modifiedAt: "2026-07-16T00:00:00.000Z",
      lastUsedAt: null,
      origin,
      updateStatus: "available",
    };
    const library = () =>
      LibrarySnapshot.make({
        generatedAt: new Date().toISOString(),
        counts: { total: 1, active: 1, library: 0, draft: 0, archived: 0 },
        skills: [
          {
            skillId: "research",
            name: "research",
            lifecycle: "active",
            revisions: [
              { contentHash: updated ? "new-content" : "old-content", locations: [location] },
            ],
            locations: [location],
            lastUsedAt: null,
            lastModifiedAt: "2026-07-16T00:00:00.000Z",
            origins: [origin],
            updateStatus: updated ? "current" : "available",
          },
        ],
      });
    const server = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      openBrowser: false,
      spaDir: resolve(import.meta.dirname, "../../apps/local-dashboard/dist"),
      libraryLoader: library,
      sourceUpdatePreviewer: () => ({
        skill_name: "research",
        source: "example/skills",
        source_url: "https://github.com/example/skills",
        installed_hash: "old-tree",
        latest_hash: "new-tree",
        status: "available",
        locations: [
          {
            package_path: location.packagePath,
            skill_path: location.skillPath,
            scope: "global",
            project_root: null,
            canonical_target: location.packagePath,
            local_state: "clean",
            reason: "Matches the recorded upstream revision.",
            local_diff: null,
          },
        ],
        conflicts: 0,
        can_apply: true,
        upstream_diff: "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-old\n+new",
      }),
      sourceUpdateApplier: () => {
        updated = true;
        return {
          schema_version: 1,
          receipt_id: "browser-receipt",
          skill_name: "research",
          source: "example/skills",
          previous_hash: "old-tree",
          installed_hash: "new-tree",
          status: "applied",
          strategy: "abort",
          operations: [],
          applied_at: new Date().toISOString(),
        };
      },
    });
    const manifest: DevManifest = {
      version: 1,
      kind: "selftune-dev",
      worktree: resolve(import.meta.dirname, "../.."),
      urls: {
        dashboard: `http://127.0.0.1:${server.port}`,
        vite: `http://127.0.0.1:${server.port}`,
      },
      ports: { dashboard: server.port, vite: server.port, control: server.port },
      pids: { supervisor: process.pid, runtime: process.pid, vite: process.pid },
      mode: "hmr",
      package_version: "0.2.33",
      instance_id: crypto.randomUUID(),
      started_at: new Date().toISOString(),
      auth_token: "x".repeat(43),
    };
    const stack: LocalDevStack = {
      manifest: async () => manifest,
      restartable: () => true,
      restart: async () => {
        restarted = true;
      },
      dispose: async () => {},
    };

    try {
      const storageState = join(root, "returning-user.json");
      writeFileSync(
        storageState,
        JSON.stringify({
          cookies: [],
          origins: [
            {
              origin: manifest.urls.dashboard,
              localStorage: [{ name: "selftune-on-demand-setup-dismissed", value: "true" }],
            },
          ],
        }),
      );
      const result = await runScenario({
        target: "local",
        scenario: "library-update-browser",
        source: new URL("../local/library-update.scenario.ts", import.meta.url).pathname,
        runsRoot: root,
        layer: (runDirectory) =>
          localTargetLayer({
            worktree: manifest.worktree,
            runDirectory,
            stack,
            storageState,
            fixture: {
              skill_name: "research",
              installed_revision_hash: "old-content",
              expected_revision_hash: "new-content",
              expected_source_hash: "new-tree",
            },
          }),
        program: localLibraryUpdateJourney(),
      });
      expect(result.status, JSON.stringify(result)).toBe("passed");
      expect(restarted).toBe(true);
      expect(existsSync(join(result.run_directory, "trace.zip"))).toBe(true);
      expect(existsSync(join(result.run_directory, "screenshots", "02-detail.png"))).toBe(true);
      expect(existsSync(join(result.run_directory, "screenshots", "03-review.png"))).toBe(true);
      expect(existsSync(join(result.run_directory, "screenshots", "04-applied.png"))).toBe(true);
      expect(existsSync(join(result.run_directory, "recovery-receipt.json"))).toBe(true);
    } finally {
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
