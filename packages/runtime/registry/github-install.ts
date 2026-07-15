import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseFrontmatter } from "../utils/frontmatter.js";

const execFileAsync = promisify(execFile);

export interface GithubRegistryInstallTarget {
  owner: string;
  repo: string;
  repoFullName: string;
  ref: string | null;
  skillPath: string | null;
}

function normalizeGithubSkillPath(skillPath: string): string {
  const trimmed = skillPath.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === ".") {
    return ".";
  }

  const segments = trimmed.split("/").filter(Boolean);
  if (segments.includes("..")) {
    throw new Error("GitHub skill path must stay within the repository");
  }

  const normalized = path.posix.normalize(trimmed).replace(/^\/+|\/+$/g, "");
  return normalized || ".";
}

export function parseGithubRegistryInstallTarget(
  rawTarget: string,
): GithubRegistryInstallTarget | null {
  if (!rawTarget.startsWith("github:")) {
    return null;
  }

  const spec = rawTarget.slice("github:".length).trim();
  if (!spec) {
    throw new Error("GitHub install target must be github:owner/repo[@ref][//path]");
  }

  const pathSeparatorIndex = spec.indexOf("//");
  const repoWithMaybeRef = pathSeparatorIndex === -1 ? spec : spec.slice(0, pathSeparatorIndex);
  const pathWithMaybeRef = pathSeparatorIndex === -1 ? null : spec.slice(pathSeparatorIndex + 2);

  let ref: string | null = null;
  let repoSpec = repoWithMaybeRef;

  const repoRefIndex = repoWithMaybeRef.lastIndexOf("@");
  if (repoRefIndex !== -1) {
    repoSpec = repoWithMaybeRef.slice(0, repoRefIndex);
    ref = repoWithMaybeRef.slice(repoRefIndex + 1) || null;
  }

  let skillPath: string | null = null;
  if (pathWithMaybeRef != null) {
    const pathRefIndex = pathWithMaybeRef.lastIndexOf("@");
    if (pathRefIndex !== -1) {
      skillPath = pathWithMaybeRef.slice(0, pathRefIndex) || ".";
      ref = pathWithMaybeRef.slice(pathRefIndex + 1) || ref;
    } else {
      skillPath = pathWithMaybeRef || ".";
    }
  }

  const match = repoSpec.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) {
    throw new Error("GitHub install target must look like github:owner/repo[@ref][//path]");
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

export async function discoverLocalSkillPaths(rootDir: string): Promise<string[]> {
  async function walk(currentDir: string, basePath: string): Promise<string[]> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    const discovered: string[] = [];

    for (const entry of entries) {
      if (isExcludedEntry(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = basePath ? path.join(basePath, entry.name) : entry.name;

      if (entry.isDirectory()) {
        discovered.push(...(await walk(fullPath, relativePath)));
        continue;
      }

      if (entry.isFile() && entry.name === "SKILL.md") {
        discovered.push(basePath ? basePath.split(path.sep).join("/") : ".");
      }
    }

    return discovered;
  }

  const discovered = await walk(rootDir, "");
  return [...new Set(discovered)].sort((a, b) => a.localeCompare(b));
}

export async function resolveGithubSkillPath(
  repoDir: string,
  requestedSkillPath: string | null,
): Promise<{ skillPath: string; availablePaths: string[] }> {
  const availablePaths = await discoverLocalSkillPaths(repoDir);

  if (requestedSkillPath) {
    const normalized = normalizeGithubSkillPath(requestedSkillPath);
    const skillMdPath =
      normalized === "."
        ? path.join(repoDir, "SKILL.md")
        : path.join(repoDir, ...normalized.split("/"), "SKILL.md");
    await stat(skillMdPath);
    return { skillPath: normalized, availablePaths };
  }

  if (availablePaths.length === 1) {
    return { skillPath: availablePaths[0] ?? ".", availablePaths };
  }

  if (availablePaths.length === 0) {
    throw new Error("No SKILL.md found in the GitHub repository");
  }

  throw new Error(
    `Multiple skills found in the GitHub repository. Choose one with github:owner/repo//path (available: ${availablePaths.join(", ")})`,
  );
}

export function deriveGithubInstallSkillName(
  frontmatterName: string,
  skillPath: string,
  skillDir: string,
  repoName: string,
): string {
  const trimmedName = frontmatterName.trim();
  if (trimmedName) {
    return trimmedName;
  }

  return skillPath === "." ? repoName : path.basename(skillDir);
}

async function cloneGithubRepository(
  target: GithubRegistryInstallTarget,
  cloneDir: string,
): Promise<void> {
  const repoUrl = `https://github.com/${target.repoFullName}.git`;
  const args = ["clone", "--depth=1"];

  if (target.ref) {
    args.push("--branch", target.ref);
  }

  args.push(repoUrl, cloneDir);

  await execFileAsync("git", args);
}

async function copySkillDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(path.dirname(targetDir), { recursive: true });

  await cp(sourceDir, targetDir, {
    recursive: true,
    filter: (entryPath) => {
      const basename = path.basename(entryPath);
      return !isExcludedEntry(basename);
    },
  });
}

export async function installFromGithubTarget(
  rawTarget: string,
  globalFlag: boolean,
): Promise<void> {
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
      ? path.join(process.env.HOME || "~", ".claude", "skills")
      : path.join(process.cwd(), ".claude", "skills");
    const targetDir = path.join(targetBase, skillName);

    await copySkillDirectory(skillDir, targetDir);
    await writeFile(
      path.join(targetDir, ".selftune-source.json"),
      JSON.stringify(
        {
          source: "github-direct",
          repo: target.repoFullName,
          ref: target.ref ?? "HEAD",
          commit: resolvedCommit,
          skill_path: skillPath,
          available_paths: availablePaths,
        },
        null,
        2,
      ),
    );

    console.log(
      JSON.stringify({
        success: true,
        source: "github-direct",
        name: skillName,
        repo: target.repoFullName,
        ref: target.ref ?? "HEAD",
        commit: resolvedCommit,
        skill_path: skillPath,
        path: targetDir,
        global: globalFlag,
      }),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
