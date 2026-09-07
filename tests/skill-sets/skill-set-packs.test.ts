import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  decodePortableSkillSetEnvelope,
  SkillSetPackageMetadata,
  type SkillSetDependencyEnvelope,
} from "@selftune/control-plane";

import {
  createSkillSet,
  exportPortableSkillSetPackBytes,
  importPortableSkillSetPack,
} from "@selftune/library";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("portable Skill Set Packs", () => {
  test("round-trips sealed skill contents into an independent local library", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-pack-roundtrip-"));
    temporaryDirectories.push(root);
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    const skillRoot = join(root, "review");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "---\nname: review\ndescription: Review code\nlicense: MIT\n---\n# Review\n",
    );
    writeFileSync(join(skillRoot, "reference.md"), "Pinned reference\n");
    const source = createSkillSet(
      {
        name: "Engineering",
        description: "Pinned engineering workflow",
        harnesses: ["codex"],
        skills: [{ name: "review", package_path: skillRoot }],
      },
      { configRoot: sourceRoot },
    );

    const bytes = exportPortableSkillSetPackBytes(source.set_id, { configRoot: sourceRoot });
    const imported = importPortableSkillSetPack(bytes, { configRoot: targetRoot });

    expect(imported.manifest.name).toBe("Engineering");
    expect(imported.manifest.skills).toHaveLength(1);
    expect(
      readFileSync(join(imported.manifest.skills[0]!.library_package_path, "reference.md"), "utf8"),
    ).toBe("Pinned reference\n");
    expect(imported.sourceRevisionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(imported.objectSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(exportPortableSkillSetPackBytes(source.set_id, { configRoot: sourceRoot })).toEqual(
      bytes,
    );
    const revision = source.skills[0]!.content_hash;
    const dependencyResolution: SkillSetDependencyEnvelope = {
      roots: ["review"],
      available_packages: [
        new SkillSetPackageMetadata({
          package_id: "review",
          version: "1.0.0",
          revision_sha256: revision,
          dependencies: { requires: [], optional: [], conflicts: [] },
          compatibility: { harnesses: ["codex"], required_capabilities: [] },
          provides: [],
        }),
      ],
      environment: { harness: "codex", capabilities: [] },
      lock: {
        entries: [
          {
            package_id: "review",
            version: "1.0.0",
            revision_sha256: revision,
            dependency_kind: "root",
          },
        ],
      },
    };
    const withDependencies = exportPortableSkillSetPackBytes(
      source.set_id,
      { configRoot: sourceRoot },
      dependencyResolution,
    );
    const decoded = Effect.runSync(decodePortableSkillSetEnvelope(withDependencies));
    expect(decoded.envelope.dependencyResolution).toEqual(dependencyResolution);
    expect(
      Effect.runSync(decodePortableSkillSetEnvelope(bytes)).envelope.dependencyResolution,
    ).toBeUndefined();
  });

  test("retains bundled license and notice bindings when no license expression is declared", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-pack-bundled-license-"));
    temporaryDirectories.push(root);
    const skillRoot = join(root, "review");
    const configRoot = join(root, "config");
    mkdirSync(skillRoot);
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\n# Review\n",
    );
    writeFileSync(join(skillRoot, "LICENSE"), "Bundled license terms\n");
    writeFileSync(join(skillRoot, "NOTICE"), "Author attribution\n");
    const manifest = createSkillSet(
      {
        name: "Bundled terms",
        harnesses: ["codex"],
        skills: [{ name: "review", package_path: skillRoot }],
      },
      { configRoot },
    );
    const bytes = exportPortableSkillSetPackBytes(manifest.set_id, { configRoot });
    const decoded = Effect.runSync(decodePortableSkillSetEnvelope(bytes));
    const terms = decoded.envelope.components[0]!.terms;
    expect(terms.licenseExpression).toBe("LicenseRef-Bundled");
    expect(terms.licenseFile?.path).toBe("LICENSE");
    expect(terms.licenseFile?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(terms.notices.map((notice) => notice.path)).toEqual(["NOTICE"]);
    const imported = importPortableSkillSetPack(bytes, { configRoot: join(root, "imported") });
    const installed = imported.manifest.skills[0]!.library_package_path;
    expect(readFileSync(join(installed, "LICENSE"), "utf8")).toBe("Bundled license terms\n");
    expect(readFileSync(join(installed, "NOTICE"), "utf8")).toBe("Author attribution\n");
  });

  test("blocks Pack export when a component has no distributable license evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-pack-unlicensed-"));
    temporaryDirectories.push(root);
    const skillRoot = join(root, "private-skill");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "---\nname: private-skill\ndescription: Internal\n---\n# Private\n",
    );
    const set = createSkillSet(
      {
        name: "Private",
        harnesses: ["codex"],
        skills: [{ name: "private-skill", package_path: skillRoot }],
      },
      { configRoot: join(root, "config") },
    );
    expect(() =>
      exportPortableSkillSetPackBytes(set.set_id, { configRoot: join(root, "config") }),
    ).toThrow("requires a license");
  });
});
