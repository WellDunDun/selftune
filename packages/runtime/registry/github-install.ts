import { execFile } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { stageDirectoryReplacement } from "./directory-install.js";
import { resolveRegistryInstallPath, validateRegistrySkillName } from "./path-policy.js";

const execFileAsync = promisify(execFile);
const MAX_GITHUB_TARGET_LENGTH = 2_048;
const MAX_GITHUB_REF_LENGTH = 255;
const MAX_GITHUB_SKILL_PATH_LENGTH = 1_024;

export interface GithubRegistryInstallTarget {
  owner: string;
  repo: string;
  repoFullName: string;
  ref: string | null;
  skillPath: string | null;
}

function containsControlCharacter(value: string, includeSpace: boolean): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= (includeSpace ? 0x20 : 0x1f) || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function containsForbiddenRefCharacter(value: string): boolean {
  for (const character of value) {
    if (containsControlCharacter(character, true) || "~^:?*[\\".includes(character)) {
      return true;
    }
  }
  return false;
}

function normalizeGithubSkillPath(skillPath: string): string {
  const unmodified = skillPath.trim();
  if (unmodified !== skillPath || containsControlCharacter(unmodified, false)) {
    throw new Error(
      "GitHub skill path cannot contain surrounding whitespace or control characters",
    );
  }
  if (unmodified.length > MAX_GITHUB_SKILL_PATH_LENGTH) {
    throw new Error(`GitHub skill path cannot exceed ${MAX_GITHUB_SKILL_PATH_LENGTH} characters`);
  }

  const trimmed = unmodified.replace(/\\/g, "/");
  if (!trimmed || trimmed === ".") {
    return ".";
  }
  if (path.posix.isAbsolute(trimmed)) {
    throw new Error("GitHub skill path must be relative to the repository");
  }

  const segments = trimmed.split("/").filter(Boolean);
  if (segments.includes("..")) {
    throw new Error("GitHub skill path must stay within the repository");
  }

  const normalized = path.posix.normalize(trimmed).replace(/\/+$/g, "");
  return normalized || ".";
}

function validateGithubRef(ref: string): string {
  const components = ref.split("/");
  if (
    !ref ||
    ref.length > MAX_GITHUB_REF_LENGTH ||
    ref !== ref.trim() ||
    ref === "@" ||
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    containsForbiddenRefCharacter(ref) ||
    components.some(
      (component) =>
        !component || component.startsWith(".") || component.toLowerCase().endsWith(".lock"),
    )
  ) {
    throw new Error("GitHub ref is not a valid branch or tag name");
  }
  return ref;
}

export function parseGithubRegistryInstallTarget(
  rawTarget: string,
): GithubRegistryInstallTarget | null {
  if (!rawTarget.startsWith("github:")) {
    return null;
  }
  if (rawTarget.length > MAX_GITHUB_TARGET_LENGTH) {
    throw new Error(`GitHub install target cannot exceed ${MAX_GITHUB_TARGET_LENGTH} characters`);
  }

  const rawSpec = rawTarget.slice("github:".length);
  const spec = rawSpec.trim();
  if (spec !== rawSpec) {
    throw new Error("GitHub install target cannot contain surrounding whitespace");
  }
  if (!spec) {
    throw new Error("GitHub install target must be github:owner/repo[@ref][//path]");
  }

  const pathSeparatorIndex = spec.indexOf("//");
  const repoWithMaybeRef = pathSeparatorIndex === -1 ? spec : spec.slice(0, pathSeparatorIndex);
  const pathWithMaybeRef = pathSeparatorIndex === -1 ? null : spec.slice(pathSeparatorIndex + 2);

  let ref: string | null = null;
  let repoSpec = repoWithMaybeRef;

  const repoRefIndex = repoWithMaybeRef.indexOf("@");
  const hasRepoRef = repoRefIndex !== -1;
  if (hasRepoRef && repoRefIndex !== repoWithMaybeRef.lastIndexOf("@")) {
    throw new Error("GitHub install target contains an ambiguous repository ref");
  }
  if (repoRefIndex !== -1) {
    repoSpec = repoWithMaybeRef.slice(0, repoRefIndex);
    const encodedRef = repoWithMaybeRef.slice(repoRefIndex + 1);
    if (!encodedRef) {
      throw new Error("GitHub install target contains an empty ref");
    }
    ref = validateGithubRef(encodedRef);
  }

  let skillPath: string | null = null;
  if (pathWithMaybeRef != null) {
    const pathRefIndex = pathWithMaybeRef.lastIndexOf("@");
    if (pathRefIndex !== -1) {
      if (pathWithMaybeRef.indexOf("@") !== pathRefIndex) {
        throw new Error("GitHub install target contains an ambiguous path ref");
      }
      if (hasRepoRef) {
        throw new Error("GitHub install target must specify its ref only once");
      }
      skillPath = pathWithMaybeRef.slice(0, pathRefIndex) || ".";
      const encodedRef = pathWithMaybeRef.slice(pathRefIndex + 1);
      if (!encodedRef) {
        throw new Error("GitHub install target contains an empty ref");
      }
      ref = validateGithubRef(encodedRef);
    } else {
      skillPath = pathWithMaybeRef || ".";
    }
  }

  const match = repoSpec.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) {
    throw new Error("GitHub install target must look like github:owner/repo[@ref][//path]");
  }
  if (match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    throw new Error("GitHub owner and repository names cannot be dot path segments");
  }

  return {
    owner: match[1],
    repo: match[2],
    repoFullName: `${match[1]}/${match[2]}`,
    ref,
    skillPath: skillPath ? normalizeGithubSkillPath(skillPath) : null,
  };
}

