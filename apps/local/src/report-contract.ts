import * as Schema from "effect/Schema";
import { LibrarySnapshot } from "@selftune/control-plane";
import {
  InsightsResponseSchema,
  PortfolioAuditResultSchema,
  SkillIntelligenceReportSchema,
} from "@selftune/runtime/dashboard-contract/report-schemas";

export const DashboardReportNameSchema = Schema.Literals([
  "portfolio-audit",
  "skill-intelligence",
  "insights",
  "library",
]);
export type DashboardReportName = typeof DashboardReportNameSchema.Type;

export const ReportComputeStoragePathsSchema = Schema.Struct({
  configRoot: Schema.NonEmptyString,
  localDatabasePath: Schema.NonEmptyString,
  localAnalyticsPath: Schema.NonEmptyString,
});
export type ReportComputeStoragePaths = typeof ReportComputeStoragePathsSchema.Type;

export const ReportComputeOptionsSchema = Schema.Struct({
  configRoot: Schema.optionalKey(Schema.String),
  searchDirs: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  quarantineRoot: Schema.optionalKey(Schema.String),
  storagePaths: Schema.optionalKey(ReportComputeStoragePathsSchema),
});
export type ReportComputeOptions = typeof ReportComputeOptionsSchema.Type;

export const ResolvedReportComputeOptionsSchema = Schema.Struct({
  ...ReportComputeOptionsSchema.fields,
  storagePaths: ReportComputeStoragePathsSchema,
});
export type ResolvedReportComputeOptions = typeof ResolvedReportComputeOptionsSchema.Type;

export const ReportWorkerArgumentsSchema = Schema.Tuple([
  DashboardReportNameSchema,
  Schema.String,
  Schema.NonEmptyString,
]);

export const reportPayloadSchemas = {
  "portfolio-audit": PortfolioAuditResultSchema,
  "skill-intelligence": SkillIntelligenceReportSchema,
  insights: InsightsResponseSchema,
  library: LibrarySnapshot,
};
export type DashboardReportPayloads = {
  [Name in DashboardReportName]: (typeof reportPayloadSchemas)[Name]["Type"];
};

function reportDecoder<A>(schema: Schema.Codec<A>) {
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(schema));
  return (text: string): A => decode(text, { onExcessProperty: "preserve" });
}

type DashboardReportDecoders = {
  [Name in DashboardReportName]: (text: string) => DashboardReportPayloads[Name];
};
const reportDecoders: DashboardReportDecoders = {
  "portfolio-audit": reportDecoder(reportPayloadSchemas["portfolio-audit"]),
  "skill-intelligence": reportDecoder(reportPayloadSchemas["skill-intelligence"]),
  insights: reportDecoder(reportPayloadSchemas.insights),
  library: reportDecoder(reportPayloadSchemas.library),
};

export function decodeReportOutput<Name extends DashboardReportName>(
  report: Name,
  text: string,
): DashboardReportPayloads[Name] {
  return reportDecoders[report](text);
}

export class ReportComputeError extends Schema.TaggedErrorClass<ReportComputeError>()(
  "ReportComputeError",
  {
    report: DashboardReportNameSchema,
    message: Schema.String,
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect),
  },
) {
  static fromCause(report: DashboardReportName, cause: unknown) {
    return cause instanceof ReportComputeError
      ? cause
      : new ReportComputeError({
          report,
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
  }
}
