import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import * as Schema from "effect/Schema";

import { desktopLibraryUpdateJourney } from "./desktop/library-update.scenario";
import { packagedDesktopTargetLayer } from "./src/desktop-target";
import { runScenario } from "./src/scenario-runner";
import type { TrackedUpdateFixture } from "./src/services";

const FixtureSchema = Schema.Struct({
  skill_name: Schema.String,
  installed_revision_hash: Schema.String,
  expected_revision_hash: Schema.String,
  expected_source_hash: Schema.String,
});

function loadFixture(): TrackedUpdateFixture | null {
  const path = process.env.SELFTUNE_E2E_DESKTOP_FIXTURE?.trim();
  if (!path || !existsSync(path)) return null;
  return Schema.decodeUnknownSync(FixtureSchema)(JSON.parse(readFileSync(path, "utf8")));
}

function packagedExecutable(desktopRoot: string): string | null {
  const configured = process.env.SELFTUNE_E2E_DESKTOP_APP?.trim();
  if (configured) return resolve(configured);
  const candidates =
    process.platform === "darwin"
      ? [
          join(
            desktopRoot,
            "dist-e2e",
            "mac-arm64",
            "selftune.app",
            "Contents",
            "MacOS",
            "selftune",
          ),
          join(desktopRoot, "dist-e2e", "mac", "selftune.app", "Contents", "MacOS", "selftune"),
        ]
      : process.platform === "win32"
        ? [join(desktopRoot, "dist-e2e", "win-unpacked", "selftune.exe")]
        : [join(desktopRoot, "dist-e2e", "linux-unpacked", "selftune")];
  return candidates.find(existsSync) ?? null;
}

function isolatedEnvironment(): Record<string, string> | undefined {
  const home = process.env.SELFTUNE_E2E_DESKTOP_HOME?.trim();
  const config = process.env.SELFTUNE_E2E_DESKTOP_CONFIG_DIR?.trim();
  if (!home || !config) return undefined;
  const resolvedHome = resolve(home);
  return {
    HOME: resolvedHome,
    SELFTUNE_HOME: resolvedHome,
    SELFTUNE_CONFIG_DIR: resolve(config),
    SELFTUNE_CLAUDE_DIR: join(resolvedHome, ".claude"),
    SELFTUNE_OPENCLAW_DIR: join(resolvedHome, ".openclaw"),
    SELFTUNE_PI_DIR: join(resolvedHome, ".pi"),
  };
}

const worktree = resolve(import.meta.dirname, "..");
const desktopRoot = join(worktree, "apps", "desktop");
const result = await runScenario({
  target: "desktop",
  scenario: "library-update-desktop",
  source: new URL("./desktop/library-update.scenario.ts", import.meta.url).pathname,
  runsRoot: resolve(process.env.SELFTUNE_E2E_RUNS_ROOT ?? resolve(import.meta.dirname, "runs")),
  layer: (runDirectory) =>
    packagedDesktopTargetLayer({
      worktree,
      executablePath: packagedExecutable(desktopRoot),
      fixture: loadFixture(),
      runDirectory,
      environment: isolatedEnvironment(),
    }),
  program: desktopLibraryUpdateJourney(),
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status === "failed") process.exitCode = 1;
