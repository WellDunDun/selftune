import { isAbsolute, resolve } from "node:path";

import type { RuntimeOwner, RuntimeSupervision } from "@selftune/local/local-runtime";

interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string>;
}

export type ServiceArbitration = "attach" | "replace";

export interface ServiceRuntimeIdentity {
  readonly owner: RuntimeOwner;
  readonly ownerVersion: string | null;
  readonly supervision: RuntimeSupervision;
}

function parseSemanticVersion(value: string): SemanticVersion | null {
  const match = value
    .trim()
    .match(
      /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
    );
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (identifier) =>
        identifier.length === 0 || (/^\d+$/.test(identifier) && /^0\d+/.test(identifier)),
    )
  ) {
    return null;
  }
  return {
    major,
    minor,
    patch,
    prerelease,
  };
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrerelease(left: ReadonlyArray<string>, right: ReadonlyArray<string>): number {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      if (leftPart === rightPart) return 0;
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumericIdentifiers(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function compareSemanticVersions(left: string, right: string): number | null {
  const parsedLeft = parseSemanticVersion(left);
  const parsedRight = parseSemanticVersion(right);
  if (!parsedLeft || !parsedRight) return null;
  for (const key of ["major", "minor", "patch"] satisfies ReadonlyArray<
    "major" | "minor" | "patch"
  >) {
    if (parsedLeft[key] !== parsedRight[key]) {
      return parsedLeft[key] < parsedRight[key] ? -1 : 1;
    }
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

export function arbitrateRegisteredService(
  runtime: ServiceRuntimeIdentity,
  desktopVersion: string,
): ServiceArbitration {
  if (runtime.supervision !== "os-service" || runtime.ownerVersion === null) return "attach";
  const comparison = compareSemanticVersions(runtime.ownerVersion, desktopVersion);
  if (comparison === null) return "attach";
  return comparison < 0 ? "replace" : "attach";
}

export function backgroundServiceEnabledFromRegistration(registered: boolean): boolean {
  return registered;
}

export function skipBackgroundServiceFirstRunPrompt(value: string | undefined): boolean {
  return value === "1";
}

export function testUserDataDirectory(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!isAbsolute(trimmed)) {
    throw new Error("SELFTUNE_DESKTOP_USER_DATA_DIR must be an absolute path.");
  }
  return resolve(trimmed);
}
