/* oxlint-disable no-console -- orchestration side effects preserve established progress output */
import { getDb } from "@selftune/local-store";
import type { OrchestrateResult } from "../orchestrate.js";
import type { AlphaIdentity } from "@selftune/runtime/types";

type PostOrchestrateResult = Pick<OrchestrateResult, "contributionRelaySummary">;

export async function runPostOrchestrateSideEffects(input: {
  result: PostOrchestrateResult;
  dryRun: boolean;
  readAlphaIdentity: () => AlphaIdentity | null;
  resolveCloudCredential: () => string | null;
}): Promise<void> {
  const { result, dryRun, readAlphaIdentity, resolveCloudCredential } = input;
  const alphaIdentity = readAlphaIdentity();
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
