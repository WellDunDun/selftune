import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { LocalDatabaseService } from "@selftune/local-store";
import {
  makeMaterializedCacheLayer,
  type CachedOperation,
  type MaterializedCacheOptions,
} from "./operation-cache.js";
import { attempt, DashboardOperationError, operationError } from "./dashboard-operation-errors.js";
import { computeReportInWorker, resolveReportComputeOptions } from "./report-compute.js";
import { dashboardReportDependencyVersion } from "./report-version.js";
import {
  reportPayloadSchemas,
  type DashboardReportName,
  type DashboardReportPayloads,
} from "./report-contract.js";

type ReportCache<Name extends DashboardReportName> = CachedOperation<
  DashboardReportPayloads[Name],
  DashboardOperationError,
  never
>;
export class PortfolioAuditCache extends Context.Service<
  PortfolioAuditCache,
  ReportCache<"portfolio-audit">
>()("SelfTune/PortfolioAuditCache") {}
export class SkillIntelligenceCache extends Context.Service<
  SkillIntelligenceCache,
  ReportCache<"skill-intelligence">
>()("SelfTune/SkillIntelligenceCache") {}
export class InsightsCache extends Context.Service<InsightsCache, ReportCache<"insights">>()(
  "SelfTune/InsightsCache",
) {}
export class LibraryCache extends Context.Service<LibraryCache, ReportCache<"library">>()(
  "SelfTune/LibraryCache",
) {}

export interface DashboardReportCacheOptions {
  readonly skillSetConfigRoot?: string;
  readonly portfolioSearchDirs?: string[];
  readonly quarantineRoot?: string;
  readonly reportVersionReaders?: Partial<Record<DashboardReportName, () => string>>;
  readonly portfolioLoader?: () => DashboardReportPayloads["portfolio-audit"];
  readonly skillIntelligenceLoader?: () =>
    | DashboardReportPayloads["skill-intelligence"]
    | Promise<DashboardReportPayloads["skill-intelligence"]>;
  readonly insightsLoader?: () =>
    | DashboardReportPayloads["insights"]
    | Promise<DashboardReportPayloads["insights"]>;
  readonly libraryLoader?: () =>
    | DashboardReportPayloads["library"]
    | Promise<DashboardReportPayloads["library"]>;
}

function cacheLayer<I, A>(
  key: Context.Service<I, CachedOperation<A, DashboardOperationError, never>>,
  operation: string,
  compute: Effect.Effect<A, DashboardOperationError>,
  loader: (() => A | Promise<A>) | undefined,
  options: MaterializedCacheOptions<A>,
) {
  return loader
    ? Layer.succeed(key)({ read: attempt(operation, loader), invalidate: Effect.void })
    : makeMaterializedCacheLayer(key, compute, options);
}

export function makeDashboardReportCachesLayer(options: DashboardReportCacheOptions) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const database = Option.getOrUndefined(
        yield* Effect.serviceOption(LocalDatabaseService),
      )?.sqlite;
      const reportOptions = resolveReportComputeOptions({
        configRoot: options.skillSetConfigRoot,
        searchDirs: options.portfolioSearchDirs,
        quarantineRoot: options.quarantineRoot,
      });
      const reportsDir = join(reportOptions.storagePaths.configRoot, "cache", "reports");
      const readVersion = (name: DashboardReportName) =>
        options.reportVersionReaders?.[name] ??
        (() => dashboardReportDependencyVersion(name, database));
      const compute = <Name extends DashboardReportName>(name: Name, operation: string) =>
        computeReportInWorker(name, reportOptions, reportsDir).pipe(
          Effect.mapError((cause) => operationError(operation, cause)),
        );
      return Layer.mergeAll(
        cacheLayer(
          PortfolioAuditCache,
          "portfolio.load",
          compute("portfolio-audit", "portfolio.load"),
          options.portfolioLoader,
          {
            artifactPath: join(reportsDir, "portfolio-audit.json"),
            schema: reportPayloadSchemas["portfolio-audit"],
            readVersion: readVersion("portfolio-audit"),
          },
        ),
        cacheLayer(
          SkillIntelligenceCache,
          "skill_intelligence.load",
          compute("skill-intelligence", "skill_intelligence.load"),
          options.skillIntelligenceLoader,
          {
            artifactPath: join(reportsDir, "skill-intelligence.json"),
            schema: reportPayloadSchemas["skill-intelligence"],
            readVersion: readVersion("skill-intelligence"),
          },
        ),
        cacheLayer(
          InsightsCache,
          "insights.load",
          compute("insights", "insights.load"),
          options.insightsLoader,
          {
            artifactPath: join(reportsDir, "insights.json"),
            schema: reportPayloadSchemas.insights,
            readVersion: readVersion("insights"),
          },
        ),
        cacheLayer(
          LibraryCache,
          "library.load",
          compute("library", "library.load"),
          options.libraryLoader,
          {
            artifactPath: join(reportsDir, "library.json"),
            schema: reportPayloadSchemas.library,
            readVersion: readVersion("library"),
          },
        ),
      );
    }),
  );
}
