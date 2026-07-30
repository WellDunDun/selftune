import { ArchiveIcon } from "lucide-react";

import type { LibrarySkillModel } from "../../models";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@selftune/ui/primitives";

export function SkillsLibraryArchiveReviewDialog({
  skill,
  pending,
  onClose,
  onConfirm,
}: {
  skill: LibrarySkillModel | null;
  pending: boolean;
  onClose(): void;
  onConfirm(input: { skillName: string; skillPath: string }): void;
}) {
  const recommendation = skill?.archiveRecommendation;
  return (
    <Dialog
      open={recommendation !== null && recommendation !== undefined}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      {skill && recommendation ? (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Archive {skill.name}?</DialogTitle>
            <DialogDescription>{recommendation.reason}</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
            <dt className="text-muted-foreground">Leaves active context</dt>
            <dd className="break-all text-foreground">{recommendation.packagePath}</dd>
            <dt className="text-muted-foreground">Recovery</dt>
            <dd className="text-foreground">Exact location retained in a restore receipt</dd>
            <dt className="text-muted-foreground">Deletion</dt>
            <dd className="text-foreground">None</dd>
          </dl>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                onConfirm({ skillName: skill.name, skillPath: recommendation.skillPath })
              }
            >
              <ArchiveIcon data-icon="inline-start" /> Archive skill
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
