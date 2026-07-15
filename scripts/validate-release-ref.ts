#!/usr/bin/env bun
import { appendFileSync } from "node:fs";

export const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export function validateReleaseVersion(value: string): string {
  if (!RELEASE_VERSION_PATTERN.test(value)) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return value;
}

export function validateReleaseTag(value: string): string {
  if (!value.startsWith("v")) {
    throw new Error(`Invalid release tag: ${value}`);
  }
  validateReleaseVersion(value.slice(1));
  return value;
}

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function appendGitHubFile(path: string | undefined, line: string): void {
  if (!path || !line) return;
  appendFileSync(path, `${line}\n`, "utf8");
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

function run(): void {
  const args = process.argv.slice(2);
  const tagEnv = readOption(args, "--tag-env");
  const versionEnv = readOption(args, "--version-env");
  const writeEnv = readOption(args, "--write-env");
  const outputName = readOption(args, "--output");

  if (tagEnv && versionEnv) {
    throw new Error("Use either --tag-env or --version-env, not both");
  }
  if (!tagEnv && !versionEnv) {
    throw new Error("Expected --tag-env or --version-env");
  }

  let tag: string;
  if (tagEnv) {
    tag = validateReleaseTag(readEnv(tagEnv));
  } else if (versionEnv) {
    tag = `v${validateReleaseVersion(readEnv(versionEnv))}`;
  } else {
    throw new Error("Expected --tag-env or --version-env");
  }

  appendGitHubFile(process.env.GITHUB_ENV, writeEnv ? `${writeEnv}=${tag}` : "");
  appendGitHubFile(process.env.GITHUB_OUTPUT, outputName ? `${outputName}=${tag}` : "");
  process.stdout.write(`Validated release tag ${tag}\n`);
}

if (import.meta.main) {
  run();
}
