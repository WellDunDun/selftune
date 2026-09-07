import path from "node:path";

import * as Schema from "effect/Schema";

const MAX_IDENTIFIER_LENGTH = 128;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;

export class RegistryIdentifierValidationError extends Schema.TaggedErrorClass<RegistryIdentifierValidationError>()(
  "RegistryIdentifierValidationError",
  {
    identifierType: Schema.Literals(["skill-name", "version"]),
    value: Schema.String,
    message: Schema.String,
  },
) {}

export class RegistryPathConfinementError extends Schema.TaggedErrorClass<RegistryPathConfinementError>()(
  "RegistryPathConfinementError",
  {
    root: Schema.String,
    pathname: Schema.String,
    message: Schema.String,
  },
) {}

function invalidIdentifier(
  identifierType: "skill-name" | "version",
  value: string,
  expected: string,
): RegistryIdentifierValidationError {
  return RegistryIdentifierValidationError.make({
    identifierType,
    value,
    message: `Invalid registry ${identifierType} '${value}': expected ${expected}`,
  });
}

function validateIdentifier(
  identifierType: "skill-name" | "version",
  value: string,
  pattern: RegExp,
): string {
  const expected =
    identifierType === "skill-name"
      ? "a 1-128 character slug containing only letters, numbers, dots, underscores, and hyphens"
      : "a 1-128 character version containing only letters, numbers, dots, plus signs, underscores, and hyphens";

  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value !== value.trim() ||
    !pattern.test(value)
  ) {
    throw invalidIdentifier(identifierType, value, expected);
  }

  return value;
}

export function validateRegistrySkillName(value: string): string {
  return validateIdentifier("skill-name", value, SKILL_NAME_PATTERN);
}

export function validateRegistryVersion(value: string): string {
  return validateIdentifier("version", value, VERSION_PATTERN);
}

function pathConfinementError(root: string, pathname: string, reason: string) {
  return RegistryPathConfinementError.make({
    root,
    pathname,
    message: `Registry install path '${pathname}' is not confined to '${root}': ${reason}`,
  });
}

export function resolveRegistryInstallPath(installRoot: string, skillName: string): string {
  const validatedName = validateRegistrySkillName(skillName);
  const resolvedRoot = path.resolve(installRoot);
  const targetPath = path.resolve(resolvedRoot, validatedName);
  const relativePath = path.relative(resolvedRoot, targetPath);

  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw pathConfinementError(resolvedRoot, targetPath, "resolved outside the install root");
  }

  return targetPath;
}

export interface PersistedRegistryInstallTarget {
  readonly installRoot: string;
  readonly targetDir: string;
}

export function validatePersistedRegistryInstallPath(
  installPath: string,
  skillName: string,
): PersistedRegistryInstallTarget {
  const resolvedPath = path.resolve(installPath);
  const installRoot = path.dirname(resolvedPath);
  const claudeDirectory = path.dirname(installRoot);

  if (!path.isAbsolute(installPath)) {
    throw pathConfinementError(installRoot, installPath, "persisted paths must be absolute");
  }
  if (path.basename(installRoot) !== "skills" || path.basename(claudeDirectory) !== ".claude") {
    throw pathConfinementError(
      installRoot,
      installPath,
      "expected a direct child of a .claude/skills directory",
    );
  }

  const expectedPath = resolveRegistryInstallPath(installRoot, skillName);
  if (resolvedPath !== expectedPath) {
    throw pathConfinementError(
      installRoot,
      installPath,
      `expected the path for skill '${skillName}'`,
    );
  }

  return { installRoot, targetDir: expectedPath };
}
