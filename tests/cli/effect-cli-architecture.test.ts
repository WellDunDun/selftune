import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TUNE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EFFECT_CLI_ROOT = join(SELF_TUNE_ROOT, "apps/cli/src/effect-cli");
const PROGRAM_SOURCE = join(EFFECT_CLI_ROOT, "program.ts");
const ROOT_COMMAND_SOURCE = join(EFFECT_CLI_ROOT, "root-command.ts");
const RUNTIME_SOURCE = join(EFFECT_CLI_ROOT, "runtime.ts");
const SERVICE_SOURCE = join(EFFECT_CLI_ROOT, "commands/service.ts");
const REGISTRY_SOURCE = join(EFFECT_CLI_ROOT, "commands/registry.ts");
const SERVICE_MODULES = [
  "@selftune/local/service-programs",
  "@selftune/local/service/maintenance/programs",
];

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}

function countOccurrences(source: string, token: string): number {
  return source.split(token).length - 1;
}

describe("Effect CLI architecture", () => {
  test("keeps lazy registry runtime loading owned by its command module", () => {
    const productionSources = collectTypeScriptFiles(EFFECT_CLI_ROOT).map((path) => ({
      path,
      source: readSource(path),
    }));
    const owners = productionSources
      .filter(({ source }) => source.includes("@selftune/runtime/registry/programs"))
      .map(({ path }) => relative(EFFECT_CLI_ROOT, path));

    expect(owners).toEqual([relative(EFFECT_CLI_ROOT, REGISTRY_SOURCE)]);
    expect(readSource(REGISTRY_SOURCE)).toContain(
      'loadModule: () => import("@selftune/runtime/registry/programs")',
    );
    expect(readSource(PROGRAM_SOURCE)).not.toContain("@selftune/runtime/registry/programs");
    expect(readSource(ROOT_COMMAND_SOURCE)).not.toContain("@selftune/runtime/registry/programs");
  });

  test("keeps one Bun runtime boundary and no nested Effect runners", () => {
    const productionSources = collectTypeScriptFiles(EFFECT_CLI_ROOT).map((path) => ({
      path,
      source: readSource(path),
    }));
    const runtimeOwners = productionSources.flatMap(({ path, source }) =>
      Array.from({ length: countOccurrences(source, "BunRuntime.runMain") }, () =>
        relative(EFFECT_CLI_ROOT, path),
      ),
    );

    expect(runtimeOwners).toEqual([relative(EFFECT_CLI_ROOT, RUNTIME_SOURCE)]);

    for (const { path, source } of productionSources) {
      expect(source, relative(EFFECT_CLI_ROOT, path)).not.toMatch(
        /Effect\.(?:runPromise|runSync|runFork)\b|\bcatchCause\b/,
      );
    }
  });

  test("keeps both service module loaders owned by the service command", () => {
    const productionSources = collectTypeScriptFiles(EFFECT_CLI_ROOT).map((path) => ({
      path,
      source: readSource(path),
    }));

    for (const moduleName of SERVICE_MODULES) {
      const owners = productionSources
        .filter(({ source }) => source.includes(moduleName))
        .map(({ path }) => relative(EFFECT_CLI_ROOT, path));
      const serviceSource = readSource(SERVICE_SOURCE);

      expect(owners).toEqual([relative(EFFECT_CLI_ROOT, SERVICE_SOURCE)]);
      expect(countOccurrences(serviceSource, moduleName)).toBe(1);
      expect(serviceSource).toContain(`import("${moduleName}")`);
    }
  });
});
