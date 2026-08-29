import { assert, describe, layer } from "@effect/vitest";
import { Effect } from "effect";

import { Catalog, CatalogMemory, LibraryObservation, reconcileLibrary } from "../src/index";

const observation = (overrides: Partial<LibraryObservation> = {}) =>
  LibraryObservation.make({
    skillName: "research",
    sourceKind: "installed",
    contentHash: "a".repeat(64),
    packagePath: "/library/research",
    skillPath: "/library/research/SKILL.md",
    harness: "codex",
    scope: "global",
    projectRoot: null,
    active: true,
    modifiedAt: "2026-07-15T08:00:00.000Z",
    lastUsedAt: null,
    origin: null,
    updateStatus: "untracked",
    ...overrides,
  });

describe("canonical Library reconciliation", () => {
  layer(CatalogMemory)("Catalog memory layer", (it) => {
    it.effect("groups installs without collapsing their distinct locations", () =>
      Effect.gen(function* () {
        const snapshot = yield* reconcileLibrary([
          observation(),
          observation({
            packagePath: "/project/.claude/skills/research",
            skillPath: "/project/.claude/skills/research/SKILL.md",
            harness: "claude_code",
            scope: "project",
            projectRoot: "/project",
          }),
        ]);

        assert.strictEqual(snapshot.skills.length, 1);
        assert.strictEqual(snapshot.skills[0]?.revisions.length, 1);
        assert.strictEqual(snapshot.skills[0]?.locations.length, 2);
        assert.deepStrictEqual(
          snapshot.skills[0]?.locations.map((location) => location.harness),
          ["claude_code", "codex"],
        );
      }),
    );

    it.effect("keeps Library-only, draft, and archived states visible", () =>
      Effect.gen(function* () {
        const snapshot = yield* reconcileLibrary([
          observation({ sourceKind: "cached", active: false, harness: null, scope: "library" }),
          observation({
            skillName: "draft-review",
            sourceKind: "draft",
            contentHash: "b".repeat(64),
            packagePath: "/drafts/review",
            skillPath: "/drafts/review/SKILL.md",
            harness: null,
            scope: "library",
            active: false,
          }),
          observation({
            skillName: "stale-helper",
            sourceKind: "archived",
            contentHash: "c".repeat(64),
            packagePath: "/archive/stale-helper",
            skillPath: "/archive/stale-helper/SKILL.md",
            harness: "codex",
            active: false,
          }),
        ]);

        assert.deepStrictEqual(
          snapshot.skills.map((skill) => [skill.name, skill.lifecycle]),
          [
            ["draft-review", "draft"],
            ["research", "library"],
            ["stale-helper", "archived"],
          ],
        );
        assert.strictEqual(snapshot.counts.draft, 1);
        assert.strictEqual(snapshot.counts.archived, 1);
        assert.strictEqual(snapshot.counts.library, 1);
      }),
    );

    it.effect("returns the same ordering for a fixed observation set", () =>
      Effect.gen(function* () {
        const input = [
          observation({ skillName: "zeta", contentHash: null }),
          observation({ skillName: "Alpha", contentHash: "d".repeat(64) }),
          observation({ skillName: "alpha", contentHash: "d".repeat(64) }),
        ];
        const first = yield* reconcileLibrary(input);
        // oxlint-disable-next-line unicorn/no-array-reverse -- Reverse a copy to prove input-order invariance on the ES2022 target.
        const second = yield* reconcileLibrary([...input].reverse());

        assert.deepStrictEqual(first.skills, second.skills);
        assert.deepStrictEqual(
          first.skills.map((skill) => skill.skillId),
          ["alpha", "zeta"],
        );
      }),
    );

    it.effect("stores the latest snapshot behind the Catalog service", () =>
      Effect.gen(function* () {
        yield* reconcileLibrary([observation()]);
        const catalog = yield* Catalog;
        const stored = yield* catalog.snapshot;
        assert.strictEqual(stored.skills[0]?.name, "research");
      }),
    );

    it.effect("aggregates usage, modification, origin, and update state", () =>
      Effect.gen(function* () {
        const snapshot = yield* reconcileLibrary([
          observation({
            modifiedAt: "2026-07-14T08:00:00.000Z",
            lastUsedAt: "2026-07-13T08:00:00.000Z",
            origin: {
              kind: "github",
              label: "selftune-dev/selftune",
              url: "https://github.com/selftune-dev/selftune",
            },
            updateStatus: "current",
          }),
          observation({
            packagePath: "/project/.claude/skills/research",
            skillPath: "/project/.claude/skills/research/SKILL.md",
            harness: "claude_code",
            scope: "project",
            projectRoot: "/project",
            modifiedAt: "2026-07-15T08:00:00.000Z",
            lastUsedAt: "2026-07-15T07:00:00.000Z",
            origin: {
              kind: "github",
              label: "selftune-dev/selftune",
              url: "https://github.com/selftune-dev/selftune",
            },
            updateStatus: "available",
          }),
        ]);

        const skill = snapshot.skills[0];
        assert.strictEqual(skill?.lastUsedAt, "2026-07-15T07:00:00.000Z");
        assert.strictEqual(skill?.lastModifiedAt, "2026-07-15T08:00:00.000Z");
        assert.strictEqual(skill?.origins.length, 1);
        assert.strictEqual(skill?.updateStatus, "available");
      }),
    );
  });
});
