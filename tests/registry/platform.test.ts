import { afterEach, describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Result } from "effect";

import {
  makeRegistryPlatformLayer,
  RegistryPlatform,
} from "../../packages/runtime/registry/platform.js";
import { RegistryOperationError } from "../../packages/runtime/registry/program-types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RegistryPlatform", () => {
  test("packages an explicit managed directory reproducibly without changing cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-registry-platform-explicit-"));
    roots.push(root);
    const managed = join(root, ".claude", "skills", "deploy");
    const unrelatedCwd = join(root, "unrelated");
    mkdirSync(managed, { recursive: true });
    mkdirSync(unrelatedCwd, { recursive: true });
    writeFileSync(
      join(managed, "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy safely\n---\n",
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const platform = yield* RegistryPlatform;
        const input = { operation: "suggest" as const, version: "1.0.1" };
        const first = yield* platform.preparePackage(managed, input);
        const second = yield* platform.preparePackage(managed, input);
        return { first, second };
      }).pipe(
        Effect.provide(
          makeRegistryPlatformLayer({
            configDirectory: join(root, ".selftune"),
            cwd: unrelatedCwd,
            deviceId: "test-device",
            homeDirectory: root,
          }),
        ),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(result.first?.name).toBe("deploy");
    expect(result.first?.archiveHash).toBe(result.second?.archiveHash);
    expect(result.first?.manifest.map((file) => file.path)).toEqual(["SKILL.md"]);
  });

  test("rejects symlinks before building a push archive the installer cannot accept", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-registry-platform-"));
    roots.push(root);
    writeFileSync(join(root, "SKILL.md"), "---\nname: deploy\ndescription: Deploy\n---\n");
    symlinkSync("SKILL.md", join(root, "linked-skill.md"));

    const outcome = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const platform = yield* RegistryPlatform;
          return yield* platform.preparePush({ operation: "push" });
        }).pipe(
          Effect.provide(
            makeRegistryPlatformLayer({
              configDirectory: join(root, ".selftune"),
              cwd: root,
              deviceId: "test-device",
              homeDirectory: root,
            }),
          ),
          Effect.provide(BunServices.layer),
        ),
      ),
    );

    expect(Result.isFailure(outcome) && outcome.failure).toBeInstanceOf(RegistryOperationError);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure.message).toContain("unsupported filesystem entry: linked-skill.md");
    }
  });

  test("blocks sensitive files before packaging and reports protected rollout paths by name only", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-registry-platform-sensitive-"));
    roots.push(root);
    const managed = join(root, ".claude", "skills", "deploy");
    mkdirSync(join(managed, ".git"), { recursive: true });
    mkdirSync(join(managed, "node_modules"), { recursive: true });
    writeFileSync(join(managed, "SKILL.md"), "---\nname: deploy\ndescription: Deploy\n---\n");
    writeFileSync(join(managed, ".env.local"), "SECRET=never-read");
    writeFileSync(join(managed, "credentials.prod.json"), "never-upload");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const platform = yield* RegistryPlatform;
        const protectedPaths = yield* platform.findProtectedPaths(managed);
        const packaged = yield* Effect.result(
          platform.preparePackage(managed, { operation: "suggest" }),
        );
        return { packaged, protectedPaths };
      }).pipe(
        Effect.provide(
          makeRegistryPlatformLayer({
            configDirectory: join(root, ".selftune"),
            cwd: root,
            deviceId: "test-device",
            homeDirectory: root,
          }),
        ),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(result.protectedPaths).toEqual([
      ".env.local",
      ".git",
      "credentials.prod.json",
      "node_modules",
    ]);
    expect(Result.isFailure(result.packaged)).toBe(true);
    if (Result.isFailure(result.packaged)) {
      expect(result.packaged.failure.message).toContain("protected local path");
    }
  });

  test("rejects oversized files before allocating or building an archive", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-registry-platform-large-"));
    roots.push(root);
    writeFileSync(join(root, "SKILL.md"), "---\nname: deploy\ndescription: Deploy\n---\n");
    writeFileSync(join(root, "large.bin"), Buffer.alloc(2 * 1_024 * 1_024 + 1));

    const outcome = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const platform = yield* RegistryPlatform;
          return yield* platform.preparePush({ operation: "push" });
        }).pipe(
          Effect.provide(
            makeRegistryPlatformLayer({
              configDirectory: join(root, ".selftune"),
              cwd: root,
              deviceId: "test-device",
              homeDirectory: root,
            }),
          ),
          Effect.provide(BunServices.layer),
        ),
      ),
    );

    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) expect(outcome.failure.message).toContain("2 MiB limit");
  });

  test("rejects a managed target reached through a symlinked skill directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-registry-platform-root-link-"));
    roots.push(root);
    const actual = join(root, "actual-deploy");
    const target = join(root, ".claude", "skills", "deploy");
    mkdirSync(actual, { recursive: true });
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    writeFileSync(join(actual, "SKILL.md"), "---\nname: deploy\ndescription: Deploy\n---\n");
    symlinkSync(actual, target);

    const outcome = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const platform = yield* RegistryPlatform;
          return yield* platform.validatePersistedTarget(target, "deploy");
        }).pipe(
          Effect.provide(
            makeRegistryPlatformLayer({
              configDirectory: join(root, ".selftune"),
              cwd: root,
              deviceId: "test-device",
              homeDirectory: root,
            }),
          ),
          Effect.provide(BunServices.layer),
        ),
      ),
    );

    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome))
      expect(outcome.failure.message).toContain("not a real directory");
  });
});
