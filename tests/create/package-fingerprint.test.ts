import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeCreatePackageFingerprint } from "../../packages/runtime/create/package-fingerprint.js";

describe("create package fingerprint", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changes when tracked package content changes", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-package-fingerprint-"));
    tempDirs.push(root);

    const skillDir = join(root, "research-assistant");
    mkdirSync(join(skillDir, "workflows"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: research-assistant
description: >
  Use when the user needs evidence-backed research help.
---

# Research Assistant
`,
      "utf-8",
    );
    writeFileSync(join(skillDir, "selftune.create.json"), JSON.stringify({ version: 1 }), "utf-8");
    writeFileSync(join(skillDir, "workflows", "default.md"), "# Default\n", "utf-8");

    const before = computeCreatePackageFingerprint(join(skillDir, "SKILL.md"));
    writeFileSync(join(skillDir, "workflows", "default.md"), "# Updated workflow\n", "utf-8");
    const after = computeCreatePackageFingerprint(join(skillDir, "SKILL.md"));

    expect(before).toMatch(/^pkg_sha256_/);
    expect(after).toMatch(/^pkg_sha256_/);
    expect(after).not.toBe(before);
  });
});
