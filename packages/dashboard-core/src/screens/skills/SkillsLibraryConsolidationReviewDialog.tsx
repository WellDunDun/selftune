import { FolderSyncIcon, LinkIcon } from "lucide-react";

import type { LibrarySkillModel } from "../../models";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@selftune/ui/primitives";

export function SkillsLibraryConsolidationReviewDialog({
  skill,
  pending,
  onClose,
  onConfirm,
}: {
  skill: LibrarySkillModel | null;
  pending: boolean;
  onClose(): void;
  onConfirm(skillId: string): void;
}) {
  const recommendation = skill?.consolidationRecommendation;
  return (
    <Dialog
      open={recommendation !== null && recommendation !== undefined}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      {skill && recommendation ? (
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Consolidate {skill.name} installations?</DialogTitle>
            <DialogDescription>{recommendation.reason}</DialogDescription>
          </DialogHeader>

          <section className="rounded-lg border bg-muted/30 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">Canonical Library revision</h3>
              <Badge
                variant={
                  recommendation.canonical.confidence === "source_current" ? "secondary" : "warning"
                }
              >
                {recommendation.canonical.confidence === "source_current"
                  ? "Source-confirmed current"
                  : "Review required"}
              </Badge>
            </div>
            <p className="break-all font-mono text-xs text-muted-foreground">
              {recommendation.canonical.packagePath}
            </p>
            <p className="mt-1 font-mono text-xs">
              {recommendation.canonical.contentHash.slice(0, 16)}
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">Planned changes</h3>
            {recommendation.targets.map((target) => (
              <div
                key={target.packagePath}
                className="grid gap-1 rounded-lg border p-3 text-xs sm:grid-cols-[auto_1fr] sm:gap-x-3"
              >
                <span className="flex items-center gap-1 font-medium">
                  {target.action === "replace_with_link" ? (
                    <LinkIcon className="size-3.5" />
                  ) : (
                    <FolderSyncIcon className="size-3.5" />
                  )}
                  {target.action === "replace_with_link"
                    ? "Archive, then link"
                    : "Archive duplicate"}
                </span>
                <span className="break-all font-mono text-muted-foreground">
                  {target.packagePath}
                </span>
                {target.action === "replace_with_link" ? (
                  <span className="sm:col-start-2 text-muted-foreground">
                    This project path will point to SelfTune&apos;s managed Library package.
                  </span>
                ) : null}
              </div>
            ))}
          </section>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
            <dt className="text-muted-foreground">Archived copies</dt>
            <dd>{recommendation.targets.length}</dd>
            <dt className="text-muted-foreground">Project links</dt>
            <dd>{recommendation.projectCount}</dd>
            <dt className="text-muted-foreground">Permanent deletion</dt>
            <dd>None</dd>
            <dt className="text-muted-foreground">Rollback</dt>
            <dd>Removes managed links and restores every original copy from its receipt.</dd>
          </dl>

          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => onConfirm(skill.id)}>
              <FolderSyncIcon data-icon="inline-start" />
              {pending ? "Consolidating…" : "Archive copies & link projects"}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
