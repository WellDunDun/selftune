import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type GithubInstallSourceMetadata,
  deriveGithubInstallSkillName,
  discoverLocalSkillPaths,
  installGithubSkillDirectory,
  parseGithubRegistryInstallTarget,
  resolveGithubSkillPath,
} from "../../packages/runtime/registry/github-install.js";
import { RegistryIdentifierValidationError } from "../../packages/runtime/registry/path-policy.js";

describe("parseGithubRegistryInstallTarget", () => {
  test("parses repo-only targets", () => {
    expect(parseGithubRegistryInstallTarget("github:acme/reviewer")).toEqual({
      owner: "acme",
      repo: "reviewer",
      repoFullName: "acme/reviewer",
      ref: null,
      skillPath: null,
    });
  });

  test("parses refs and monorepo paths", () => {
    expect(
      parseGithubRegistryInstallTarget("github:acme/reviewer//skills/code-review@release-2026"),
    ).toEqual({
      owner: "acme",
      repo: "reviewer",
      repoFullName: "acme/reviewer",
      ref: "release-2026",
      skillPath: "skills/code-review",
    });
  });

  test("preserves slash-delimited refs in either supported ref position", () => {
    expect(
      parseGithubRegistryInstallTarget("github:acme/reviewer@feature/registry-v2"),
    ).toMatchObject({ ref: "feature/registry-v2", skillPath: null });
    expect(
      parseGithubRegistryInstallTarget("github:acme/reviewer//skills/code-review@release/2026/07"),
    ).toMatchObject({ ref: "release/2026/07", skillPath: "skills/code-review" });
  });

  test("rejects absolute and parent-traversing repository paths", () => {
    expect(() => parseGithubRegistryInstallTarget("github:acme/reviewer///etc")).toThrow(
      /relative to the repository/,
    );
    expect(() => parseGithubRegistryInstallTarget("github:acme/reviewer//skills/../..")).toThrow(
      /stay within the repository/,
    );
  });

  test("rejects malformed, empty, duplicate, and option-like refs", () => {
    for (const target of [
      "github:acme/reviewer@",
      "github:acme/reviewer//skills/reviewer@",
      "github:acme/reviewer@main//skills/reviewer@release",
      "github:acme/reviewer@--upload-pack=payload",
      "github:acme/reviewer@feature..branch",
      "github:acme/reviewer@feature@{1}",
      "github:acme/reviewer@feature.lock",
    ]) {
      expect(() => parseGithubRegistryInstallTarget(target)).toThrow();
    }
  });

  test("rejects control characters and dot-segment repository identities", () => {
    expect(() => parseGithubRegistryInstallTarget("github:acme/reviewer//skill\0path")).toThrow(
      /control characters/,
    );
    expect(() => parseGithubRegistryInstallTarget("github:../reviewer")).toThrow(/dot path/);
    expect(() => parseGithubRegistryInstallTarget("github:acme/..")).toThrow(/dot path/);
  });

  test("rejects surrounding target whitespace", () => {
    expect(() => parseGithubRegistryInstallTarget("github:acme/reviewer ")).toThrow(
      /surrounding whitespace/,
    );
  });
});

describe("GitHub install skill discovery", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), "selftune-github-install-test-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("discovers root and nested skill paths", async () => {
    writeFileSync(path.join(repoRoot, "SKILL.md"), "# root", "utf-8");
    mkdirSync(path.join(repoRoot, "skills", "reviewer"), { recursive: true });
    writeFileSync(path.join(repoRoot, "skills", "reviewer", "SKILL.md"), "# nested", "utf-8");

    await expect(discoverLocalSkillPaths(repoRoot)).resolves.toEqual([".", "skills/reviewer"]);
  });

  test("auto-selects the only discovered skill path", async () => {
    mkdirSync(path.join(repoRoot, "skills", "reviewer"), { recursive: true });
    writeFileSync(path.join(repoRoot, "skills", "reviewer", "SKILL.md"), "# nested", "utf-8");

    await expect(resolveGithubSkillPath(repoRoot, null)).resolves.toEqual({
      skillPath: "skills/reviewer",
      availablePaths: ["skills/reviewer"],
    });
  });

  test("requires an explicit path for monorepos", async () => {
    mkdirSync(path.join(repoRoot, "skills", "reviewer"), { recursive: true });
    mkdirSync(path.join(repoRoot, "skills", "planner"), { recursive: true });
    writeFileSync(path.join(repoRoot, "skills", "reviewer", "SKILL.md"), "# reviewer", "utf-8");
    writeFileSync(path.join(repoRoot, "skills", "planner", "SKILL.md"), "# planner", "utf-8");

    await expect(resolveGithubSkillPath(repoRoot, null)).rejects.toThrow(/Multiple skills found/);
  });

  test("rejects an explicit skill path containing a symbolic-link directory", async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), "selftune-github-outside-"));
    try {
      writeFileSync(path.join(outsideDir, "SKILL.md"), "# outside", "utf8");
      symlinkSync(outsideDir, path.join(repoRoot, "linked-skill"), "dir");

      await expect(resolveGithubSkillPath(repoRoot, "linked-skill")).rejects.toThrow(
        /symbolic link/,
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("rejects a symbolic-link SKILL.md before it can be read", async () => {
    const outsideFile = path.join(repoRoot, "outside-skill.md");
    mkdirSync(path.join(repoRoot, "skill"));
    writeFileSync(outsideFile, "# outside", "utf8");
    symlinkSync(outsideFile, path.join(repoRoot, "skill", "SKILL.md"));

    await expect(resolveGithubSkillPath(repoRoot, "skill")).rejects.toThrow(/symbolic link/);
  });
});

