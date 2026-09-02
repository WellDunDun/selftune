import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { resolveSkillSetDependencies } from "../src";

const hash = (digit: string) => digit.repeat(64);

const packageVersion = (
  packageId: string,
  version: string,
  options: {
    readonly requires?: ReadonlyArray<{
      readonly package_id: string;
      readonly version_range: string;
    }>;
    readonly optional?: ReadonlyArray<{
      readonly package_id: string;
      readonly version_range: string;
    }>;
    readonly conflicts?: ReadonlyArray<{ readonly package_id: string }>;
    readonly provides?: ReadonlyArray<string>;
    readonly requiredCapabilities?: ReadonlyArray<string>;
  } = {},
) => ({
  package_id: packageId,
  version,
  revision_sha256: hash(String((packageId.length + version.length) % 9)),
  dependencies: {
    requires: options.requires ?? [],
    optional: options.optional ?? [],
    conflicts: options.conflicts ?? [],
  },
  compatibility: {
    harnesses: ["codex"] as const,
    required_capabilities: options.requiredCapabilities ?? [],
  },
  provides: options.provides ?? [],
});

const input = (packages: ReadonlyArray<ReturnType<typeof packageVersion>>, roots = ["app"]) => ({
  roots,
  available_packages: packages,
  environment: { harness: "codex" as const, capabilities: ["filesystem"] },
  current_lock: [],
});

const expectReason = <A>(effect: Effect.Effect<A, { readonly reason: string }>, reason: string) =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(effect);
    assert.strictEqual(failure.reason, reason);
  });

