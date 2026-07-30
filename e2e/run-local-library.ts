import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as Schema from "effect/Schema";

import { localLibraryUpdateJourney } from "./local/library-update.scenario";
import { acquireLocalDevStack, localTargetLayer } from "./src/local-target";
import { runScenario } from "./src/scenario-runner";
import type { TrackedUpdateFixture } from "./src/services";

const FixtureSchema = Schema.Struct({
  skill_name: Schema.String,
  installed_revision_hash: Schema.String,
  expected_revision_hash: Schema.String,
  expected_source_hash: Schema.String,
});

function loadFixture(): TrackedUpdateFixture | null {
  const path = process.env.SELFTUNE_E2E_LIBRARY_FIXTURE?.trim();
  if (!path || !existsSync(path)) return null;
  return Schema.decodeUnknownSync(FixtureSchema)(JSON.parse(readFileSync(path, "utf8")));
}

const worktree = resolve(import.meta.dirname, "..");
const stack = await acquireLocalDevStack(worktree, process.env.SELFTUNE_E2E_ATTACH === "1");
try {
  const result = await runScenario({
    target: "local",
    scenario: "library-update",
    source: new URL("./local/library-update.scenario.ts", import.meta.url).pathname,
    runsRoot: resolve(import.meta.dirname, "runs"),
    layer: (runDirectory) =>
      localTargetLayer({ worktree, runDirectory, stack, fixture: loadFixture() }),
    program: localLibraryUpdateJourney(),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "failed") process.exitCode = 1;
} finally {
  await stack.dispose();
}
