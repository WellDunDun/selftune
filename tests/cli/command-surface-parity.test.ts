import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PUBLIC_COMMAND_SURFACES,
  type PublicCommandSurface,
} from "../../cli/selftune/command-surface.js";

const selftuneRoot = resolve(import.meta.dir, "../..");
const workspaceRoot = resolve(selftuneRoot, "../..");
const quickReferencePath = resolve(selftuneRoot, "skill/references/cli-quick-reference.md");

interface CommandSurfaceFixture {
  name: string;
  modulePath: string;
  workflowDocPath: string;
  siteDocPath: string;
  surface: PublicCommandSurface;
  forbiddenAcrossSurface?: readonly string[];
  forbiddenSitePhrases?: readonly string[];
}

const COMMAND_SURFACE_FIXTURES: readonly CommandSurfaceFixture[] = [
  {
    name: "eval generate",
    modulePath: "cli/selftune/eval/hooks-to-evals.ts",
    workflowDocPath: "skill/workflows/Evals.md",
    siteDocPath: "sites/docs/cli/eval.mdx",
    surface: PUBLIC_COMMAND_SURFACES.evalGenerate,
    forbiddenAcrossSurface: ["selftune evals"],
  },
  {
    name: "evolve",
    modulePath: "cli/selftune/evolution/evolve.ts",
    workflowDocPath: "skill/workflows/Evolve.md",
    siteDocPath: "sites/docs/cli/evolve.mdx",
    surface: PUBLIC_COMMAND_SURFACES.evolve,
    forbiddenSitePhrases: ["auto-detected if omitted"],
  },
  {
    name: "watch",
    modulePath: "cli/selftune/monitoring/watch.ts",
    workflowDocPath: "skill/workflows/Watch.md",
    siteDocPath: "sites/docs/cli/watch.mdx",
    surface: PUBLIC_COMMAND_SURFACES.watch,
    forbiddenAcrossSurface: ["--enable-grade-watch"],
    forbiddenSitePhrases: ["auto-detected if omitted"],
  },
  {
    name: "orchestrate",
    modulePath: "cli/selftune/orchestrate.ts",
    workflowDocPath: "skill/workflows/Orchestrate.md",
    siteDocPath: "sites/docs/cli/orchestrate.mdx",
    surface: PUBLIC_COMMAND_SURFACES.orchestrate,
    forbiddenSitePhrases: ["Skip review and auto-deploy approved proposals"],
  },
];

function readText(path: string): string {
  return readFileSync(path, "utf-8");
}

function runHelp(modulePath: string): string {
  const result = Bun.spawnSync(["bun", modulePath, "--help"], {
    cwd: selftuneRoot,
    env: {
      ...process.env,
      CI: "1",
      SELFTUNE_NO_ANALYTICS: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(result.stdout).toString("utf-8");
  const stderr = Buffer.from(result.stderr).toString("utf-8");
  if (result.exitCode !== 0) {
    throw new Error(
      `Expected help command to exit 0 for ${modulePath}, got ${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  return stdout;
}

function runEntrypointHelp(...args: string[]): string {
  const result = Bun.spawnSync(["bun", "cli/selftune/index.ts", ...args], {
    cwd: selftuneRoot,
    env: {
      ...process.env,
      CI: "1",
      SELFTUNE_NO_ANALYTICS: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(result.stdout).toString("utf-8");
  const stderr = Buffer.from(result.stderr).toString("utf-8");
  if (result.exitCode !== 0) {
    throw new Error(
      `Expected entrypoint help command to exit 0 for ${args.join(" ")}, got ${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  return stdout;
}

describe("command surface parity", () => {
  const quickReference = readText(quickReferencePath);

  for (const fixture of COMMAND_SURFACE_FIXTURES) {
    describe(fixture.name, () => {
      const helpOutput = runHelp(fixture.modulePath);
      const workflowDoc = readText(resolve(selftuneRoot, fixture.workflowDocPath));
      const siteDocPath = resolve(workspaceRoot, fixture.siteDocPath);
      const hasSiteDoc = existsSync(siteDocPath);
      const siteDoc = hasSiteDoc ? readText(siteDocPath) : "";

      test("help output includes every registered flag", () => {
        for (const flag of fixture.surface.flags) {
          expect(helpOutput).toContain(flag.token);
        }
      });

      test("workflow doc includes every registered flag", () => {
        for (const flag of fixture.surface.flags) {
          expect(workflowDoc).toContain(flag.token);
        }
      });

      // Site docs live in the monorepo root, not the OSS subtree — skip in OSS-only exports
      test.skipIf(!hasSiteDoc)("site doc includes every registered flag", () => {
        for (const flag of fixture.surface.flags) {
          expect(siteDoc).toContain(flag.token);
        }
      });

      test("quick reference includes the registered synopsis", () => {
        expect(quickReference).toContain(fixture.surface.quickReference);
      });

      test("known stale tokens are absent", () => {
        for (const token of fixture.forbiddenAcrossSurface ?? []) {
          expect(helpOutput).not.toContain(token);
          expect(workflowDoc).not.toContain(token);
          if (hasSiteDoc) expect(siteDoc).not.toContain(token);
          expect(quickReference).not.toContain(token);
        }
        for (const phrase of fixture.forbiddenSitePhrases ?? []) {
          if (hasSiteDoc) expect(siteDoc).not.toContain(phrase);
        }
      });
    });
  }

  test("entrypoint evolve help includes the canonical default command flags", () => {
    const helpOutput = runEntrypointHelp("evolve", "--help");
    for (const flag of PUBLIC_COMMAND_SURFACES.evolve.flags) {
      expect(helpOutput).toContain(flag.token);
    }
    expect(helpOutput).toContain("selftune evolve body");
    expect(helpOutput).toContain("selftune evolve rollback");
  });
});
