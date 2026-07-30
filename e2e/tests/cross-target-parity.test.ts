import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { desktopLibraryUpdateJourney } from "../desktop/library-update.scenario";
import { libraryUpdateServerJourney } from "../local/library-update.scenario";
import { packagedDesktopTargetLayer } from "../src/desktop-target";
import { runScenario } from "../src/scenario-runner";
import { attachedServerTargetLayer } from "../src/server-target";
import {
  Artifacts,
  Browser,
  DesktopApplication,
  FixtureData,
  LocalApi,
  RuntimeRestart,
  Target,
} from "../src/services";

const fixture = {
  skill_name: "research",
  installed_revision_hash: "old-tree",
  expected_revision_hash: "new-tree",
  expected_source_hash: "new-tree",
};

const cloudSource = {
  id: "cloud-source-1",
  skillId: "skill-1",
  sourceType: "github",
  status: "ready",
  label: "Research",
  currentSnapshotId: "snapshot-1",
  currentCapabilityStatus: "cloud_ready",
  repoFullName: "selftune-dev/research",
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
};

function cloudContractResponse(pathname: string): Response | null {
  if (pathname === "/api/v1/cloud-sources") return Response.json([cloudSource]);
  if (pathname === "/api/v1/cloud-sources/cloud-source-1") {
    return Response.json({ source: cloudSource });
  }
  return null;
}

function serverLayer(target: string, runDirectory: string) {
  let current = fixture.installed_revision_hash;
  return Layer.mergeAll(
    Layer.succeed(Target, { id: target, worktree: `/tmp/${target}` }),
    Layer.succeed(FixtureData, { trackedUpdate: () => Effect.succeed(fixture) }),
    Layer.succeed(LocalApi, {
      skillState: (name) =>
        Effect.succeed({
          name,
          update_status: current === fixture.expected_revision_hash ? "current" : "available",
          installed_hash: current,
        }),
    }),
    Layer.succeed(Browser, {
      reviewAndApplyLibraryUpdate: () =>
        Effect.sync(() => {
          current = fixture.expected_revision_hash;
          writeFileSync(join(runDirectory, "trace.zip"), `${target} trace`);
          writeFileSync(join(runDirectory, "screenshots", "04-applied.png"), `${target} png`);
          writeFileSync(
            join(runDirectory, "recovery-receipt.json"),
            JSON.stringify({ receipt_id: `${target}-receipt`, status: "applied" }),
          );
          return {
            receipt_id: `${target}-receipt`,
            receipt_status: "applied",
            installed_hash: fixture.expected_source_hash,
          };
        }),
    }),
    Layer.succeed(RuntimeRestart, { restart: () => Effect.void }),
    Layer.succeed(Artifacts, {
      runDirectory,
      log: () => Effect.void,
    }),
  );
}

