import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

import type { LibrarySnapshot } from "@selftune/runtime/dashboard-contract";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import { DashboardOperations, makeDashboardOperationsLayer } from "../src/dashboard-operations.js";

const library: LibrarySnapshot = {
  generatedAt: "2026-07-15T08:00:00.000Z",
  counts: { total: 1, active: 1, library: 0, draft: 0, archived: 0 },
  skills: [
    {
      skillId: "research",
      name: "research",
      lifecycle: "active",
      revisions: [],
      locations: [
        {
          sourceKind: "installed",
          packagePath: "/skills/research",
          skillPath: "/skills/research/SKILL.md",
          harness: "codex",
          scope: "global",
          projectRoot: null,
          active: true,
          modifiedAt: "2026-07-15T08:00:00.000Z",
        },
      ],
    },
  ],
};

describe("DashboardOperations", () => {
  test("serves injected application data through the Effect Layer", async () => {
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({ libraryLoader: () => library }),
    );
    try {
      const snapshot = await runtime.runPromise(
        Effect.gen(function* () {
          const operations = yield* DashboardOperations;
          return yield* operations.library;
        }),
      );
      expect(snapshot.skills[0]?.name).toBe("research");
      expect(snapshot.skills[0]?.locations[0]?.harness).toBe("codex");
    } finally {
      await runtime.dispose();
    }
  });

  test("preserves actionable CLI failure metadata", async () => {
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        remoteLibraryAction: () => {
          throw new CLIError(
            "Remote credentials are missing.",
            "CONFIG_MISSING",
            "Configure the Remote Library first.",
            4,
            true,
          );
        },
      }),
    );
    try {
      const error = await runtime.runPromise(
        Effect.gen(function* () {
          const operations = yield* DashboardOperations;
          return yield* Effect.flip(operations.remoteLibrary("sync"));
        }),
      );
      expect(error._tag).toBe("DashboardOperationError");
      expect(error.operation).toBe("remote_library.sync");
      expect(error.code).toBe("CONFIG_MISSING");
      expect(error.status).toBe(400);
      expect(error.retryable).toBe(true);
      expect(error.suggestion).toBe("Configure the Remote Library first.");
    } finally {
      await runtime.dispose();
    }
  });

  test("redacts unexpected failure causes", async () => {
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        libraryLoader: () => {
          throw new Error("do not expose filesystem secrets");
        },
      }),
    );
    try {
      const error = await runtime.runPromise(
        Effect.gen(function* () {
          const operations = yield* DashboardOperations;
          return yield* Effect.flip(operations.library);
        }),
      );
      expect(error.code).toBe("INTERNAL_ERROR");
      expect(error.status).toBe(500);
      expect(error.message).toBe("The local dashboard operation failed.");
      expect(error.message).not.toContain("filesystem secrets");
    } finally {
      await runtime.dispose();
    }
  });
});
