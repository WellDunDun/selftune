/**
 * Guards the publish pipeline for @selftune/telemetry-contract.
 *
 * In the repo, internal dependencies use workspace:* while external runtime
 * libraries are owned by the root package rather than repeated in private
 * bundled workspace manifests. At publish time, the prepack script pins bundled
 * package versions and flattens their internal dependency metadata. The
 * release pack command also isolates nested workspace installs before npm
 * snapshots the package tree and restores them afterward.
 *
 * This test exists because coding agents repeatedly break this setup.
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

describe("publish dependency protocol", () => {
  test("the root and bundled workspaces agree on external runtimes", () => {
    const expectedRuntimes = new Map([
      ["apps/local/package.json", { effect: "4.0.0-beta.66" }],
      ["packages/control-plane/package.json", { effect: "4.0.0-beta.66" }],
      ["packages/orchestration/package.json", { effect: "4.0.0-beta.66" }],
      ["packages/runtime/package.json", { effect: "4.0.0-beta.66" }],
      ["packages/telemetry-contract/package.json", { zod: "^4.3.6" }],
    ]);

    const rootManifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    for (const [relativePath, runtimes] of expectedRuntimes) {
      const manifest = JSON.parse(readFileSync(join(ROOT, relativePath), "utf-8"));
      for (const [name, version] of Object.entries(runtimes)) {
        expect(manifest.dependencies?.[name]).toBe(version);
        expect(rootManifest.dependencies?.[name]).toBe(version);
      }
    }
  });

  test("root package.json uses workspace:* for telemetry-contract in dev", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    const spec = pkg.dependencies?.["@selftune/telemetry-contract"];

    if (spec !== "workspace:*") {
      throw new Error(
        `dependencies.@selftune/telemetry-contract must be "workspace:*" in the repo (prepack pins its bundled version at publish time). Got: ${spec}. Next: edit package.json and run bun test tests/trust-floor/publish-deps.test.ts`,
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
        `Missing scripts/publish-package-json.cjs. This script prepares bundled workspace packages for npm. Next: restore the file and run bun test tests/trust-floor/publish-deps.test.ts`,
      );
    }
  });

  test("release pack script file exists", () => {
    const scriptPath = join(ROOT, "scripts/pack-package.ts");
    if (!existsSync(scriptPath)) {
      throw new Error(
        `Missing scripts/pack-package.ts. This script must prepare the workspace before npm snapshots package contents. Next: restore the file and run bun test tests/trust-floor/publish-deps.test.ts`,
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

  test("prepack pins the bundled dependency and restores every manifest", () => {
    const rootBefore = readFileSync(join(ROOT, "package.json"), "utf-8");
    const contractPath = join(ROOT, "packages/telemetry-contract/package.json");
    const contractBefore = readFileSync(contractPath, "utf-8");
    execSync("node scripts/publish-package-json.cjs prepare", {
      cwd: ROOT,
      env: { ...process.env, SELFTUNE_PUBLISH_SKIP_NODE_MODULES: "1" },
      stdio: "pipe",
    });
    try {
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
      const spec = pkg.dependencies?.["@selftune/telemetry-contract"];
      const contract = JSON.parse(readFileSync(contractPath, "utf-8"));
      if (spec !== contract.version) {
        throw new Error(
          `After prepack, dependencies.@selftune/telemetry-contract must match its bundled version. Got: ${spec}. Next: fix scripts/publish-package-json.cjs and run bun test tests/trust-floor/publish-deps.test.ts`,
        );
      }
      expect(contract.dependencies).toBeUndefined();
      expect(contract.devDependencies).toBeUndefined();
      expect(contract.peerDependencies?.zod).toBe("^4.3.6");
      expect(contract.files).toContain("index.ts");
    } finally {
      execSync("node scripts/publish-package-json.cjs restore", { cwd: ROOT, stdio: "pipe" });
    }
    expect(readFileSync(join(ROOT, "package.json"), "utf-8")).toBe(rootBefore);
    expect(readFileSync(contractPath, "utf-8")).toBe(contractBefore);
  });

  test("publish workflow does not parse raw npm pack JSON from stdout", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf-8");

    if (workflow.includes("npm pack --json | node -p")) {
      throw new Error(
        "Publish workflow must not parse raw `npm pack --json` stdout. Lifecycle scripts write noise to stdout and break JSON parsing. Next: compute the tarball name from package.json or parse a captured file robustly.",
      );
    }

    if (!workflow.includes("bun run pack:release >/dev/null")) {
      throw new Error(
        "Publish workflow should use the isolated release pack command without depending on stdout parsing. Next: update .github/workflows/publish.yml to run bun run pack:release.",
      );
    }
    if (
      !workflow.includes(
        'bun run scripts/smoke-packed-package.ts "${{ steps.pack.outputs.tarball }}"',
      )
    ) {
      throw new Error(
        "Publish workflow must install and execute the exact tarball before publishing it. Next: restore the package smoke step in .github/workflows/publish.yml.",
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
