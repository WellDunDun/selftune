import * as Schema from "effect/Schema";

import { DistributionIdSchema, Sha256Schema, UtcTimestampSchema } from "./distribution";
import {
  RecipientDesktopBootstrapTokenSchema,
  RecipientInstallLifecycleReportingDisclosureSchema,
} from "./recipient-actions";

function strictStruct<const Fields extends Schema.Struct.Fields>(fields: Fields) {
  const allowed = new Set(Object.keys(fields));
  return Schema.Record(Schema.String, Schema.Unknown)
    .check(
      Schema.makeFilter(
        (value) =>
          Object.keys(value).every((key) => allowed.has(key))
            ? undefined
            : "Unexpected desktop-install-finalization property",
        { identifier: "StrictDesktopInstallFinalizeStruct" },
        true,
      ),
    )
    .pipe(Schema.decodeTo(Schema.Struct(fields)));
}

/**
 * Submitted only after the local receipt transaction commits. The server sees
 * digest-only evidence, never paths, machine identity, email, or file details.
 */
export const DesktopInstallFinalizeRequestSchema = strictStruct({
  bootstrapToken: RecipientDesktopBootstrapTokenSchema,
  distributionId: DistributionIdSchema,
  sealedPackageSha256: Sha256Schema,
  pseudonymousInstallKey: Sha256Schema,
  receiptEvidenceSha256: Sha256Schema,
  lifecycleReporting: RecipientInstallLifecycleReportingDisclosureSchema,
});
export type DesktopInstallFinalizeRequest = Schema.Schema.Type<
  typeof DesktopInstallFinalizeRequestSchema
>;

export const DesktopInstallFinalizeResponseSchema = strictStruct({
  finalizationId: Schema.String.check(Schema.isUUID()),
  status: Schema.Literal("finalized"),
  lifecycleReporting: RecipientInstallLifecycleReportingDisclosureSchema,
  finalizedAt: UtcTimestampSchema,
});
export type DesktopInstallFinalizeResponse = Schema.Schema.Type<
  typeof DesktopInstallFinalizeResponseSchema
>;
