/**
 * Guards the publish pipeline for @selftune/telemetry-contract.
 *
 * In the repo, package.json uses workspace:* so bun's lockfile stays clean.
 * At publish time, the prepack script rewrites it to file: so npm/bun can
 * install from the registry. postpack restores workspace:* afterward.
 *
 * This test exists because coding agents repeatedly break this setup.
 */

import { describe, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

describe("publish dependency protocol", () => {
  test("root package.json uses workspace:* for telemetry-contract in dev", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    const spec = pkg.dependencies?.["@selftune/telemetry-contract"];

    if (spec !== "workspace:*") {
      throw new Error(
        `dependencies.@selftune/telemetry-contract must be "workspace:*" in the repo (prepack rewrites to file: at publish time). Got: ${spec}. Next: edit package.json and run bun test tests/trust-floor/publish-deps.test.ts`,
      );
    }
  });

  test("prepack and postpack scripts exist in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

    if (!pkg.scripts?.prepack?.includes("publish-package-json.cjs")) {
      throw new Error(
        `Missing prepack script. Must run "node scripts/publish-package-json.cjs prepare". Next: restore the prepack script and run bun test tests/trust-floor/publish-deps.test.ts`,
      );
    }
    if (!pkg.scripts?.postpack?.includes("publish-package-json.cjs")) {
      throw new Error(
        `Missing postpack script. Must run "node scripts/publish-package-json.cjs restore". Next: restore the postpack script and run bun test tests/trust-floor/publish-deps.test.ts`,
      );
    }
  });

  test("publish-package-json.cjs script file exists", () => {
    const scriptPath = join(ROOT, "scripts/publish-package-json.cjs");
    if (!existsSync(scriptPath)) {
      throw new Error(
        `Missing scripts/publish-package-json.cjs. This script rewrites workspace:* to file: at publish time. Next: restore the file and run bun test tests/trust-floor/publish-deps.test.ts`,
      );
    }
  });

  test("bundledDependencies includes telemetry-contract", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    const bundled = pkg.bundledDependencies ?? pkg.bundleDependencies ?? [];

    const dep = "@selftune/telemetry-contract";
    if (!bundled.includes(dep)) {
      throw new Error(
        `bundledDependencies must include "${dep}". Without this, npm's registry manifest exposes the workspace:* protocol and install fails. Got: ${JSON.stringify(bundled)}. Next: add "${dep}" to bundledDependencies in package.json`,
      );
    }
  });

  test("prepack rewrite produces file: protocol in package.json", () => {
    execSync("node scripts/publish-package-json.cjs prepare", { cwd: ROOT, stdio: "pipe" });
    try {
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
      const spec = pkg.dependencies?.["@selftune/telemetry-contract"];
      if (typeof spec !== "string" || !spec.startsWith("file:")) {
        throw new Error(
          `After prepack, dependencies.@selftune/telemetry-contract must start with file:. Got: ${spec}. Next: fix scripts/publish-package-json.cjs and run bun test tests/trust-floor/publish-deps.test.ts`,
        );
      }
    } finally {
      execSync("node scripts/publish-package-json.cjs restore", { cwd: ROOT, stdio: "pipe" });
    }
  });
});
