/* oxlint-disable no-await-in-loop -- target mutations and matrix writes are intentionally isolated and sequential */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as Schema from "effect/Schema";

import { libraryUpdateServerJourney } from "./local/library-update.scenario";
import { acquireLocalDevStack, localTargetLayer } from "./src/local-target";
import { runScenario, type ScenarioResult } from "./src/scenario-runner";
import { attachedServerTargetLayer } from "./src/server-target";
import type { TrackedUpdateFixture } from "./src/services";

const FixtureSchema = Schema.Struct({
  skill_name: Schema.String,
  installed_revision_hash: Schema.String,
  expected_revision_hash: Schema.String,
  expected_source_hash: Schema.String,
});

type ServerTarget = "local" | "cloud" | "selfhost";

function fixture(variable: string, fallback?: string): TrackedUpdateFixture | null {
  const path = process.env[variable]?.trim() || (fallback ? process.env[fallback]?.trim() : null);
  if (!path || !existsSync(path)) return null;
  return Schema.decodeUnknownSync(FixtureSchema)(JSON.parse(readFileSync(path, "utf8")));
}

function selectedTargets(): readonly ServerTarget[] {
  const selection = Bun.argv[2]?.trim().toLowerCase() ?? "all";
  if (selection === "all") return ["local", "cloud", "selfhost"];
  if (selection === "local" || selection === "cloud" || selection === "selfhost") {
    return [selection];
  }
  throw new Error("Choose one server target: local, cloud, selfhost, or all.");
}

function sourceUpdateContract(prefix: string): "local-v2" | undefined {
  const value = process.env[`${prefix}_SOURCE_UPDATE_CONTRACT`]?.trim();
  if (!value) return undefined;
  if (value === "local-v2") return value;
  throw new Error(`${prefix}_SOURCE_UPDATE_CONTRACT must be local-v2 when set.`);
}

const worktree = resolve(import.meta.dirname, "..");
const runsRoot = resolve(
  process.env.SELFTUNE_E2E_RUNS_ROOT ?? resolve(import.meta.dirname, "runs"),
);
const scenarioSource = new URL("./local/library-update.scenario.ts", import.meta.url).pathname;
const results: ScenarioResult[] = [];

for (const target of selectedTargets()) {
  if (target === "local") {
    const stack = await acquireLocalDevStack(worktree, process.env.SELFTUNE_E2E_ATTACH === "1");
    try {
      results.push(
        await runScenario({
          target,
          scenario: "library-update-server",
          source: scenarioSource,
          runsRoot,
          layer: (runDirectory) =>
            localTargetLayer({
              worktree,
              runDirectory,
              stack,
              fixture: fixture("SELFTUNE_E2E_LOCAL_FIXTURE", "SELFTUNE_E2E_LIBRARY_FIXTURE"),
            }),
          program: libraryUpdateServerJourney(),
        }),
      );
    } finally {
      await stack.dispose();
    }
    continue;
  }

  const prefix = `SELFTUNE_E2E_${target.toUpperCase()}`;
  results.push(
    await runScenario({
      target,
      scenario: "library-update-server",
      source: scenarioSource,
      runsRoot,
      layer: (runDirectory) =>
        attachedServerTargetLayer({
          target,
          dashboardUrl: process.env[`${prefix}_URL`]?.trim() || null,
          fixture: fixture(`${prefix}_FIXTURE`),
          runDirectory,
          token: process.env[`${prefix}_TOKEN`]?.trim(),
          storageState: process.env[`${prefix}_STORAGE_STATE`]?.trim(),
          restartUrl: process.env[`${prefix}_RESTART_URL`]?.trim(),
          libraryItemId: process.env[`${prefix}_LIBRARY_ITEM_ID`]?.trim(),
          mutationContract: sourceUpdateContract(prefix),
        }),
      program: libraryUpdateServerJourney(),
    }),
  );
}

process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
if (results.some((result) => result.status === "failed")) process.exitCode = 1;
