import { createSkillSet, getSkillSet } from "@selftune/library";
import { handleDashboardApplicationRoute } from "../src/routes/application.js";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";

import type { LibrarySnapshot } from "@selftune/runtime/dashboard-contract";
import { openDb } from "@selftune/local-store";
import { CLIError } from "@selftune/runtime/utils/cli-error";
import {
  CatalogSkillResolverFailure,
  type CatalogSkillPackageResolver,
} from "@selftune/runtime/skill-sets/catalog-resolution";

import {
  dashboardReportDependencyVersion,
  DashboardOperations,
  makeDashboardOperationsLayer,
  reportInvalidationTargets,
} from "../src/dashboard-operations.js";

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
  test("invalidates only the report affected by feedback review mutations", () => {
    expect(reportInvalidationTargets("skillIntelligence")).toEqual(["skillIntelligence"]);
    expect(reportInvalidationTargets("insights")).toEqual(["insights"]);
    expect(reportInvalidationTargets("all")).toEqual([
      "portfolio",
      "skillIntelligence",
      "insights",
      "library",
    ]);
  });

  test("uses report-specific cursors instead of unrelated upload writes", () => {
    const db = openDb(":memory:");
    try {
      const initialSkillIntelligence = dashboardReportDependencyVersion("skill-intelligence", db);
      const initialPortfolio = dashboardReportDependencyVersion("portfolio-audit", db);
      const initialInsights = dashboardReportDependencyVersion("insights", db);

      db.run(
        `INSERT INTO upload_queue (payload_type, payload_json, status, attempts, created_at, updated_at)
         VALUES ('telemetry', '{}', 'pending', 0, '2026-07-23T10:00:00.000Z', '2026-07-23T10:00:00.000Z')`,
      );
      expect(dashboardReportDependencyVersion("skill-intelligence", db)).toBe(
        initialSkillIntelligence,
      );
      expect(dashboardReportDependencyVersion("portfolio-audit", db)).toBe(initialPortfolio);
      expect(dashboardReportDependencyVersion("insights", db)).toBe(initialInsights);

      db.run(
        `INSERT INTO session_telemetry (session_id, timestamp)
         VALUES ('session-1', '2026-07-23T10:01:00.000Z')`,
      );
      expect(dashboardReportDependencyVersion("portfolio-audit", db)).not.toBe(initialPortfolio);
      expect(dashboardReportDependencyVersion("insights", db)).not.toBe(initialInsights);
    } finally {
      db.close();
    }
  });

  test("advances only skill intelligence when an analytical import checkpoint advances", () => {
    const db = openDb(":memory:");
    try {
      const beforeSkillIntelligence = dashboardReportDependencyVersion("skill-intelligence", db);
      const beforePortfolio = dashboardReportDependencyVersion("portfolio-audit", db);
      const beforeInsights = dashboardReportDependencyVersion("insights", db);

      db.run(
        `INSERT INTO analytical_import_checkpoints (
           source_kind, source_identity, source_fingerprint, normalizer_version, imported_at
         ) VALUES ('codex_rollout', 'rollout-1', '128:10', '2026.07.23', '2026-07-23T10:02:00.000Z')`,
      );

      expect(dashboardReportDependencyVersion("skill-intelligence", db)).not.toBe(
        beforeSkillIntelligence,
      );
      expect(dashboardReportDependencyVersion("portfolio-audit", db)).toBe(beforePortfolio);
      expect(dashboardReportDependencyVersion("insights", db)).toBe(beforeInsights);
    } finally {
      db.close();
    }
  });

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

  test("keeps Cloud billing behind the DashboardOperations boundary", async () => {
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        cloudBillingAction: (action) => {
          expect(action).toBe("status");
          return {
            plan: "free",
            subscriptionStatus: "none",
            currentPeriodEnd: null,
            trialEnd: null,
            seatCount: 1,
            hasStripeCustomer: false,
            canManageBilling: true,
            availablePlans: [],
          };
        },
      }),
    );
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const operations = yield* DashboardOperations;
          return yield* operations.cloudBilling("status");
        }),
      );
      expect(result).toMatchObject({ plan: "free", canManageBilling: true });
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

  test("resolves catalog skills before the local create operation", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-local-catalog-set-"));
    const packagePath = join(root, "packages", "flutter");
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
          content_hash: "verified-local-hash",
          upstream_revision: "unverified-upstream-hash",
        }),
    };
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        skillSetConfigRoot: join(root, "config"),
        catalogSkillPackageResolver: resolver,
      }),
    );
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const operations = yield* DashboardOperations;
          return yield* operations.createSkillSet({
            name: "Cross-Platform Mobile",
            description: "A catalog-backed set.",
            harnesses: ["codex"],
            skills: [
              {
                name: "flutter",
                catalog_id: "flutter/skills/flutter",
                source: "flutter/skills",
                install_spec: "flutter/skills@flutter",
                download_url: "https://skills.sh/api/download/flutter/skills/flutter",
              },
            ],
          });
        }),
      );
      const created = Schema.decodeUnknownSync(
        Schema.Struct({
          name: Schema.String,
          skills: Schema.Array(
            Schema.Struct({ name: Schema.String, library_package_path: Schema.String }),
          ),
          resolution_progress: Schema.Array(
            Schema.Struct({ skill_name: Schema.String, phase: Schema.String }),
          ),
        }),
      )(result);
      expect(created.name).toBe("Cross-Platform Mobile");
      expect(created.skills[0]?.name).toBe("flutter");
      expect(created.skills[0]?.library_package_path).toContain(
        join(root, "config", "library", "packages"),
      );
      expect(created.resolution_progress.map((progress) => progress.phase)).toEqual([
        "resolving",
        "validating",
        "ready",
      ]);
    } finally {
      await runtime.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns actionable per-skill catalog failures without creating a partial set", async () => {
    const resolver: CatalogSkillPackageResolver = {
      resolve: (skill) =>
        Effect.fail(
          CatalogSkillResolverFailure.make({
            skill_name: skill.name,
            catalog_id: skill.catalog_id,
            phase: "downloading",
            code: "CATALOG_HTTP_ERROR",
            message: "Catalog download failed with HTTP 503",
            retryable: true,
          }),
        ),
    };
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({ catalogSkillPackageResolver: resolver }),
    );
    try {
      const error = await runtime.runPromise(
        Effect.gen(function* () {
          const operations = yield* DashboardOperations;
          return yield* Effect.flip(
            operations.createSkillSet({
              name: "Cross-Platform Mobile",
              harnesses: ["codex"],
              skills: [
                {
                  name: "flutter",
                  catalog_id: "flutter/skills/flutter",
                  source: "flutter/skills",
                  install_spec: "flutter/skills@flutter",
                  download_url: "https://skills.sh/api/download/flutter/skills/flutter",
                },
              ],
            }),
          );
        }),
      );

      expect(error.code).toBe("CATALOG_SKILL_RESOLUTION_FAILED");
      expect(error.status).toBe(422);
      expect(error.retryable).toBe(true);
      expect(error.failures).toEqual([
        {
          skill_name: "flutter",
          catalog_id: "flutter/skills/flutter",
          phase: "downloading",
          code: "CATALOG_HTTP_ERROR",
          message: "Catalog download failed with HTTP 503",
          retryable: true,
        },
      ]);
      expect(error.progress?.map((entry) => entry.phase)).toEqual(["resolving"]);
    } finally {
      await runtime.dispose();
    }
  });
});

