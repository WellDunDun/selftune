import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LibraryError, type CreateSkillSetInput, type SkillSetManifest } from "@selftune/library";
import type { CreateSkillSetRequest } from "@selftune/runtime/dashboard-contract";
import {
  CatalogSkillResolutionProgress,
  CatalogSkillResolverFailure,
  CatalogSkillSetResolutionError,
  createSkillSetWithCatalogResolution,
  type CatalogSkillPackageResolver,
} from "@selftune/runtime/skill-sets/catalog-resolution";
import { makeSkillsShCatalogPackageResolver } from "@selftune/runtime/skill-sets/skills-sh-catalog-resolver";
import { Effect, Result } from "effect";

const roots: string[] = [];

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "selftune-catalog-set-"));
  roots.push(path);
  return path;
}

function request(skills: CreateSkillSetRequest["skills"]): CreateSkillSetRequest {
  return {
    name: "Cross-Platform Mobile",
    description: "A catalog-expanded mobile workflow.",
    harnesses: ["codex"],
    skills,
  };
}

function catalogSkill(name: string) {
  return {
    name,
    catalog_id: `flutter/skills/${name}`,
    source: "flutter/skills",
    install_spec: `flutter/skills@${name}`,
    download_url: `https://skills.sh/api/download/flutter/skills/${name}`,
  };
}

function manifest(input: CreateSkillSetInput): SkillSetManifest {
  return {
    schema_version: 1,
    set_id: "cross-platform-mobile",
    name: input.name,
    description: input.description ?? "",
    harnesses: input.harnesses,
    skills: input.skills.map((skill) => ({
      name: skill.name,
      content_hash: `hash-${skill.name}`,
      library_package_path: skill.package_path,
    })),
    revision: 1,
    revision_hash: "revision-one",
    parent_revision_hash: null,
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z",
  };
}

