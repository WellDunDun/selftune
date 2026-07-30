import type { CorrectionLearningPolicy } from "@selftune/local-store";

export type CorrectionCapability = "capture" | "proactive_generation" | "managed_execution";

/** Pure gate: capture defaults independently from opt-in generation and execution. */
export function correctionCapabilityEnabled(
  policy: CorrectionLearningPolicy,
  capability: CorrectionCapability,
  runningInWorkspace: number,
): boolean {
  if (capability === "capture") return policy.capture_enabled;
  if (policy.kill_switch_enabled) return false;
  if (runningInWorkspace >= policy.max_concurrency) return false;
  if (capability === "proactive_generation") return policy.proactive_generation_enabled;
  return policy.managed_execution_enabled;
}

export function remainingCorrectionWorkspaceBudget(
  policy: CorrectionLearningPolicy,
  used: number,
): number {
  return Math.max(0, policy.workspace_budget - Math.max(0, used));
}