function isExcludedEntry(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === ".env" || name.startsWith(".env.");
}

function unsafeFilesystemEntry(relativePath: string, kind: string): Error {
  return new Error(`GitHub skill contains unsupported ${kind}: ${relativePath}`);
}

async function assertRegularGithubFile(pathname: string, relativePath: string): Promise<void> {
  const entry = await lstat(pathname);
  if (entry.isSymbolicLink()) {
    throw unsafeFilesystemEntry(relativePath, "symbolic link");
  }
  if (!entry.isFile()) {
    throw unsafeFilesystemEntry(relativePath, "filesystem entry");
  }
  if (entry.nlink > 1) {
    throw unsafeFilesystemEntry(relativePath, "hard link");
  }
}

async function assertGithubRepositoryRoot(repoDir: string): Promise<void> {
  const rootEntry = await lstat(repoDir);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw unsafeFilesystemEntry(".", "repository root");
  }
}

async function assertGithubSkillPath(repoDir: string, skillPath: string): Promise<string> {
  await assertGithubRepositoryRoot(repoDir);

  let skillDir = repoDir;
  if (skillPath !== ".") {
    let relativePath = "";
    for (const segment of skillPath.split("/")) {
      relativePath = relativePath ? `${relativePath}/${segment}` : segment;
      skillDir = path.join(skillDir, segment);
      // oxlint-disable-next-line no-await-in-loop -- every component is checked before descending through it
      const entry = await lstat(skillDir);
      if (entry.isSymbolicLink()) {
        throw unsafeFilesystemEntry(relativePath, "symbolic link");
      }
      if (!entry.isDirectory()) {
        throw unsafeFilesystemEntry(relativePath, "non-directory path component");
      }
    }
  }

  await assertRegularGithubFile(path.join(skillDir, "SKILL.md"), `${skillPath}/SKILL.md`);
  return skillDir;
}

export async function assertSafeGithubSkillTree(skillDir: string): Promise<void> {
  async function walk(currentDir: string, basePath: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(currentDir, entry.name);
        const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
        const entryStats = await lstat(fullPath);
        if (entryStats.isSymbolicLink()) {
          throw unsafeFilesystemEntry(relativePath, "symbolic link");
        }
        if (entryStats.isDirectory()) {
          if (isExcludedEntry(entry.name)) {
            return;
          }
          await walk(fullPath, relativePath);
          return;
        }
        if (entryStats.isFile()) {
          if (entryStats.nlink > 1) {
            throw unsafeFilesystemEntry(relativePath, "hard link");
          }
          return;
        }
        throw unsafeFilesystemEntry(relativePath, "special filesystem entry");
      }),
    );
  }

  const rootEntry = await lstat(skillDir);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw unsafeFilesystemEntry(".", "skill root");
  }
  await walk(skillDir, "");
}

export async function discoverLocalSkillPaths(rootDir: string): Promise<string[]> {
  async function walk(currentDir: string, basePath: string): Promise<string[]> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    const discovered = await Promise.all(
      entries.map(async (entry): Promise<string[]> => {
        if (isExcludedEntry(entry.name)) {
          return [];
        }

        const fullPath = path.join(currentDir, entry.name);
        const relativePath = basePath ? path.join(basePath, entry.name) : entry.name;

        if (entry.isDirectory()) {
          return walk(fullPath, relativePath);
        }

        if (entry.isFile() && entry.name === "SKILL.md") {
          return [basePath ? basePath.split(path.sep).join("/") : "."];
        }

        return [];
      }),
    );

    return discovered.flat();
  }

  const discovered = await walk(rootDir, "");
  return [...new Set(discovered)].toSorted((a, b) => a.localeCompare(b));
}