describe("catalog-backed Skill Set creation", () => {
  test("preserves library failure codes and retryability at the creation boundary", async () => {
    const result = await Effect.runPromise(
      createSkillSetWithCatalogResolution(request([]), {
        create: () => {
          throw new LibraryError("Try again", "OPERATION_FAILED", undefined, 1, true);
        },
      }).pipe(Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        code: "OPERATION_FAILED",
        message: "Try again",
        retryable: true,
      });
    }
  });

  test("reports unexpected creation errors as non-retryable failures", async () => {
    const result = await Effect.runPromise(
      createSkillSetWithCatalogResolution(request([]), {
        create: () => {
          throw new Error("Unexpected failure");
        },
      }).pipe(Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        code: "SKILL_SET_CREATION_FAILED",
        message: "Unexpected failure",
        retryable: false,
      });
    }
  });

  test("adapts the skills.sh materializer into exact local package resolution", async () => {
    const base = root();
    const progress: CatalogSkillResolutionProgress[] = [];
    const resolver = makeSkillsShCatalogPackageResolver({
      configRoot: join(base, "config"),
      fetcher: async () =>
        new Response(
          JSON.stringify({
            id: "flutter/skills/flutter",
            source: "flutter/skills",
            slug: "flutter",
            hash: null,
            files: [
              {
                path: "SKILL.md",
                contents: "---\nname: flutter\ndescription: Build Flutter applications.\n---\n",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const materialized = await Effect.runPromise(
      resolver.resolve(catalogSkill("flutter"), (entry) => progress.push(entry)),
    );

    expect(materialized.name).toBe("flutter");
    expect(materialized.package_path).toContain(join(base, "config", "library", "packages"));
    expect(materialized.content_hash).toHaveLength(64);
    expect(progress.map((entry) => entry.phase)).toEqual([
      "downloading",
      "validating",
      "materializing",
      "materializing",
    ]);
  });

  test("maps retryable skills.sh HTTP failures to a catalog resolver failure", async () => {
    const resolver = makeSkillsShCatalogPackageResolver({
      fetcher: async () => new Response("Unavailable", { status: 503 }),
    });

    const outcome = await Effect.runPromise(
      resolver.resolve(catalogSkill("flutter"), () => undefined).pipe(Effect.result),
    );

    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isSuccess(outcome)) throw new Error("Expected catalog download to fail");
    expect(outcome.failure).toMatchObject({
      skill_name: "flutter",
      catalog_id: "flutter/skills/flutter",
      phase: "downloading",
      code: "CATALOG_HTTP_ERROR",
      retryable: true,
    });
  });

  test("materializes exact catalog packages before calling createSkillSet with local paths", async () => {
    const base = root();
    const createdWith: CreateSkillSetInput[] = [];
    const observedProgress: CatalogSkillResolutionProgress[] = [];
    const resolver: CatalogSkillPackageResolver = {
      resolve: (skill, report) =>
        Effect.sync(() => {
          report(
            CatalogSkillResolutionProgress.make({
              skill_name: skill.name,
              catalog_id: skill.catalog_id,
              phase: "downloading",
              message: `Downloading ${skill.install_spec}`,
            }),
          );
          report(
            CatalogSkillResolutionProgress.make({
              skill_name: skill.name,
              catalog_id: skill.catalog_id,
              phase: "materializing",
              message: `Materializing ${skill.name}`,
            }),
          );
          return {
            name: skill.name,
            package_path: join(base, skill.name),
            content_hash: `local-${skill.name}`,
            upstream_revision: `catalog-${skill.name}`,
          };
        }),
    };
    const input = request([
      { name: "diagnose", package_path: join(base, "diagnose") },
      catalogSkill("flutter"),
      catalogSkill("dart"),
    ]);

    const result = await Effect.runPromise(
      createSkillSetWithCatalogResolution(input, {
        resolver,
        onProgress: (progress) => observedProgress.push(progress),
        create: (resolved) => {
          createdWith.push(resolved);
          return manifest(resolved);
        },
      }),
    );

    expect(createdWith).toHaveLength(1);
    expect(createdWith[0]?.skills).toEqual([
      { name: "diagnose", package_path: join(base, "diagnose") },
      { name: "flutter", package_path: join(base, "flutter") },
      { name: "dart", package_path: join(base, "dart") },
    ]);
    expect(result.skills.map((skill) => skill.library_package_path)).toEqual([
      join(base, "diagnose"),
      join(base, "flutter"),
      join(base, "dart"),
    ]);
    expect(result.resolution_progress).toEqual(observedProgress);
    expect(
      result.resolution_progress
        .filter((progress) => progress.skill_name === "flutter")
        .map((progress) => progress.phase),
    ).toEqual(["resolving", "downloading", "materializing", "validating", "ready"]);
  });

  test("preserves every per-skill failure and never creates a partial set", async () => {
    let createCalls = 0;
    const resolver: CatalogSkillPackageResolver = {
      resolve: (skill) =>
        Effect.fail(
          CatalogSkillResolverFailure.make({
            skill_name: skill.name,
            catalog_id: skill.catalog_id,
            phase: skill.name === "flutter" ? "downloading" : "validating",
            code: skill.name === "flutter" ? "CATALOG_HTTP_ERROR" : "CATALOG_INTEGRITY_ERROR",
            message: `${skill.name} could not be materialized`,
            retryable: skill.name === "flutter",
          }),
        ),
    };

    const outcome = await Effect.runPromise(
      createSkillSetWithCatalogResolution(
        request([catalogSkill("flutter"), catalogSkill("dart")]),
        {
          resolver,
          create: (resolved) => {
            createCalls += 1;
            return manifest(resolved);
          },
        },
      ).pipe(Effect.result),
    );

    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isSuccess(outcome)) throw new Error("Expected catalog resolution to fail");
    expect(outcome.failure).toBeInstanceOf(CatalogSkillSetResolutionError);
    if (!(outcome.failure instanceof CatalogSkillSetResolutionError)) {
      throw new Error("Expected a catalog resolution error");
    }
    expect(outcome.failure.failures).toEqual([
      {
        skill_name: "flutter",
        catalog_id: "flutter/skills/flutter",
        phase: "downloading",
        code: "CATALOG_HTTP_ERROR",
        message: "flutter could not be materialized",
        retryable: true,
      },
      {
        skill_name: "dart",
        catalog_id: "flutter/skills/dart",
        phase: "validating",
        code: "CATALOG_INTEGRITY_ERROR",
        message: "dart could not be materialized",
        retryable: false,
      },
    ]);
    expect(outcome.failure.retryable).toBe(true);
    expect(createCalls).toBe(0);
  });

  test("rejects a mismatched or non-local materializer result before creation", async () => {
    let createCalls = 0;
    const resolver: CatalogSkillPackageResolver = {
      resolve: () =>
        Effect.succeed({
          name: "different-skill",
          package_path: "relative/package",
        }),
    };
    const outcome = await Effect.runPromise(
      createSkillSetWithCatalogResolution(request([catalogSkill("flutter")]), {
        resolver,
        create: (resolved) => {
          createCalls += 1;
          return manifest(resolved);
        },
      }).pipe(Effect.result),
    );

    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isSuccess(outcome)) throw new Error("Expected validation to fail");
    expect(outcome.failure).toMatchObject({
      code: "CATALOG_SKILL_RESOLUTION_FAILED",
      failures: [
        {
          skill_name: "flutter",
          phase: "validating",
          code: "INVALID_CATALOG_PACKAGE",
        },
      ],
    });
    expect(createCalls).toBe(0);
  });

  test("creates a real immutable set after the resolver materializes a package", async () => {
    const base = root();
    const configRoot = join(base, "config");
    const packagePath = join(base, "packages", "flutter");
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(
      join(packagePath, "SKILL.md"),
      "---\nname: flutter\ndescription: Build Flutter applications.\n---\n",
    );
    const resolver: CatalogSkillPackageResolver = {
      resolve: (skill) =>
        Effect.succeed({
          name: skill.name,
          package_path: packagePath,
          content_hash: "materializer-owned-local-hash",
          upstream_revision: "unverified-upstream-revision",
        }),
    };
    const { createSkillSet } = await import("@selftune/library");

    const result = await Effect.runPromise(
      createSkillSetWithCatalogResolution(request([catalogSkill("flutter")]), {
        resolver,
        create: (resolved) => createSkillSet(resolved, { configRoot }),
      }),
    );

    expect(result.skills).toHaveLength(1);
    const createdSkill = result.skills[0];
    if (!createdSkill) throw new Error("Expected the materialized skill in the manifest");
    expect(createdSkill.name).toBe("flutter");
    expect(createdSkill.library_package_path).toContain(
      join(configRoot, "library", "packages", createdSkill.content_hash, "flutter"),
    );
    expect(result.resolution_progress.at(-1)?.phase).toBe("ready");
  });
});