describe("skill set package dependencies", () => {
  it.effect("resolves required and available optional packages into a deterministic lock", () =>
    Effect.gen(function* () {
      const app = packageVersion("app", "1.0.0", {
        requires: [{ package_id: "core", version_range: ">=1.0.0 <2.0.0" }],
        optional: [{ package_id: "theme", version_range: ">=1.0.0 <2.0.0" }],
      });
      const result = yield* resolveSkillSetDependencies(
        input([
          packageVersion("theme", "1.0.0"),
          packageVersion("core", "1.1.0"),
          app,
          packageVersion("core", "1.0.0"),
        ]),
      );

      assert.deepStrictEqual(
        result.lock.entries.map(({ package_id, version, dependency_kind }) => ({
          package_id,
          version,
          dependency_kind,
        })),
        [
          { package_id: "app", version: "1.0.0", dependency_kind: "root" },
          { package_id: "core", version: "1.1.0", dependency_kind: "required" },
          { package_id: "theme", version: "1.0.0", dependency_kind: "optional" },
        ],
      );
      assert.deepStrictEqual(result.impact, {
        added: ["app@1.0.0", "core@1.1.0", "theme@1.0.0"],
        changed: [],
        removed: [],
        unchanged: [],
      });
    }),
  );

  it.effect("reports missing required packages but skips unavailable optional packages", () =>
    Effect.gen(function* () {
      const optionalOnly = yield* resolveSkillSetDependencies(
        input([
          packageVersion("app", "1.0.0", {
            optional: [{ package_id: "theme", version_range: ">=1.0.0 <2.0.0" }],
          }),
        ]),
      );
      assert.deepStrictEqual(
        optionalOnly.lock.entries.map((entry) => entry.package_id),
        ["app"],
      );

      yield* expectReason(
        resolveSkillSetDependencies(
          input([
            packageVersion("app", "1.0.0", {
              requires: [{ package_id: "core", version_range: ">=1.0.0 <2.0.0" }],
            }),
          ]),
        ),
        "missing_dependency",
      );
    }),
  );

  it.effect(
    "selects the highest version in the intersection of constraints from multiple roots",
    () =>
      Effect.gen(function* () {
        const result = yield* resolveSkillSetDependencies(
          input(
            [
              packageVersion("alpha", "1.0.0", {
                requires: [{ package_id: "core", version_range: ">=1.0.0 <3.0.0" }],
              }),
              packageVersion("beta", "1.0.0", {
                requires: [{ package_id: "core", version_range: ">=1.0.0 <2.0.0" }],
              }),
              packageVersion("core", "2.5.0"),
              packageVersion("core", "1.5.0"),
            ],
            ["alpha", "beta"],
          ),
        );

        assert.strictEqual(
          result.lock.entries.find((entry) => entry.package_id === "core")?.version,
          "1.5.0",
        );
      }),
  );

  it.effect("removes dependencies owned only by a version rejected during backtracking", () =>
    Effect.gen(function* () {
      const result = yield* resolveSkillSetDependencies(
        input(
          [
            packageVersion("alpha", "1.0.0", {
              requires: [{ package_id: "core", version_range: ">=1.0.0 <3.0.0" }],
            }),
            packageVersion("beta", "1.0.0", {
              requires: [{ package_id: "core", version_range: ">=1.0.0 <2.0.0" }],
            }),
            packageVersion("core", "2.5.0", {
              requires: [{ package_id: "legacy", version_range: ">=1.0.0 <2.0.0" }],
            }),
            packageVersion("core", "1.5.0"),
            packageVersion("legacy", "1.0.0"),
          ],
          ["alpha", "beta"],
        ),
      );

      assert.deepStrictEqual(
        result.lock.entries.map((entry) => `${entry.package_id}@${entry.version}`),
        ["alpha@1.0.0", "beta@1.0.0", "core@1.5.0"],
      );
      assert.ok(!result.impact.added.includes("legacy@1.0.0"));
    }),
  );

  it.effect("rejects dependency cycles", () =>
    expectReason(
      resolveSkillSetDependencies(
        input([
          packageVersion("app", "1.0.0", {
            requires: [{ package_id: "core", version_range: ">=1.0.0 <2.0.0" }],
          }),
          packageVersion("core", "1.0.0", {
            requires: [{ package_id: "app", version_range: ">=1.0.0 <2.0.0" }],
          }),
        ]),
      ),
      "dependency_cycle",
    ),
  );

  it.effect("rejects packages that are incompatible with the target harness or capabilities", () =>
    expectReason(
      resolveSkillSetDependencies(
        input([
          packageVersion("app", "1.0.0", {
            requiredCapabilities: ["browser"],
          }),
        ]),
      ),
      "incompatible_package",
    ),
  );

  it.effect("skips an optional package when its target capabilities are unavailable", () =>
    Effect.gen(function* () {
      const result = yield* resolveSkillSetDependencies(
        input([
          packageVersion("app", "1.0.0", {
            optional: [{ package_id: "browser-tools", version_range: ">=1.0.0 <2.0.0" }],
          }),
          packageVersion("browser-tools", "1.0.0", { requiredCapabilities: ["browser"] }),
        ]),
      );
      assert.deepStrictEqual(
        result.lock.entries.map((entry) => entry.package_id),
        ["app"],
      );
    }),
  );

  it.effect("rejects explicit package conflicts", () =>
    expectReason(
      resolveSkillSetDependencies(
        input(
          [
            packageVersion("app", "1.0.0", { conflicts: [{ package_id: "legacy" }] }),
            packageVersion("legacy", "1.0.0"),
          ],
          ["app", "legacy"],
        ),
      ),
      "package_conflict",
    ),
  );

  it.effect("previews added, changed, removed, and unchanged locked packages", () =>
    Effect.gen(function* () {
      const result = yield* resolveSkillSetDependencies({
        ...input([
          packageVersion("app", "2.0.0", {
            requires: [{ package_id: "core", version_range: ">=1.0.0 <2.0.0" }],
          }),
          packageVersion("core", "1.0.0"),
        ]),
        current_lock: [
          { package_id: "app", version: "1.0.0", revision_sha256: hash("1") },
          {
            package_id: "core",
            version: "1.0.0",
            revision_sha256: packageVersion("core", "1.0.0").revision_sha256,
          },
          { package_id: "old", version: "1.0.0", revision_sha256: hash("5") },
        ],
      });

      assert.deepStrictEqual(result.impact, {
        added: [],
        changed: [{ package_id: "app", from: "1.0.0", to: "2.0.0" }],
        removed: ["old@1.0.0"],
        unchanged: ["core@1.0.0"],
      });
    }),
  );
});
