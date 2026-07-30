import type { UninstallOptions, UninstallPlan, UninstallStepId } from "./types.js";

const ALWAYS_RUN_STEPS = [
  "service",
  "credential",
  "schedule",
  "hooks",
  "agents",
] as const satisfies ReadonlyArray<UninstallStepId>;

const FINAL_RUN_STEPS = ["config", "markers"] as const satisfies ReadonlyArray<UninstallStepId>;

export function planUninstall(options: UninstallOptions): UninstallPlan {
  return {
    dryRun: options.dryRun,
    settingsPath: options.settingsPath,
    steps: [
      ...ALWAYS_RUN_STEPS.map((id) => ({ id, disposition: "run" as const })),
      { id: "logs", disposition: options.keepLogs ? "skip" : "run" },
      ...FINAL_RUN_STEPS.map((id) => ({ id, disposition: "run" as const })),
      { id: "npm", disposition: options.npmUninstall ? "run" : "skip" },
    ],
  };
}

export function shouldRunStep(plan: UninstallPlan, id: UninstallStepId): boolean {
  return plan.steps.some((step) => step.id === id && step.disposition === "run");
}
