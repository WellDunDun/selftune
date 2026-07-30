import { afterEach, describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
});
