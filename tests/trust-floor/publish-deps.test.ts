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

  test("publish workflow does not parse raw npm pack JSON from stdout", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf-8");

    if (workflow.includes("npm pack --json | node -p")) {
      throw new Error(
        "Publish workflow must not parse raw `npm pack --json` stdout. Lifecycle scripts write noise to stdout and break JSON parsing. Next: compute the tarball name from package.json or parse a captured file robustly.",
      );
    }

    if (!workflow.includes("npm pack >/dev/null")) {
      throw new Error(
        "Publish workflow should pack without depending on stdout parsing. Next: update .github/workflows/publish.yml so npm pack output is not used as a JSON transport.",
      );
    }
  });

  test("publish workflow generates SBOM from the packed tarball in an isolated npm tree", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf-8");

    if (!workflow.includes('tar -xzf "${{ steps.pack.outputs.tarball }}" -C "$TMPDIR"')) {
      throw new Error(
        "Publish workflow should unpack the packed tarball into a temp dir before generating the SBOM. Next: update .github/workflows/publish.yml to generate SBOMs from the packaged artifact instead of the Bun workspace tree.",
      );
    }

    if (
      !workflow.includes("npm install --package-lock-only --ignore-scripts --omit=dev >/dev/null")
    ) {
      throw new Error(
        "Publish workflow should create an isolated npm package-lock before generating the SBOM. Next: run npm install --package-lock-only inside the unpacked tarball directory.",
      );
    }

    if (
      !workflow.includes(
        'npm sbom --sbom-format cyclonedx --package-lock-only --workspaces=false > "$GITHUB_WORKSPACE/sbom.cdx.json"',
      )
    ) {
      throw new Error(
        "Publish workflow should generate the SBOM with `npm sbom --sbom-format cyclonedx --package-lock-only --workspaces=false` from the unpacked tarball. Next: update .github/workflows/publish.yml to use npm sbom in the isolated temp dir.",
      );
    }
  });
});