describe("cross-target Library parity", () => {
  test("runs one unchanged server journey against Local, Cloud, and Self-host providers", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-server-parity-"));
    try {
      const results = await Promise.all(
        ["local", "cloud", "selfhost"].map((target) =>
          runScenario({
            target,
            scenario: "library-update-server",
            source: new URL("../local/library-update.scenario.ts", import.meta.url).pathname,
            runsRoot: root,
            layer: (runDirectory) => serverLayer(target, runDirectory),
            program: libraryUpdateServerJourney(),
          }),
        ),
      );

      expect(results.map((result) => result.status)).toEqual(["passed", "passed", "passed"]);
      expect(new Set(results.map((result) => result.run_directory)).size).toBe(3);
      for (const result of results) {
        expect(existsSync(join(result.run_directory, "trace.zip"))).toBe(true);
        expect(existsSync(join(result.run_directory, "screenshots", "04-applied.png"))).toBe(true);
        expect(existsSync(join(result.run_directory, "recovery-receipt.json"))).toBe(true);
      }
      expect(
        results.map((result) =>
          result.status === "passed" ? result.observable_outcome.installed_hash : null,
        ),
      ).toEqual(["new-tree", "new-tree", "new-tree"]);
      const matrix = await Bun.file(join(root, "matrix.json")).json();
      expect(matrix.parity).toEqual([
        expect.objectContaining({ target: "local", status: "passed", installed_hash: "new-tree" }),
        expect.objectContaining({ target: "cloud", status: "passed", installed_hash: "new-tree" }),
        expect.objectContaining({
          target: "selfhost",
          status: "passed",
          installed_hash: "new-tree",
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses a separate packaged-Desktop capability with the same observable outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-desktop-parity-"));
    try {
      const result = await runScenario({
        target: "desktop",
        scenario: "library-update-desktop",
        source: new URL("../desktop/library-update.scenario.ts", import.meta.url).pathname,
        runsRoot: root,
        layer: (runDirectory) =>
          Layer.mergeAll(
            Layer.succeed(Target, { id: "desktop", worktree: "/tmp/desktop" }),
            Layer.succeed(FixtureData, { trackedUpdate: () => Effect.succeed(fixture) }),
            Layer.succeed(DesktopApplication, {
              applyLibraryUpdate: () =>
                Effect.sync(() => {
                  writeFileSync(join(runDirectory, "desktop-trace.zip"), "desktop trace");
                  writeFileSync(
                    join(runDirectory, "desktop-restart-trace.zip"),
                    "desktop restart trace",
                  );
                  writeFileSync(
                    join(runDirectory, "screenshots", "05-desktop-restarted.png"),
                    "desktop png",
                  );
                  return {
                    installed_hash: fixture.expected_revision_hash,
                    receipt_id: "desktop-receipt",
                    receipt_status: "applied",
                  };
                }),
            }),
            Layer.succeed(Artifacts, { runDirectory, log: () => Effect.void }),
          ),
        program: desktopLibraryUpdateJourney(),
      });

      expect(result.status).toBe("passed");
      expect(existsSync(join(result.run_directory, "desktop-trace.zip"))).toBe(true);
      expect(existsSync(join(result.run_directory, "desktop-restart-trace.zip"))).toBe(true);
      expect(
        existsSync(join(result.run_directory, "screenshots", "05-desktop-restarted.png")),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports a missing packaged application as a structured Desktop skip", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-desktop-skip-"));
    try {
      const result = await runScenario({
        target: "desktop",
        scenario: "library-update-desktop",
        source: new URL("../desktop/library-update.scenario.ts", import.meta.url).pathname,
        runsRoot: root,
        layer: (runDirectory) =>
          packagedDesktopTargetLayer({
            worktree: "/tmp/desktop",
            executablePath: null,
            fixture,
            runDirectory,
          }),
        program: desktopLibraryUpdateJourney(),
      });

      expect(result).toMatchObject({
        status: "skipped",
        target: "desktop",
        scenario: "library-update-desktop",
        missing_capability: "packaged-desktop",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports an unconfigured attached server as a structured capability skip", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-server-skip-"));
    try {
      const result = await runScenario({
        target: "cloud",
        scenario: "library-update-server",
        source: new URL("../local/library-update.scenario.ts", import.meta.url).pathname,
        runsRoot: root,
        layer: (runDirectory) =>
          attachedServerTargetLayer({
            target: "cloud",
            dashboardUrl: null,
            fixture,
            runDirectory,
          }),
        program: libraryUpdateServerJourney(),
      });

      expect(result).toMatchObject({
        status: "skipped",
        target: "cloud",
        scenario: "library-update-server",
        missing_capability: "server-endpoint",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("verifies Cloud inventory and detail before skipping unsupported source updates", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-cloud-read-contract-"));
    const requests: Array<{ method: string; pathname: string }> = [];
    const cookies: string[] = [];
    const storageState = join(root, "storage-state.json");
    writeFileSync(
      storageState,
      JSON.stringify({
        cookies: [
          {
            name: "session",
            value: "secret",
            domain: "localhost",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
    );
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push({ method: request.method, pathname: url.pathname });
        cookies.push(request.headers.get("cookie") ?? "");
        const response = cloudContractResponse(url.pathname);
        if (response) return response;
        return new Response("unexpected endpoint", { status: 500 });
      },
    });

    try {
      const result = await runScenario({
        target: "cloud",
        scenario: "library-update-server",
        source: new URL("../local/library-update.scenario.ts", import.meta.url).pathname,
        runsRoot: root,
        layer: (runDirectory) =>
          attachedServerTargetLayer({
            target: "cloud",
            dashboardUrl: server.url.href,
            fixture,
            runDirectory,
            storageState,
          }),
        program: libraryUpdateServerJourney(),
      });

      expect(result).toMatchObject({
        status: "skipped",
        target: "cloud",
        missing_capability: "source-update-review",
      });
      expect(requests).toEqual([
        { method: "GET", pathname: "/api/v1/cloud-sources" },
        { method: "GET", pathname: "/api/v1/cloud-sources/cloud-source-1" },
      ]);
      expect(cookies).toEqual(["session=secret", "session=secret"]);
      expect(
        await Bun.file(join(result.run_directory, "library-contract.json")).json(),
      ).toMatchObject({
        target: "cloud",
        contract: "cloud-sources-v1",
        inventory_count: 1,
        detail_id: "cloud-source-1",
      });
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preflights hosted restart after Cloud reads and before Local-style mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-server-preflight-"));
    const requests: Array<{ method: string; pathname: string }> = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push({ method: request.method, pathname: url.pathname });
        const response = cloudContractResponse(url.pathname);
        if (response) return response;
        return new Response("mutation endpoint must not be called", { status: 500 });
      },
    });
    try {
      const result = await runScenario({
        target: "cloud",
        scenario: "library-update-server",
        source: new URL("../local/library-update.scenario.ts", import.meta.url).pathname,
        runsRoot: root,
        layer: (runDirectory) =>
          attachedServerTargetLayer({
            target: "cloud",
            dashboardUrl: server.url.href,
            fixture,
            runDirectory,
            mutationContract: "local-v2",
          }),
        program: libraryUpdateServerJourney(),
      });

      expect(result).toMatchObject({
        status: "skipped",
        missing_capability: "runtime-restart",
      });
      expect(requests).toEqual([
        { method: "GET", pathname: "/api/v1/cloud-sources" },
        { method: "GET", pathname: "/api/v1/cloud-sources/cloud-source-1" },
      ]);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows a deliberate Cloud test instance to opt into the Local-v2 mutation contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-cloud-mutation-contract-"));
    const requests: Array<{ method: string; pathname: string }> = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push({ method: request.method, pathname: url.pathname });
        const response = cloudContractResponse(url.pathname);
        if (response) return response;
        if (url.pathname === "/api/v2/library") {
          return Response.json({
            skills: [
              {
                name: fixture.skill_name,
                updateStatus: "available",
                revisions: [{ contentHash: fixture.installed_revision_hash }],
              },
            ],
          });
        }
        return new Response("unexpected endpoint", { status: 500 });
      },
    });

    try {
      const layer = attachedServerTargetLayer({
        target: "cloud",
        dashboardUrl: server.url.href,
        fixture,
        runDirectory: root,
        mutationContract: "local-v2",
        restartUrl: new URL("/test/restart", server.url).href,
      });
      const state = await Effect.runPromise(
        Effect.gen(function* () {
          const fixtures = yield* FixtureData;
          const api = yield* LocalApi;
          const tracked = yield* fixtures.trackedUpdate();
          return yield* api.skillState(tracked.skill_name);
        }).pipe(Effect.provide(layer)),
      );

      expect(state).toMatchObject({
        name: fixture.skill_name,
        update_status: "available",
        installed_hash: fixture.installed_revision_hash,
      });
      expect(requests).toEqual([
        { method: "GET", pathname: "/api/v1/cloud-sources" },
        { method: "GET", pathname: "/api/v1/cloud-sources/cloud-source-1" },
        { method: "GET", pathname: "/api/v2/library" },
      ]);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports a missing Cloud detail contract as a structured capability skip", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-cloud-detail-skip-"));
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === "/api/v1/cloud-sources") return Response.json([cloudSource]);
        return new Response("missing", { status: 404 });
      },
    });

    try {
      const result = await runScenario({
        target: "cloud",
        scenario: "library-update-server",
        source: new URL("../local/library-update.scenario.ts", import.meta.url).pathname,
        runsRoot: root,
        layer: (runDirectory) =>
          attachedServerTargetLayer({
            target: "cloud",
            dashboardUrl: server.url.href,
            fixture,
            runDirectory,
          }),
        program: libraryUpdateServerJourney(),
      });

      expect(result).toMatchObject({
        status: "skipped",
        missing_capability: "library-detail",
      });
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
