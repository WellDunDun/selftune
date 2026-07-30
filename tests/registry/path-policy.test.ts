import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  RegistryIdentifierValidationError,
  RegistryPathConfinementError,
  resolveRegistryInstallPath,
  validatePersistedRegistryInstallPath,
  validateRegistrySkillName,
  validateRegistryVersion,
} from "../../packages/runtime/registry/path-policy.js";

describe("registry identifier validation", () => {
  test("accepts skill slugs and semantic versions", () => {
    expect(validateRegistrySkillName("thermonuclear-review.v2")).toBe("thermonuclear-review.v2");
    expect(validateRegistryVersion("2.1.0-beta.1+build_4")).toBe("2.1.0-beta.1+build_4");
  });

  test.each(["../reviewer", "nested/reviewer", "nested\\reviewer", "/tmp/reviewer", " reviewer"])(
    "rejects unsafe skill name %s with a typed error",
    (skillName) => {
      expect(() => validateRegistrySkillName(skillName)).toThrow(RegistryIdentifierValidationError);
    },
  );

  test.each(["../1.0.0", "release/1", " release-1"])(
    "rejects unsafe version %s with a typed error",
    (version) => {
      expect(() => validateRegistryVersion(version)).toThrow(RegistryIdentifierValidationError);
    },
  );
});

describe("registry install path confinement", () => {
  test("resolves a validated skill directly below its install root", () => {
    const installRoot = path.join("/workspace", ".claude", "skills");
    expect(resolveRegistryInstallPath(installRoot, "reviewer")).toBe(
      path.join(installRoot, "reviewer"),
    );
  });

  test("accepts an exact persisted project skill path", () => {
    const installPath = path.join("/workspace", ".claude", "skills", "reviewer");
    expect(validatePersistedRegistryInstallPath(installPath, "reviewer")).toEqual({
      installRoot: path.dirname(installPath),
      targetDir: installPath,
    });
  });

  test.each([
    ["/tmp/reviewer", "reviewer"],
    ["/workspace/.claude/skills/other", "reviewer"],
    ["relative/.claude/skills/reviewer", "reviewer"],
  ])("rejects untrusted persisted path %s", (installPath, skillName) => {
    expect(() => validatePersistedRegistryInstallPath(installPath, skillName)).toThrow(
      RegistryPathConfinementError,
    );
  });
});
