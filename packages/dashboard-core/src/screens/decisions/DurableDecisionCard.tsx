"use client";

import { ArchiveRestoreIcon, CheckIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { DashboardDecisionModel } from "../../models";
import { adaptLocalSourceMerge, RunReviewSurface } from "../../review";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@selftune/ui/primitives";

function ImpactDetails({ decision }: { decision: DashboardDecisionModel }) {
  if (decision.kind === "source_merge")
    return (
      <RunReviewSurface
        review={adaptLocalSourceMerge({
          approval_id: decision.id,
          status: decision.status,
          skill_name: decision.skillName,
          source: decision.source,
          harness_id: decision.connection,
          model: decision.model,
          installed_hash: decision.installedHash,
          latest_hash: decision.latestHash,
          created_at: decision.createdAt,
          updated_at: decision.updatedAt,
          expires_at: decision.expiresAt,
          receipt: null,
          failure: decision.failure,
          targets: decision.targets.map((target) => ({
            target_path: target.path,
            summary: target.summary,
            merged_diff: target.mergedDiff,
            conflict_files: target.conflicts,
          })),
        })}
      />
    );
  if (decision.kind === "skill_removal")
    return (
      <div className="flex flex-col gap-2">
        {decision.locations.map((location) => (
          <div key={location.quarantineId} className="rounded-lg border p-3">
            <p className="text-sm font-medium">{location.connection ?? "Unscoped location"}</p>
            <p className="truncate font-mono text-xs">{location.originalSkillPath}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              Package: {location.originalPackagePath}
            </p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              Archive: {location.archiveDestination}
            </p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              Revision: {location.packageVersionHash ?? "Unavailable"}
            </p>
            <p className="text-xs text-muted-foreground">{location.recovery}</p>
          </div>
        ))}
      </div>
    );
  if (decision.kind === "skill_consolidation")
    return (
      <div className="flex flex-col gap-2">
        <p className="truncate font-mono text-xs text-muted-foreground">
          Canonical: {decision.canonicalPackagePath}
        </p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          Revision: {decision.canonicalContentHash}
        </p>
        {decision.targets.map((target) => (
          <div key={target.originalPackagePath} className="rounded-lg border p-3">
            <p className="text-sm font-medium">
              {target.connection ?? "Unscoped location"}
              {target.projectRoot ? ` · ${target.projectRoot}` : ""}
            </p>
            <p className="truncate font-mono text-xs">{target.originalPackagePath}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              Revision: {target.originalContentHash}
            </p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              Archive: {target.archiveDestination}
            </p>
            <p className="text-xs text-muted-foreground">
              {target.action === "replace_with_link"
                ? "Archive this copy, then link the project to the canonical Library revision."
                : "Archive this extra installation without replacing it."}
            </p>
          </div>
        ))}
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {decision.creates} create · {decision.unchanged} unchanged · {decision.conflicts} replace
      </p>
      {decision.impacts.map((impact) => (
        <div key={impact.targetPath} className="rounded-lg border p-3">
          <p className="text-sm font-medium">
            {impact.skillName} · {impact.connection}
          </p>
          <p className="truncate font-mono text-xs">{impact.targetPath}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            Replacement: {impact.replacementSourcePath}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            Revision: {impact.currentFingerprint ?? "Unavailable"} → {impact.replacementFingerprint}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            Backup: {impact.backupPath}
          </p>
          <p className="text-xs text-muted-foreground">{impact.rollback}</p>
        </div>
      ))}
    </div>
  );
}

export function DurableDecisionCard({
  decision,
  pending = false,
  onApprove,
  onDecline,
  onRollback,
}: {
  decision: DashboardDecisionModel;
  pending?: boolean;
  onApprove?(): void;
  onDecline?(): void;
  onRollback?(): void;
}) {
  const [confirmRollbackOpen, setConfirmRollbackOpen] = useState(false);
  const canRollback =
    (decision.kind === "skill_set_conflict" || decision.kind === "skill_consolidation") &&
    decision.recoveryStatus === "applied";
  const rollbackLabel = decision.kind === "skill_consolidation" ? "Undo consolidation" : "Rollback";
  const consolidationLinkCount =
    decision.kind === "skill_consolidation"
      ? decision.targets.filter((target) => target.action === "replace_with_link").length
      : 0;
  return (
    <>
      <Card data-decision-id={decision.id}>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{decision.title}</CardTitle>
            <Badge
              variant={
                decision.status === "failed" ||
                decision.status === "stale" ||
                decision.status === "expired"
                  ? "destructive"
                  : "outline"
              }
            >
              {decision.status}
            </Badge>
          </div>
          <CardDescription>{decision.summary}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ImpactDetails decision={decision} />
          {decision.failure ? (
            <p className="text-sm text-destructive">{decision.failure.message}</p>
          ) : null}
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <p>Prepared {decision.createdAt}</p>
            <p>Expires {decision.expiresAt}</p>
            {decision.audit.map((entry) => (
              <p key={`${entry.event}:${entry.at}`}>
                {entry.event} · {entry.at}
                {entry.reason ? ` · ${entry.reason}` : ""}
              </p>
            ))}
          </div>
          {decision.hasRecoveryReceipt ? (
            <p className="text-xs text-muted-foreground">Recovery receipt recorded.</p>
          ) : null}
        </CardContent>
        {decision.status === "pending" || canRollback ? (
          <CardFooter className="justify-end gap-2">
            {decision.status === "pending" ? (
              <>
                <Button variant="outline" disabled={pending} onClick={onDecline}>
                  <XIcon data-icon="inline-start" />
                  Decline
                </Button>
                <Button disabled={pending} onClick={onApprove}>
                  <CheckIcon data-icon="inline-start" />
                  Approve
                </Button>
              </>
            ) : null}
            {canRollback ? (
              <Button
                variant="outline"
                disabled={pending || !onRollback}
                onClick={() => {
                  if (decision.kind === "skill_consolidation") setConfirmRollbackOpen(true);
                  else onRollback?.();
                }}
              >
                <ArchiveRestoreIcon data-icon="inline-start" />
                {rollbackLabel}
              </Button>
            ) : null}
          </CardFooter>
        ) : null}
      </Card>

      {decision.kind === "skill_consolidation" ? (
        <Dialog open={confirmRollbackOpen} onOpenChange={setConfirmRollbackOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Undo {decision.skillName} consolidation?</DialogTitle>
              <DialogDescription>
                This removes {consolidationLinkCount} managed project{" "}
                {consolidationLinkCount === 1 ? "link" : "links"} and restores{" "}
                {decision.targets.length} archived original{" "}
                {decision.targets.length === 1 ? "copy" : "copies"} from the recovery receipt.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => setConfirmRollbackOpen(false)}
              >
                Keep consolidation
              </Button>
              <Button
                variant="destructive"
                disabled={pending || !onRollback}
                onClick={() => {
                  setConfirmRollbackOpen(false);
                  onRollback?.();
                }}
              >
                Undo consolidation
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
