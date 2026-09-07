#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";

import {
  compareStableReleaseVersions,
  setCoupledReleaseVersion,
  validateStableReleaseVersion,
} from "./release-version";

export type ReleaseBump = "major" | "minor" | "patch";

const BUMP_WEIGHT: Record<ReleaseBump, number> = { major: 3, minor: 2, patch: 1 };

export function nextStableVersion(version: string, bump: ReleaseBump): string {
  const [major, minor, patch] = validateStableReleaseVersion(version)
    .split(".")
    .map((part) => BigInt(part));
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`Could not parse stable version ${version}.`);
  }
  if (bump === "major") return `${major + 1n}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1n}.0`;
  return `${major}.${minor}.${patch + 1n}`;
}

export function releaseBumpFromChangesets(contents: ReadonlyArray<string>): ReleaseBump | null {
  let selected: ReleaseBump | null = null;
  for (const content of contents) {
    const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/u.exec(content)?.[1];
    if (!frontmatter) continue;
    const match = /^"@selftune\/desktop":\s*(major|minor|patch)\s*$/mu.exec(frontmatter);
    const bump = match?.[1];
    if (
      (bump === "major" || bump === "minor" || bump === "patch") &&
      (!selected || BUMP_WEIGHT[bump] > BUMP_WEIGHT[selected])
    )
      selected = bump;
  }
  return selected;
}

function gitLines(args: ReadonlyArray<string>): string[] {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      new TextDecoder().decode(result.stderr).trim() || `git ${args.join(" ")} failed`,
    );
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function appendOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `${name}=${value}\n`, "utf8");
}

function run(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "next") {
    throw new Error("Usage: release-plan.ts next --base-tag vX.Y.Z [--stage]");
  }
  const tagIndex = args.indexOf("--base-tag");
  const baseTag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
  if (!baseTag?.startsWith("v")) throw new Error("Missing or invalid --base-tag vX.Y.Z");
  const baseVersion = validateStableReleaseVersion(baseTag.slice(1));
  const paths = gitLines([
    "diff",
    "--diff-filter=AM",
    "--name-only",
    `${baseTag}..HEAD`,
    "--",
    ".changeset/*.md",
  ]).filter((path) => path !== ".changeset/README.md");
  const bump = releaseBumpFromChangesets(paths.map((path) => readFileSync(path, "utf8")));
  if (!bump) {
    appendOutput("should_release", "false");
    process.stdout.write(`No unconsumed @selftune/desktop changeset since ${baseTag}.\n`);
    return;
  }
  const version = nextStableVersion(baseVersion, bump);
  if (compareStableReleaseVersions(version, baseVersion) !== 1) {
    throw new Error(`Release version ${version} must advance ${baseVersion}.`);
  }
  if (args.includes("--stage")) setCoupledReleaseVersion(version);
  appendOutput("should_release", "true");
  appendOutput("version", version);
  appendOutput("tag", `v${version}`);
  process.stdout.write(`Planned ${bump} release v${version} from ${paths.length} changeset(s).\n`);
}

if (import.meta.main) run();