test("license routes preview and revise a Set with no installed Library location", async () => {
  const root = mkdtempSync(join(tmpdir(), "selftune-license-route-"));
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(
    join(source, "SKILL.md"),
    "---\nname: marketing-social\ndescription: Marketing\n---\n",
  );
  const options = { configRoot: join(root, "config") };
  const set = createSkillSet(
    {
      name: "Ithraa",
      harnesses: ["codex"],
      skills: [{ name: "marketing-social", package_path: source }],
    },
    options,
  );
  const runtime = ManagedRuntime.make(
    makeDashboardOperationsLayer({
      skillSetConfigRoot: options.configRoot,
      libraryLoader: () => {
        throw new Error("Installed Library must not be consulted for pinned Set drafts");
      },
    }),
  );
  const origin = "http://127.0.0.1:3141";
  const body = {
    set_id: set.set_id,
    skill_id: "marketing-social",
    terms: { copyright_holder: "Daniel Petro", licensed_organization: "Ithraa Center", year: 2026 },
  };
  async function request(action: string, input: unknown, status = 200) {
    const req = new Request(`${origin}/api/v2/library/license/${action}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const result = await runtime.runPromise(
      handleDashboardApplicationRoute(req, new URL(req.url), { allowedOrigins: new Set([origin]) }),
    );
    expect(result?.status).toBe(status);
    if (!result) throw new Error("License route did not handle the request");
    return result.json();
  }
  try {
    const preview = await request("preview", body);
    expect(preview.files).toHaveLength(2);
    expect(getSkillSet(set.set_id, options).revision).toBe(1);
    await request("apply", { ...body, preview_id: preview.previewId });
    expect(getSkillSet(set.set_id, options).revision).toBe(2);
    const blocked = await request("preview", body, 409);
    expect(JSON.stringify(blocked)).toContain("already bundles a LICENSE file");
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
