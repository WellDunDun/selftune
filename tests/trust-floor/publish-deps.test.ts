/**
 * Guards the publish pipeline for bundled SelfTune workspaces.
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
const developmentOnlyPackageFiles = [
  "!**/*.test.ts",
  "!**/*.test.tsx",
  "!**/*.spec.ts",
  "!**/*.spec.tsx",
  "!**/*.stories.ts",
  "!**/*.stories.tsx",
  "!**/test/**",
  "!**/tests/**",
  "!**/__tests__/**",
];

function extractGenerateSbomStep(workflow: string): string {
  const marker = "      - name: Generate SBOM\n";
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error("Publish workflow is missing the Generate SBOM step.");
  }
  const end = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, end === -1 ? undefined : end);
}

function extractCycloneDxInvocation(workflow: string): string {
  const step = workflow;
  const commandMarker = "cyclonedx-npm/bin/cyclonedx-npm-cli.js";
  const commandLine = step.split("\n").findIndex((line) => line.includes(commandMarker));
  if (commandLine === -1) {
    throw new Error(
      "Publish workflow should invoke the locked CycloneDX npm generator. Next: restore the locked binary invocation in the Generate SBOM step.",
    );
  }

  const lines = step.split("\n").slice(commandLine);
  const command: string[] = [];
  for (const line of lines) {
    command.push(line);
    if (!line.trimEnd().endsWith("\\")) break;
  }
  return command.join("\n");
}

function assertCycloneDxInvocation(workflow: string): void {
  const invocation = extractCycloneDxInvocation(workflow);
  for (const requiredArgument of [
    "--package-lock-only",
    "--omit dev",
    "--no-workspaces",
    "--validate",
    "-v -v",
    '--output-file "$SBOM_OUTPUT"',
  ]) {
    if (!invocation.includes(requiredArgument)) {
      throw new Error(
        `Publish workflow's CycloneDX invocation is missing ${requiredArgument}. Next: restore the complete validated packed-tarball SBOM command.`,
      );
    }
  }
  if (invocation.includes("--ignore-npm-errors")) {
    throw new Error(
      "Publish workflow must not ignore npm resolution errors during SBOM generation. Next: align the bundled dependency ranges and let CycloneDX fail closed.",
    );
  }
}

