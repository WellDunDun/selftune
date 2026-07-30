/* oxlint-disable no-console -- orchestration side effects preserve established progress output */
import { getDb } from "@selftune/local-store";
import type { OrchestrateResult } from "../orchestrate.js";
import type { AlphaIdentity } from "@selftune/runtime/types";

type PostOrchestrateResult = Pick<OrchestrateResult, "uploadSummary" | "contributionRelaySummary">;

type CompatibilityExportPreparation = (
  database: ReturnType<typeof getDb>,
  options: { readonly enrolled: boolean; readonly dryRun: boolean },
) => { readonly enqueued: number; readonly withheld_unsupported_platform: number };

export async function runPostOrchestrateSideEffects(input: {
  result: PostOrchestrateResult;
  dryRun: boolean;
  readAlphaIdentity: () => AlphaIdentity | null;
  resolveCloudCredential: () => string | null;
  database?: ReturnType<typeof getDb>;
  prepareCompatibilityExport?: CompatibilityExportPreparation;
}): Promise<void> {
  const { result, dryRun, readAlphaIdentity, resolveCloudCredential } = input;
  const alphaIdentity = readAlphaIdentity();
  if (alphaIdentity?.enrolled) {
    try {
      const prepareCompatibilityExport =
        input.prepareCompatibilityExport ??
        (await import("@selftune/runtime/alpha-upload/index")).prepareCompatibilityExport;
      const prepared = prepareCompatibilityExport(input.database ?? getDb(), {
        enrolled: true,
        dryRun,
      });
      result.uploadSummary = {
        enrolled: true,
        prepared: prepared.enqueued,
        sent: 0,
        failed: 0,
        skipped: 0,
      };
      console.error(
        `[orchestrate] Compatibility export prepared=${prepared.enqueued}, withheld=${prepared.withheld_unsupported_platform}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[orchestrate] Compatibility export preparation failed (non-blocking): ${message}`,
      );
    }
  }

  // Creator contributions intentionally remain a separate, explicit relay.
  // Its credential lookup and network work must not be reintroduced into the
  // compatibility-export preparation path above.
  let apiKey: string | null = null;
  if (alphaIdentity?.enrolled) {
    try {
      apiKey = resolveCloudCredential();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[orchestrate] Cloud credential lookup for contribution relay failed (non-blocking): ${msg}`,
      );
    }
  }

  if (apiKey) {
    try {
      const { flushCreatorContributionSignals } =
        await import("@selftune/runtime/contribution-relay");
      const relayResult = await flushCreatorContributionSignals(getDb(), {
        apiKey,
        dryRun,
      });
      if (relayResult.attempted > 0) {
        result.contributionRelaySummary = {
          attempted: relayResult.attempted,
          sent: relayResult.sent,
          failed: relayResult.failed,
        };
        console.error(
          `[orchestrate] Contribution relay: attempted=${relayResult.attempted}, sent=${relayResult.sent}, failed=${relayResult.failed}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[orchestrate] Contribution relay failed (non-blocking): ${msg}`);
    }
  }
}
