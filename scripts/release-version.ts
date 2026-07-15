#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { validateReleaseTag, validateReleaseVersion } from "./validate-release-ref";

const RELEASE_MANIFEST_PATHS = ["package.json", "apps/desktop/package.json"] as const;
const STABLE_RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const GITHUB_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

interface PackageManifest {
  readonly path: string;
  readonly value: object;
  readonly version: string;
}

function parsePackageManifest(path: string): PackageManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`Could not parse ${path} as JSON.`, { cause });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  if (!("version" in value) || typeof value.version !== "string") {
    throw new Error(`${path} must contain a string version.`);
  }
  return {
    path,
    value,
    version: validateReleaseVersion(value.version),
  };
}

function readReleaseManifests(repoRoot: string): ReadonlyArray<PackageManifest> {
  return RELEASE_MANIFEST_PATHS.map((path) => parsePackageManifest(resolve(repoRoot, path)));
}

export function readCoupledReleaseVersion(repoRoot = resolve(import.meta.dir, "..")): string {
  const manifests = readReleaseManifests(repoRoot);
  const [rootManifest, ...dependentManifests] = manifests;
  if (!rootManifest) {
    throw new Error("No release package manifests are configured.");
  }
  for (const manifest of dependentManifests) {
    if (manifest.version !== rootManifest.version) {
      throw new Error(
        `Release version drift: package.json is ${rootManifest.version}, but ${manifest.path} is ${manifest.version}.`,
      );
    }
  }
  return rootManifest.version;
}

export function assertReleaseTagMatchesVersion(
  tag: string,
  repoRoot = resolve(import.meta.dir, ".."),
): string {
  const validatedTag = validateReleaseTag(tag);
  const version = readCoupledReleaseVersion(repoRoot);
  if (validatedTag !== `v${version}`) {
    throw new Error(`Release tag ${validatedTag} does not match package version v${version}.`);
  }
  return version;
}

export function validateStableReleaseVersion(value: string): string {
  validateReleaseVersion(value);
  if (!STABLE_RELEASE_VERSION_PATTERN.test(value)) {
    throw new Error(`Stable releases require major.minor.patch, received ${value}.`);
  }
  return value;
}

function stableReleaseParts(value: string): readonly [bigint, bigint, bigint] {
  const validated = validateStableReleaseVersion(value);
  const [major, minor, patch] = validated.split(".");
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`Could not parse stable release version ${validated}.`);
  }
  return [BigInt(major), BigInt(minor), BigInt(patch)];
}

export function compareStableReleaseVersions(left: string, right: string): -1 | 0 | 1 {
  const leftParts = stableReleaseParts(left);
  const rightParts = stableReleaseParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined || rightPart === undefined) {
      throw new Error("Stable release parts must contain major, minor, and patch values.");
    }
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function writePackageManifests(manifests: ReadonlyArray<PackageManifest>, version: string): void {
  const transactionId = randomUUID();
  const files = manifests.map((manifest) => ({
    backupPath: `${manifest.path}.${transactionId}.backup`,
    content: `${JSON.stringify({ ...manifest.value, version }, null, 2)}\n`,
    path: manifest.path,
    temporaryPath: `${manifest.path}.${transactionId}.tmp`,
  }));

  try {
    for (const file of files) {
      writeFileSync(file.temporaryPath, file.content, { encoding: "utf8", flag: "wx" });
      copyFileSync(file.path, file.backupPath);
    }
    try {
      for (const file of files) {
        renameSync(file.temporaryPath, file.path);
      }
    } catch (cause) {
      for (const file of files) {
        copyFileSync(file.backupPath, file.path);
      }
      throw cause;
    }
  } finally {
    for (const file of files) {
      rmSync(file.temporaryPath, { force: true });
      rmSync(file.backupPath, { force: true });
    }
  }
}

export function setCoupledReleaseVersion(
  version: string,
  repoRoot = resolve(import.meta.dir, ".."),
): string {
  const validatedVersion = validateReleaseVersion(version);
  const manifests = readReleaseManifests(repoRoot);
  writePackageManifests(manifests, validatedVersion);
  return validatedVersion;
}

export function bumpCoupledReleasePatch(repoRoot = resolve(import.meta.dir, "..")): string {
  const currentVersion = validateStableReleaseVersion(readCoupledReleaseVersion(repoRoot));
  const match = STABLE_RELEASE_VERSION_PATTERN.exec(currentVersion);
  if (!match) throw new Error(`Could not parse stable release version ${currentVersion}.`);
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`Could not parse stable release version ${currentVersion}.`);
  }
  return setCoupledReleaseVersion(`${major}.${minor}.${BigInt(patch) + 1n}`, repoRoot);
}

function readOption(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function validateGitHubName(name: string): string {
  if (!GITHUB_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid GitHub environment or output name: ${name}`);
  }
  return name;
}

function appendGitHubFile(path: string | undefined, name: string, value: string): void {
  if (!path) return;
  appendFileSync(path, `${validateGitHubName(name)}=${value}\n`, "utf8");
}

function run(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === "compare-stable") {
    const [left, right] = args;
    if (!left || !right || args.length !== 2) {
      throw new Error("Usage: release-version.ts compare-stable <left> <right>");
    }
    process.stdout.write(`${compareStableReleaseVersions(left, right)}\n`);
    return;
  }
  if (command === "bump-patch") {
    const version = bumpCoupledReleasePatch();
    process.stdout.write(`Bumped release packages to v${version}\n`);
    return;
  }
  if (command === "set") {
    const version = args[0];
    if (!version) throw new Error("Usage: release-version.ts set <version>");
    setCoupledReleaseVersion(version);
    process.stdout.write(`Set release packages to v${version}\n`);
    return;
  }
  if (command !== "check") {
    throw new Error(
      "Usage: release-version.ts <check [--stable] [--tag-env NAME] [--output NAME] [--write-tag-env NAME]|compare-stable LEFT RIGHT|bump-patch|set VERSION>",
    );
  }

  const coupledVersion = readCoupledReleaseVersion();
  const version = args.includes("--stable")
    ? validateStableReleaseVersion(coupledVersion)
    : coupledVersion;
  const tag = `v${version}`;
  const tagEnv = readOption(args, "--tag-env");
  if (tagEnv) {
    assertReleaseTagMatchesVersion(readEnv(tagEnv));
  }

  const outputName = readOption(args, "--output");
  if (outputName) appendGitHubFile(process.env.GITHUB_OUTPUT, outputName, version);
  const tagEnvName = readOption(args, "--write-tag-env");
  if (tagEnvName) appendGitHubFile(process.env.GITHUB_ENV, tagEnvName, tag);
  process.stdout.write(`Release packages are coupled at ${tag}\n`);
}

if (import.meta.main) {
  run();
}