export async function resolveGithubSkillPath(
  repoDir: string,
  requestedSkillPath: string | null,
): Promise<{ skillPath: string; availablePaths: string[] }> {
  await assertGithubRepositoryRoot(repoDir);
  const availablePaths = await discoverLocalSkillPaths(repoDir);

  let skillPath: string;
  if (requestedSkillPath) {
    const normalized = normalizeGithubSkillPath(requestedSkillPath);
    skillPath = normalized;
  } else if (availablePaths.length === 1) {
    skillPath = availablePaths[0] ?? ".";
  } else if (availablePaths.length === 0) {
    throw new Error("No SKILL.md found in the GitHub repository");
  } else {
    throw new Error(
      `Multiple skills found in the GitHub repository. Choose one with github:owner/repo//path (available: ${availablePaths.join(", ")})`,
    );
  }

  await assertGithubSkillPath(repoDir, skillPath);
  return { skillPath, availablePaths };
}

export function deriveGithubInstallSkillName(
  frontmatterName: string,
  skillPath: string,
  skillDir: string,
  repoName: string,
): string {
  const trimmedName = frontmatterName.trim();
  if (trimmedName) {
    return validateRegistrySkillName(trimmedName);
  }

  return validateRegistrySkillName(skillPath === "." ? repoName : path.basename(skillDir));
}

async function cloneGithubRepository(
  target: GithubRegistryInstallTarget,
  cloneDir: string,
): Promise<void> {
  const repoUrl = `https://github.com/${target.repoFullName}.git`;
  const args = ["clone", "--depth=1"];

  if (target.ref) {
    args.push(`--branch=${target.ref}`);
  }

  args.push("--", repoUrl, cloneDir);

  await execFileAsync("git", args);
}

export interface GithubInstallSourceMetadata {
  readonly source: "github-direct";
  readonly repo: string;
  readonly ref: string;
  readonly commit: string;
  readonly skill_path: string;
  readonly available_paths: readonly string[];
}

export async function installGithubSkillDirectory(options: {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly metadata: GithubInstallSourceMetadata;
}): Promise<void> {
  const { sourceDir, targetDir, metadata } = options;
  await assertSafeGithubSkillTree(sourceDir);
  await stageDirectoryReplacement(targetDir, async (stagedDir) => {
    await cp(sourceDir, stagedDir, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (entryPath) => entryPath === sourceDir || !isExcludedEntry(path.basename(entryPath)),
    });
    await writeFile(
      path.join(stagedDir, ".selftune-source.json"),
      JSON.stringify(metadata, null, 2),
    );
    await assertSafeGithubSkillTree(stagedDir);
  });
}

export interface GithubRegistryInstallResult {
  readonly success: true;
  readonly source: "github-direct";
  readonly name: string;
  readonly repo: string;
  readonly ref: string;
  readonly commit: string;
  readonly skill_path: string;
  readonly path: string;
  readonly global: boolean;
}

export async function installFromGithubTarget(
  rawTarget: string,
  globalFlag: boolean,
): Promise<GithubRegistryInstallResult> {
  const target = parseGithubRegistryInstallTarget(rawTarget);
  if (!target) {
    throw new Error("GitHub install target must start with github:");
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "selftune-github-install-"));

  try {
    const cloneDir = path.join(tempRoot, "repo");
    await cloneGithubRepository(target, cloneDir);

    const { skillPath, availablePaths } = await resolveGithubSkillPath(cloneDir, target.skillPath);
    const skillDir = skillPath === "." ? cloneDir : path.join(cloneDir, ...skillPath.split("/"));
    await assertSafeGithubSkillTree(skillDir);
    const skillContent = await readFile(path.join(skillDir, "SKILL.md"), "utf-8");
    const frontmatter = parseFrontmatter(skillContent);
    const skillName = deriveGithubInstallSkillName(
      frontmatter.name,
      skillPath,
      skillDir,
      target.repo,
    );
    const resolvedCommit = (
      await execFileAsync("git", ["-C", cloneDir, "rev-parse", "HEAD"])
    ).stdout.trim();

    const targetBase = globalFlag
      ? path.join(process.env.HOME || homedir(), ".claude", "skills")
      : path.join(process.cwd(), ".claude", "skills");
    const targetDir = resolveRegistryInstallPath(targetBase, skillName);

    await installGithubSkillDirectory({
      sourceDir: skillDir,
      targetDir,
      metadata: {
        source: "github-direct",
        repo: target.repoFullName,
        ref: target.ref ?? "HEAD",
        commit: resolvedCommit,
        skill_path: skillPath,
        available_paths: availablePaths,
      },
    });

    return {
      success: true,
      source: "github-direct",
      name: skillName,
      repo: target.repoFullName,
      ref: target.ref ?? "HEAD",
      commit: resolvedCommit,
      skill_path: skillPath,
      path: targetDir,
      global: globalFlag,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