describe("GitHub skill directory installation", () => {
  let rootDir: string;
  let sourceDir: string;
  let targetDir: string;

  const metadata: GithubInstallSourceMetadata = {
    source: "github-direct",
    repo: "acme/reviewer",
    ref: "main",
    commit: "0123456789abcdef",
    skill_path: ".",
    available_paths: ["."],
  };

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "selftune-github-copy-test-"));
    sourceDir = path.join(rootDir, "source");
    targetDir = path.join(rootDir, "skills", "reviewer");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "SKILL.md"), "# new", "utf8");
    writeFileSync(path.join(targetDir, "SKILL.md"), "# old", "utf8");
    writeFileSync(path.join(targetDir, "stale.md"), "stale", "utf8");
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  test("stages content and source metadata before replacing the existing target", async () => {
    mkdirSync(path.join(sourceDir, "references"));
    writeFileSync(path.join(sourceDir, "references", "guide.md"), "guide", "utf8");
    writeFileSync(path.join(sourceDir, ".env"), "secret", "utf8");
    mkdirSync(path.join(sourceDir, "node_modules"));
    writeFileSync(path.join(sourceDir, "node_modules", "ignored.js"), "ignored", "utf8");

    await installGithubSkillDirectory({ sourceDir, targetDir, metadata });

    expect(readFileSync(path.join(targetDir, "SKILL.md"), "utf8")).toBe("# new");
    expect(readFileSync(path.join(targetDir, "references", "guide.md"), "utf8")).toBe("guide");
    expect(existsSync(path.join(targetDir, "stale.md"))).toBe(false);
    expect(existsSync(path.join(targetDir, ".env"))).toBe(false);
    expect(existsSync(path.join(targetDir, "node_modules"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(targetDir, ".selftune-source.json"), "utf8"))).toEqual(
      metadata,
    );
    expect(
      readdirSync(path.dirname(targetDir)).filter((entry) => entry.includes("selftune-")),
    ).toEqual([]);
  });

  test("preserves an explicitly selected skill root whose basename is normally excluded", async () => {
    const explicitlySelectedDir = path.join(rootDir, "nested", "node_modules");
    const explicitTarget = path.join(rootDir, "skills", "explicit");
    mkdirSync(explicitlySelectedDir, { recursive: true });
    writeFileSync(path.join(explicitlySelectedDir, "SKILL.md"), "# explicit", "utf8");

    await installGithubSkillDirectory({
      sourceDir: explicitlySelectedDir,
      targetDir: explicitTarget,
      metadata,
    });

    expect(readFileSync(path.join(explicitTarget, "SKILL.md"), "utf8")).toBe("# explicit");
  });

  test("rejects absolute, relative, and dangling symlinks without touching the target", async () => {
    for (const [name, linkTarget] of [
      ["absolute", path.join(rootDir, "outside")],
      ["relative", "../../outside"],
      ["dangling", "missing-file"],
    ]) {
      symlinkSync(linkTarget, path.join(sourceDir, name));
    }

    await expect(installGithubSkillDirectory({ sourceDir, targetDir, metadata })).rejects.toThrow(
      /symbolic link/,
    );
    expect(readFileSync(path.join(targetDir, "SKILL.md"), "utf8")).toBe("# old");
    expect(readFileSync(path.join(targetDir, "stale.md"), "utf8")).toBe("stale");
  });

  test("rejects hardlinks without touching the target", async () => {
    const sourceFile = path.join(sourceDir, "reference.md");
    writeFileSync(sourceFile, "reference", "utf8");
    linkSync(sourceFile, path.join(sourceDir, "reference-copy.md"));

    await expect(installGithubSkillDirectory({ sourceDir, targetDir, metadata })).rejects.toThrow(
      /hard link/,
    );
    expect(readFileSync(path.join(targetDir, "SKILL.md"), "utf8")).toBe("# old");
  });

  test("rejects special filesystem entries without touching the target", async () => {
    const fifoPath = path.join(sourceDir, "skill.pipe");
    const mkfifo = Bun.spawn(["mkfifo", fifoPath], { stdout: "ignore", stderr: "pipe" });
    const stderr = new Response(mkfifo.stderr).text();
    await mkfifo.exited;
    if (mkfifo.exitCode !== 0) {
      throw new Error(`failed to create test fifo: ${await stderr}`);
    }

    await expect(installGithubSkillDirectory({ sourceDir, targetDir, metadata })).rejects.toThrow(
      /special filesystem entry/,
    );
    expect(readFileSync(path.join(targetDir, "SKILL.md"), "utf8")).toBe("# old");
  });
});

describe("deriveGithubInstallSkillName", () => {
  test("rejects traversal from frontmatter before it can become an install path", () => {
    expect(() =>
      deriveGithubInstallSkillName("../../outside", ".", path.join("/tmp", "repo"), "reviewer"),
    ).toThrow(RegistryIdentifierValidationError);
  });

  test("falls back to the repository name for root installs without frontmatter", () => {
    expect(deriveGithubInstallSkillName("", ".", path.join("/tmp", "repo"), "reviewer")).toBe(
      "reviewer",
    );
  });

  test("uses the directory basename for nested installs without frontmatter", () => {
    expect(
      deriveGithubInstallSkillName(
        "",
        "skills/reviewer",
        path.join("/tmp", "repo", "skills", "reviewer"),
        "acme-repo",
      ),
    ).toBe("reviewer");
  });
});
