import { readConfiguredAgentType, getSelftuneVersion } from "@selftune/runtime/utils/selftune-meta";
import { getDb } from "@selftune/runtime/localdb/db";
import type { OrchestrateResult } from "../orchestrate.js";
import { SELFTUNE_CONFIG_PATH } from "@selftune/runtime/constants";
import type { AlphaIdentity } from "@selftune/runtime/types";

export async function runPostOrchestrateSideEffects(input: {
  result: OrchestrateResult;
  dryRun: boolean;
  readAlphaIdentity: () => AlphaIdentity | null;
}): Promise<void> {
  const { result, dryRun, readAlphaIdentity } = input;
  const alphaIdentity = readAlphaIdentity();

  if (alphaIdentity?.enrolled) {
    try {
      console.error("[orchestrate] Running alpha upload cycle...");
      const { runUploadCycle } = await import("@selftune/runtime/alpha-upload/index");
      const uploadSummary = await runUploadCycle(getDb(), {
        enrolled: true,
        userId: alphaIdentity.user_id,
        agentType: readConfiguredAgentType(SELFTUNE_CONFIG_PATH, "unknown"),
        selftuneVersion: getSelftuneVersion(),
        dryRun,
        apiKey: alphaIdentity.api_key,
      });
      result.uploadSummary = uploadSummary;
      console.error(
        `[orchestrate] Alpha upload: prepared=${uploadSummary.prepared}, sent=${uploadSummary.sent}, failed=${uploadSummary.failed}, skipped=${uploadSummary.skipped}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[orchestrate] Alpha upload failed (non-blocking): ${msg}`);
    }
  }

  if (alphaIdentity?.api_key) {
    try {
      const { flushCreatorContributionSignals } =
        await import("@selftune/runtime/contribution-relay");
      const relayResult = await flushCreatorContributionSignals(getDb(), {
        apiKey: alphaIdentity.api_key,
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
