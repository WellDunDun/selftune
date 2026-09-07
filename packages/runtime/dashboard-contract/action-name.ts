import * as Schema from "effect/Schema";

export const DashboardActionName = Schema.Literals([
  "create-check",
  "report-package",
  "generate-evals",
  "generate-unit-tests",
  "replay-dry-run",
  "measure-baseline",
  "deploy-candidate",
  "watch",
  "orchestrate",
  "rollback",
  "search-run",
]);
export type DashboardActionName = typeof DashboardActionName.Type;
