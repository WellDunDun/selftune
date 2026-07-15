import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertReleaseTagMatchesVersion,
  bumpCoupledReleasePatch,
  compareStableReleaseVersions,
  readCoupledReleaseVersion,
  syncCoupledReleaseVersionFromDesktop,
  validateStableReleaseVersion,
} from "../../scripts/release-version";
import { validateReleaseTag, validateReleaseVersion } from "../../scripts/validate-release-ref";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const workflowText = (name: string): string =>
  readFileSync(resolve(repositoryRoot, ".github/workflows", name), "utf8");
const workflow = (name: string): unknown => Bun.YAML.parse(workflowText(name));
const repositoryJson = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));

function createReleaseRepository(rootVersion: string, desktopVersion = rootVersion): string {
  const root = mkdtempSync(join(tmpdir(), "selftune-release-version-"));
  mkdirSync(join(root, "apps/desktop"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "selftune", version: rootVersion }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "apps/desktop/package.json"),
    `${JSON.stringify(
      { name: "@selftune/desktop", private: true, version: desktopVersion },
      null,
      2,
    )}\n`,
  );
  return root;
}

describe("release version invariant", () => {
  test("accepts SemVer inputs but limits promoted releases to stable versions", () => {
    expect(validateReleaseVersion("1.2.3")).toBe("1.2.3");
    expect(validateReleaseVersion("1.2.3-beta.4+build.5")).toBe("1.2.3-beta.4+build.5");
    expect(validateReleaseTag("v1.2.3")).toBe("v1.2.3");
    expect(validateStableReleaseVersion("1.2.3")).toBe("1.2.3");

    expect(() => validateStableReleaseVersion("1.2.3-beta.4")).toThrow("Stable releases");
    expect(() => validateStableReleaseVersion("1.2.3+build.5")).toThrow("Stable releases");
    expect(() => validateReleaseVersion("v1.2.3")).toThrow();
    expect(() => validateReleaseVersion("1.2")).toThrow();
    expect(() => validateReleaseTag("1.2.3")).toThrow();
    expect(() => validateReleaseTag("v1.2.3; echo unsafe")).toThrow();
    expect(() => validateReleaseTag("v01.2.3")).toThrow();
  });

  test("compares stable versions numerically without shell sort ambiguity", () => {
    expect(compareStableReleaseVersions("1.10.0", "1.9.99")).toBe(1);
    expect(compareStableReleaseVersions("2.0.0", "10.0.0")).toBe(-1);
    expect(compareStableReleaseVersions("3.4.5", "3.4.5")).toBe(0);
    expect(
      compareStableReleaseVersions(
        "999999999999999999999999.0.0",
        "999999999999999999999998.999.999",
      ),
    ).toBe(1);
  });

  test("keeps the checked-in root and desktop package versions coupled", () => {
    const rootPackage: unknown = repositoryJson("package.json");
    expect(rootPackage).toMatchObject({ version: readCoupledReleaseVersion(repositoryRoot) });
  });

  test("bumps root and desktop package versions together", () => {
    const root = createReleaseRepository("1.2.3");
    try {
      expect(bumpCoupledReleasePatch(root)).toBe("1.2.4");
      expect(readCoupledReleaseVersion(root)).toBe("1.2.4");
      const desktop: unknown = JSON.parse(
        readFileSync(join(root, "apps/desktop/package.json"), "utf8"),
      );
      expect(desktop).toEqual({ name: "@selftune/desktop", private: true, version: "1.2.4" });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("adopts the Changesets-owned desktop version for the coupled release", () => {
    const root = createReleaseRepository("1.2.3", "1.2.4");
    try {
      expect(syncCoupledReleaseVersionFromDesktop(root)).toBe("1.2.4");
      expect(readCoupledReleaseVersion(root)).toBe("1.2.4");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects package version drift before a release", () => {
    const root = createReleaseRepository("1.2.3", "1.2.2");
    try {
      expect(() => readCoupledReleaseVersion(root)).toThrow("Release version drift");
      expect(() => bumpCoupledReleasePatch(root)).toThrow("Release version drift");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("requires the release tag to match both package manifests", () => {
    const root = createReleaseRepository("1.2.3");
    try {
      expect(assertReleaseTagMatchesVersion("v1.2.3", root)).toBe("1.2.3");
      expect(() => assertReleaseTagMatchesVersion("v1.2.4", root)).toThrow(
        "does not match package version",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("Changesets release ownership", () => {
  test("uses the workspace-visible desktop package to version the coupled release train", () => {
    expect(repositoryJson("package.json")).toMatchObject({
      name: "selftune",
      workspaces: expect.arrayContaining(["apps/*", "packages/*", "packages/*/*"]),
    });
    expect(repositoryJson(".changeset/config.json")).toMatchObject({
      access: "public",
      baseBranch: "main",
      fixed: [],
      privatePackages: { tag: false, version: true },
    });
    expect(workflow("publish.yml")).toMatchObject({
      jobs: {
        "release-pr": {
          needs: "test",
          outputs: { has_changesets: "${{ steps.changesets.outputs.hasChangesets }}" },
          permissions: { actions: "write", contents: "write", "pull-requests": "write" },
        },
      },
    });
    const publish = workflowText("publish.yml");
    expect(publish).toContain(
      "uses: changesets/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d # v1.9.0",
    );
    expect(publish).toContain("GITHUB_TOKEN: ${{ secrets.RELEASE_PAT || github.token }}");
    expect(publish).toContain("version: bun run changeset:version");
    expect(repositoryJson("package.json")).toMatchObject({
      scripts: {
        "changeset:version": expect.stringContaining("release-version.ts sync-from-desktop"),
      },
    });
    expect(publish).toContain("steps.changesets.outputs.pullRequestNumber");
    expect(publish).toContain('gh workflow run ci.yml --ref "$head_ref"');
    expect(workflow("ci.yml")).toMatchObject({
      on: { pull_request: { branches: ["main"] }, workflow_dispatch: {} },
    });
  });

  test("requires changesets read-only for every shipped pull-request surface", () => {
    expect(workflow("auto-bump-cli-version.yml")).toMatchObject({
      name: "Changeset Required",
      on: {
        pull_request: {
          paths: expect.arrayContaining([
            ".dockerignore",
            ".npmignore",
            ".github/workflows/ci.yml",
            "CHANGELOG.md",
            "README.md",
            "apps/desktop/**",
            "apps/cli/**",
            "apps/local/**",
            "apps/local-dashboard/**",
            "apps/selfhost/**",
            "assets/**",
            "bin/**",
            "bun.lock",
            "cli/selftune/**",
            "package.json",
            "packages/control-plane/**",
            "packages/dashboard-core/**",
            "packages/harnesses/**",
            "packages/orchestration/**",
            "packages/runtime/**",
            "packages/telemetry-contract/**",
            "packages/ui/**",
            "scripts/pack-package.ts",
            "scripts/smoke-packed-package.ts",
            "skill/**",
            "templates/**",
          ]),
        },
      },
      permissions: { contents: "read" },
    });
    const changesetGate = workflowText("auto-bump-cli-version.yml");
    expect(changesetGate).toContain("bunx changeset status");
    expect(changesetGate).toContain("'@selftune/desktop'");
    expect(changesetGate).toContain("github.head_ref == 'changeset-release/main'");
    expect(changesetGate).not.toContain("bump-patch");
    expect(changesetGate).not.toContain("git push");
  });

  test("routes workspace suites through their native test and typecheck commands", () => {
    for (const name of ["ci.yml", "publish.yml"]) {
      const source = workflowText(name);
      expect(source).toContain("bun run test");
      expect(source).toContain("bun run typecheck");
      expect(source).not.toContain("bun test tests/ packages/telemetry-contract/");
    }
  });
});

describe("parsed release workflow graph", () => {
  test("serializes post-merge releases and gates npm on both immutable candidates", () => {
    expect(workflow("publish.yml")).toMatchObject({
      on: {
        push: { branches: ["main"] },
        workflow_dispatch: {
          inputs: { repair_release: { default: false, type: "boolean" } },
        },
      },
      concurrency: { "cancel-in-progress": false, group: "publish-selftune" },
      jobs: {
        "desktop-candidate": {
          needs: "prepare-release",
          uses: "./.github/workflows/desktop.yml",
          with: {
            release_tag: "${{ needs.prepare-release.outputs.tag }}",
            source_sha: "${{ needs.prepare-release.outputs.source_sha }}",
          },
        },
        "prepare-release": { needs: "release-pr" },
        "publish-npm": {
          needs: ["prepare-release", "desktop-candidate", "selfhost-candidate"],
        },
        "selfhost-candidate": {
          needs: "prepare-release",
          uses: "./.github/workflows/selfhost-image.yml",
          with: {
            release_tag: "${{ needs.prepare-release.outputs.tag }}",
            source_sha: "${{ needs.prepare-release.outputs.source_sha }}",
          },
        },
        "promote-release": {
          needs: ["prepare-release", "desktop-candidate", "selfhost-candidate", "publish-npm"],
        },
      },
    });

    const publish = workflowText("publish.yml");
    expect(publish.indexOf("needs.desktop-candidate.result == 'success'")).toBeLessThan(
      publish.indexOf("npm publish"),
    );
    expect(publish).toContain('test "$(git rev-parse "refs/tags/$RELEASE_TAG^{commit}")"');
    expect(publish).toContain("npm install --global npm@11");
    expect(publish).toContain("gh workflow run ci.yml");
  });

  test("defines immutable reusable desktop and self-host release inputs", () => {
    const immutableInputs = {
      release_tag: { required: true, type: "string" },
      source_sha: { required: true, type: "string" },
    };
    expect(workflow("desktop.yml")).toMatchObject({
      on: {
        workflow_call: { inputs: immutableInputs },
        workflow_dispatch: { inputs: immutableInputs },
      },
      jobs: { "attach-release": { needs: "build" } },
    });
    expect(workflow("selfhost-image.yml")).toMatchObject({
      on: {
        workflow_call: {
          inputs: immutableInputs,
          outputs: {
            image_ref: { value: "${{ jobs.publish-release-manifest.outputs.image_ref }}" },
            manifest_digest: {
              value: "${{ jobs.publish-release-manifest.outputs.manifest_digest }}",
            },
          },
        },
        workflow_dispatch: { inputs: immutableInputs },
      },
      jobs: {
        "publish-release-manifest": {
          needs: ["verify", "build-release-digest"],
        },
      },
    });
  });

  test("keeps exact image and packaged-app smoke gates before promotion", () => {
    const desktop = workflowText("desktop.yml");
    const selfhost = workflowText("selfhost-image.yml");

    expect(desktop).toContain("smoke:packaged");
    expect(desktop).toContain("codesign --verify --deep --strict");
    expect(desktop).toContain("spctl --assess --type execute");
    expect(desktop).toContain("xcrun stapler validate");
    expect(selfhost).toContain("push-by-digest=true");
    expect(selfhost).toContain("smoke-selfhost-image.sh");
    expect(selfhost).toContain('"${REGISTRY_IMAGE}@${DIGEST}"');
    expect(selfhost).toContain("--metadata-file /tmp/selfhost-release-metadata.json");
  });

  test("confines the Linux sandbox waiver to both unpacked packaged-smoke launches", () => {
    const packagedSmoke = readFileSync(
      resolve(repositoryRoot, "apps/desktop/scripts/smoke-packaged.ts"),
      "utf8",
    );
    expect(packagedSmoke).toContain('process.platform === "linux" ? ["--no-sandbox"] : []');
    expect(packagedSmoke.match(/packagedApplicationArgs\(userDataDir\)/gu)).toHaveLength(2);
    expect(workflowText("desktop.yml")).not.toContain("--no-sandbox");
    expect(
      readFileSync(resolve(repositoryRoot, "apps/desktop/src/main/index.ts"), "utf8"),
    ).not.toContain("--no-sandbox");
  });

  test("gives stable-channel promotion to the parent workflow only", () => {
    const publish = workflowText("publish.yml");
    const desktop = workflowText("desktop.yml");
    const selfhost = workflowText("selfhost-image.yml");

    expect(publish).toContain('gh release edit "$RELEASE_TAG" --draft=false --latest');
    expect(publish).toContain('--tag "${REGISTRY_IMAGE}:latest"');
    expect(publish).toContain("compare-stable");
    expect(desktop).not.toContain("--draft=false");
    expect(desktop).not.toContain("--latest");
    expect(selfhost).not.toContain('"${REGISTRY_IMAGE}:latest"');
  });
});
