"use client";

import { LinkIcon, ShieldAlertIcon } from "lucide-react";

import type { DashboardProjectsActions } from "../../host";
import type { ProjectPlanModel } from "../../models";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@selftune/ui/primitives";

function actionReason(action: { access: string; reason?: string }): string | null {
  return action.access === "unavailable" ? (action.reason ?? "This action is unavailable.") : null;
}

export function PlanReview({
  plan,
  actions,
  onApply,
  onResolve,
}: {
  plan: ProjectPlanModel;
  actions: DashboardProjectsActions;
  onApply(): void;
  onResolve(operation: ProjectPlanModel["operations"][number]): void;
}) {
  const applyPending = actions.apply.access === "available" && actions.apply.isPending === true;
  const applyLabel = applyPending
    ? plan.missingDependencies > 0
      ? `Downloading and verifying ${plan.missingDependencies} skill${plan.missingDependencies === 1 ? "" : "s"}`
      : "Applying Skill Set"
    : "Apply Skill Set";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Installation preview</CardTitle>
        <CardDescription>
          {plan.creates} create · {plan.unchanged} unchanged · {plan.missingDependencies} download ·{" "}
          {plan.conflicts} conflicts
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {plan.operations.map((operation) => (
          <div
            key={`${operation.connection}:${operation.skillName}:${operation.targetPath}`}
            className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[100px_140px_minmax(0,1fr)_auto] sm:items-center"
          >
            <Badge variant={operation.action === "conflict" ? "destructive" : "outline"}>
              {operation.action === "conflict" ? (
                <ShieldAlertIcon data-icon="inline-start" />
              ) : null}
              {operation.action}
            </Badge>
            <span className="text-sm font-medium">{operation.skillName}</span>
            <span
              className="min-w-0 truncate font-mono text-xs text-muted-foreground"
              title={operation.targetPath}
            >
              {operation.targetPath}
            </span>
            {operation.action === "conflict" && actions.resolveConflict.access === "available" ? (
              <Button size="sm" variant="outline" onClick={() => onResolve(operation)}>
                Resolve
              </Button>
            ) : null}
          </div>
        ))}
        {plan.conflicts > 0 && actions.resolveConflict.access !== "available" ? (
          <p className="text-sm text-muted-foreground">
            {actionReason(actions.resolveConflict) ??
              "Resolve destination conflicts, then preview again."}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="justify-end">
        <Button
          aria-busy={applyPending}
          disabled={plan.conflicts > 0 || actions.apply.access !== "available" || applyPending}
          onClick={onApply}
        >
          <LinkIcon data-icon="inline-start" />
          {applyLabel}
        </Button>
      </CardFooter>
    </Card>
  );
}
