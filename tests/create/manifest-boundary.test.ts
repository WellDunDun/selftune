import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCreateManifest } from "../../packages/runtime/create/manifest.js";
import { computeCreatePackageFingerprint } from "../../packages/runtime/create/package-fingerprint.js";
import { loadCreateManifest as loadReadinessManifest } from "../../packages/runtime/create/readiness.js";
import { buildCreateSkillManifest } from "../../packages/runtime/create/templates.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "selftune-create-manifest-"));
  writeFileSync(join(root, "SKILL.md"), "# Example\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("missing manifests retain defaults and the readiness reader shares the same owner", () => {
  expect(loadReadinessManifest).toBe(loadCreateManifest);
  expect(loadCreateManifest(root)).toEqual({
    manifest: buildCreateSkillManifest(),
    present: false,
  });
});

test.each(["not-json", "null", "[]", '"text"', "42"])(
  "ignores invalid manifest root %s without changing its bytes",
  (saved) => {
    const path = join(root, "selftune.create.json");
    const before = computeCreatePackageFingerprint(root);
    writeFileSync(path, saved);
    expect(loadCreateManifest(root)).toEqual({
      manifest: buildCreateSkillManifest(),
      present: false,
    });
    expect(computeCreatePackageFingerprint(root)).toBe(before);
    expect(readFileSync(path, "utf-8")).toBe(saved);
  },
);

test("partial manifests preserve opt-outs and valid resource flags beside invalid neighbors", () => {
  writeFileSync(
    join(root, "selftune.create.json"),
    JSON.stringify({
      version: 99,
      entry_workflow: "  ",
      supports_package_replay: false,
      expected_resources: { workflows: false, references: true, scripts: "yes", assets: true },
    }),
  );
  expect(loadCreateManifest(root)).toEqual({
    present: true,
    manifest: {
      version: 1,
      entry_workflow: "workflows/default.md",
      supports_package_replay: false,
      expected_resources: { workflows: false, references: true, scripts: false, assets: true },
    },
  });
});

test("valid entry workflow is not trimmed and malformed optional values use defaults", () => {
  writeFileSync(
    join(root, "selftune.create.json"),
    JSON.stringify({
      entry_workflow: " workflows/custom.md ",
      supports_package_replay: "false",
      expected_resources: null,
    }),
  );
  expect(loadCreateManifest(root)).toEqual({
    present: true,
    manifest: { ...buildCreateSkillManifest(), entry_workflow: " workflows/custom.md " },
  });
});

test("fingerprints honor disabled resources while tracking enabled neighbors", () => {
  mkdirSync(join(root, "workflows"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "workflows", "default.md"), "Entry workflow");
  writeFileSync(join(root, "workflows", "extra.md"), "Untracked workflow");
  writeFileSync(join(root, "assets", "sample.txt"), "Tracked asset");
  writeFileSync(
    join(root, "selftune.create.json"),
    JSON.stringify({
      expected_resources: { workflows: false, assets: true, references: "invalid" },
    }),
  );
  const before = computeCreatePackageFingerprint(root);
  writeFileSync(join(root, "workflows", "extra.md"), "Changed untracked workflow");
  expect(computeCreatePackageFingerprint(root)).toBe(before);
  writeFileSync(join(root, "assets", "sample.txt"), "Changed tracked asset");
  expect(computeCreatePackageFingerprint(root)).not.toBe(before);
  const withAssetChange = computeCreatePackageFingerprint(root);
  writeFileSync(join(root, "workflows", "default.md"), "Changed entry workflow");
  expect(computeCreatePackageFingerprint(root)).not.toBe(withAssetChange);
});