describe("publish dependency protocol", () => {
  test("the root and bundled workspaces agree on external runtimes", () => {
    const expectedRuntimes = new Map([
      [
        "apps/cli/package.json",
        {
          "@effect/platform-bun": "4.0.0-beta.66",
          "@effect/platform-node-shared": "4.0.0-beta.66",
          effect: "4.0.0-beta.66",
        },
      ],
      ["apps/local/package.json", { "@xmldom/xmldom": "^0.8.13", effect: "4.0.0-beta.66" }],
      ["packages/config/package.json", { effect: "4.0.0-beta.66" }],
      ["packages/control-plane/package.json", { effect: "4.0.0-beta.66" }],
      [
        "packages/observability/package.json",
        { "@duckdb/node-api": "1.4.5-r.1", effect: "4.0.0-beta.66" },
      ],
      ["packages/orchestration/package.json", { effect: "4.0.0-beta.66" }],
      ["packages/runtime/package.json", { "drizzle-orm": "^0.45.0", effect: "4.0.0-beta.66" }],
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

  test("bundled workspaces agree on every shared external dependency range", () => {
    // npm resolves the bundled workspaces' peer ranges when it builds the
    // release SBOM. Two ranges for one external library fail with ERESOLVE
    // after the tarball is already packed, so catch the drift here instead.
    const publishScript = readFileSync(join(ROOT, "scripts/publish-package-json.cjs"), "utf-8");
    const bundledManifests = [
      "package.json",
      ...new Set(
        [...publishScript.matchAll(/path: "((?:apps|packages)\/[^"]+\/package\.json)"/gu)].map(
          (match) => match[1],
        ),
      ),
    ];
    expect(bundledManifests.length).toBeGreaterThan(10);

    const rangesByDependency = new Map<string, Map<string, string[]>>();
    for (const relativePath of bundledManifests) {
      const manifest = JSON.parse(readFileSync(join(ROOT, relativePath), "utf-8"));
      for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
        if (typeof range !== "string" || range.startsWith("workspace:")) continue;
        const ranges = rangesByDependency.get(name) ?? new Map<string, string[]>();
        ranges.set(range, [...(ranges.get(range) ?? []), relativePath]);
        rangesByDependency.set(name, ranges);
      }
    }

    const conflicts = [...rangesByDependency]
      .filter(([, ranges]) => ranges.size > 1)
      .map(
        ([name, ranges]) =>
          `${name}: ${[...ranges].map(([range, paths]) => `${range} (${paths.join(", ")})`).join(" vs ")}`,
      );
    if (conflicts.length > 0) {
      throw new Error(
        `Bundled workspaces declare conflicting ranges for shared external dependencies. npm cannot resolve the packed release and SBOM generation fails. Align the ranges and refresh bun.lock:\n${conflicts.join("\n")}`,
      );
    }
  });

  test("root package.json uses workspace:* for bundled workspaces in dev", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

    for (const dependency of [
      "@selftune/config",
      "@selftune/harness-registry",
      "@selftune/observability",
      "@selftune/telemetry-contract",
    ]) {
      const spec = pkg.dependencies?.[dependency];
      if (spec !== "workspace:*") {
        throw new Error(
          `dependencies.${dependency} must be "workspace:*" in the repo (prepack pins its bundled version at publish time). Got: ${spec}. Next: edit package.json and run bun test tests/trust-floor/publish-deps.test.ts`,
        );
      }
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

  test("package smoke opens DuckDB using the installed target native binding", () => {
    const smoke = readFileSync(join(ROOT, "scripts/smoke-packed-package.ts"), "utf-8");

    for (const expected of [
      '"@duckdb/node-api"',
      '"@duckdb/node-bindings-" + process.platform + "-" + process.arch + "/duckdb.node"',
      '"open DuckDB from packed npm artifact"',
      '"CREATE TABLE packaged_duckdb_probe (value INTEGER)"',
      '"SELECT value FROM packaged_duckdb_probe"',
    ]) {
      if (!smoke.includes(expected)) {
        throw new Error(
          `Package smoke must prove the packed CLI installs @duckdb/node-api with the target native binding and can reopen a file-backed DuckDB store. Missing: ${expected}`,
        );
      }
    }
  });

  test("bundledDependencies includes foundational workspace packages", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    const bundled = pkg.bundledDependencies ?? pkg.bundleDependencies ?? [];

    for (const dependency of [
      "@selftune/config",
      "@selftune/harness-registry",
      "@selftune/observability",
      "@selftune/telemetry-contract",
    ]) {
      if (!bundled.includes(dependency)) {
        throw new Error(
          `bundledDependencies must include "${dependency}". Without this, npm's registry manifest exposes the workspace:* protocol and install fails. Got: ${JSON.stringify(bundled)}. Next: add "${dependency}" to bundledDependencies in package.json`,
        );
      }
    }
  });

  test("prepack pins bundled dependencies and restores every manifest", () => {
    const rootBefore = readFileSync(join(ROOT, "package.json"), "utf-8");
    const configPath = join(ROOT, "packages/config/package.json");
    const harnessRegistryPath = join(ROOT, "packages/harnesses/registry/package.json");
    const observabilityPath = join(ROOT, "packages/observability/package.json");
    const contractPath = join(ROOT, "packages/telemetry-contract/package.json");
    const configBefore = readFileSync(configPath, "utf-8");
    const harnessRegistryBefore = readFileSync(harnessRegistryPath, "utf-8");
    const observabilityBefore = readFileSync(observabilityPath, "utf-8");
    const contractBefore = readFileSync(contractPath, "utf-8");
    execSync("node scripts/publish-package-json.cjs prepare", {
      cwd: ROOT,
      env: { ...process.env, SELFTUNE_PUBLISH_SKIP_NODE_MODULES: "1" },
      stdio: "pipe",
    });
    try {
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
      const configSpec = pkg.dependencies?.["@selftune/config"];
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const harnessRegistrySpec = pkg.dependencies?.["@selftune/harness-registry"];
      const harnessRegistry = JSON.parse(readFileSync(harnessRegistryPath, "utf-8"));
      const observabilitySpec = pkg.dependencies?.["@selftune/observability"];
      const observability = JSON.parse(readFileSync(observabilityPath, "utf-8"));
      const contractSpec = pkg.dependencies?.["@selftune/telemetry-contract"];
      const contract = JSON.parse(readFileSync(contractPath, "utf-8"));

      if (configSpec !== config.version) {
        throw new Error(
          `After prepack, dependencies.@selftune/config must match its bundled version. Got: ${configSpec}. Next: fix scripts/publish-package-json.cjs and run bun test tests/trust-floor/publish-deps.test.ts`,
        );
      }
      if (contractSpec !== contract.version) {
        throw new Error(
          `After prepack, dependencies.@selftune/telemetry-contract must match its bundled version. Got: ${contractSpec}. Next: fix scripts/publish-package-json.cjs and run bun test tests/trust-floor/publish-deps.test.ts`,
        );
      }
      if (harnessRegistrySpec !== harnessRegistry.version) {
        throw new Error(
          `After prepack, dependencies.@selftune/harness-registry must match its bundled version. Got: ${harnessRegistrySpec}. Next: fix scripts/publish-package-json.cjs and run bun test tests/trust-floor/publish-deps.test.ts`,
        );
      }
      if (observabilitySpec !== observability.version) {
        throw new Error(
          `After prepack, dependencies.@selftune/observability must match its bundled version. Got: ${observabilitySpec}. Next: fix scripts/publish-package-json.cjs and run bun test tests/trust-floor/publish-deps.test.ts`,
        );
      }
      expect(config.dependencies).toBeUndefined();
      expect(config.devDependencies).toBeUndefined();
      expect(config.peerDependencies).toBeUndefined();
      expect(config.files).toEqual(["src/**/*.ts", ...developmentOnlyPackageFiles]);
      expect(harnessRegistry.dependencies).toBeUndefined();
      expect(harnessRegistry.devDependencies).toBeUndefined();
      expect(harnessRegistry.peerDependencies).toBeUndefined();
      expect(harnessRegistry.files).toEqual(["src/**/*.ts", ...developmentOnlyPackageFiles]);
      expect(observability.dependencies).toBeUndefined();
      expect(observability.devDependencies).toBeUndefined();
      expect(observability.peerDependencies).toBeUndefined();
      expect(observability.files).toEqual(["src/**/*.ts", ...developmentOnlyPackageFiles]);
      expect(contract.dependencies).toBeUndefined();
      expect(contract.devDependencies).toBeUndefined();
      expect(contract.peerDependencies).toBeUndefined();
      expect(contract.files).toContain("index.ts");
      const localStore = JSON.parse(
        readFileSync(join(ROOT, "packages/local-store/package.json"), "utf-8"),
      );
      expect(localStore.files).toContain("src/drizzle/meta/_journal.json");
      expect(localStore.files).toContain("src/drizzle/**/*.sql");
      expect(localStore.files).not.toContain("src/drizzle/**/*.json");
    } finally {
      execSync("node scripts/publish-package-json.cjs restore", {
        cwd: ROOT,
        stdio: "pipe",
      });
    }
    expect(readFileSync(join(ROOT, "package.json"), "utf-8")).toBe(rootBefore);
    expect(readFileSync(configPath, "utf-8")).toBe(configBefore);
    expect(readFileSync(harnessRegistryPath, "utf-8")).toBe(harnessRegistryBefore);
    expect(readFileSync(observabilityPath, "utf-8")).toBe(observabilityBefore);
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

  test("PR and release use the same fail-closed packed SBOM generator", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf-8");
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf-8");
    const script = readFileSync(join(ROOT, ".github/scripts/generate-sbom.sh"), "utf-8");
    const step = extractGenerateSbomStep(workflow);
    expect(step).toContain("TARBALL_PATH: ${{ steps.pack.outputs.tarball }}");
    expect(step).toContain(
      'bash "$GITHUB_WORKSPACE/.release-workflow/.github/scripts/generate-sbom.sh"',
    );
    expect(workflow).toContain("            .github/scripts\n");
    expect(workflow).toContain(
      'npm ci\n          --prefix "$GITHUB_WORKSPACE/.release-workflow/.github/sbom-toolchain"',
    );
    expect(ci).toContain("bash .github/scripts/generate-sbom.sh");
    expect(ci).toContain("npm ci --prefix .github/sbom-toolchain --ignore-scripts");
    expect(ci).toContain('bun run scripts/smoke-packed-package.ts "$tarball"');
    expect(ci.indexOf("bun run build:dashboard")).toBeLessThan(ci.indexOf("bun run pack:release"));
    expect(ci.indexOf("bun run pack:release")).toBeLessThan(
      ci.indexOf("bash .github/scripts/generate-sbom.sh"),
    );
    expect(script).toContain('tar -xzf "$TARBALL_PATH" -C "$SBOM_TMP"');
    expect(script).toContain(
      "npm install --package-lock-only --ignore-scripts --omit=dev --no-audit --no-fund",
    );
    expect(script).not.toContain("npx ");
    for (const gate of [
      'grep --fixed-strings --quiet "skipped validating BOM" "$SBOM_LOG"',
      'grep --fixed-strings --line-regexp --quiet "INFO  | BOM result appears valid" "$SBOM_LOG"',
      "SBOM root dependency coverage:",
    ])
      expect(script).toContain(gate);
    assertCycloneDxInvocation(script);
  });

  test("publish workflow generates the SBOM before it publishes to npm", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf-8");
    const sbomIndex = workflow.indexOf("      - name: Generate SBOM\n");
    const publishIndex = workflow.indexOf("npm publish ");
    if (sbomIndex === -1 || publishIndex === -1 || sbomIndex > publishIndex) {
      throw new Error(
        "Publish workflow must generate and validate the SBOM before npm publish. An SBOM failure after publish leaves npm ahead of the GitHub release and the self-host image. Next: move the Generate SBOM step ahead of the npm publish step.",
      );
    }
  });

  test("SBOM invocation checks cannot borrow flags from another command", () => {
    const workflow = readFileSync(join(ROOT, ".github/scripts/generate-sbom.sh"), "utf-8");
    const mutatedWorkflow = workflow.replace(
      "  --package-lock-only \\\n  --omit dev",
      "  --omit dev",
    );

    expect(mutatedWorkflow).not.toBe(workflow);
    expect(() => assertCycloneDxInvocation(mutatedWorkflow)).toThrow(
      "Publish workflow's CycloneDX invocation is missing --package-lock-only. Next: restore the complete validated packed-tarball SBOM command.",
    );
  });

  test("SBOM generator dependencies are exactly locked with registry integrity", () => {
    const toolchain = JSON.parse(
      readFileSync(join(ROOT, ".github/sbom-toolchain/package.json"), "utf-8"),
    );
    const lock = JSON.parse(
      readFileSync(join(ROOT, ".github/sbom-toolchain/package-lock.json"), "utf-8"),
    );

    expect(toolchain.dependencies?.["@cyclonedx/cyclonedx-npm"]).toBe("6.0.0");
    expect(toolchain.dependencies?.ajv).toBe("8.20.0");
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages?.["node_modules/@cyclonedx/cyclonedx-npm"]?.version).toBe("6.0.0");

    for (const [path, dependency] of Object.entries<Record<string, string>>(lock.packages ?? {})) {
      if (!path || dependency.link || !dependency.resolved?.startsWith("https://")) continue;
      if (!dependency.integrity?.startsWith("sha512-")) {
        throw new Error(
          `SBOM toolchain dependency ${path} is missing a locked sha512 registry integrity. Next: regenerate and review .github/sbom-toolchain/package-lock.json.`,
        );
      }
    }
  });
});
