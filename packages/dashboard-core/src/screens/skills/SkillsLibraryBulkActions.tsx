"use client";

import { useState } from "react";
import { ArchiveIcon, CloudUploadIcon, XIcon } from "lucide-react";
import type { DashboardLibraryActions } from "../../host";
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

interface BulkActionsInput {
  actions: DashboardLibraryActions;
  allSkills: readonly LibrarySkillModel[];
  visibleSkills: readonly LibrarySkillModel[];
  refresh(): void | Promise<void>;
  onError(message: string | null): void;
}

export interface SkillsLibraryBulkActions {
  selectedSkillIds: ReadonlySet<string>;
  selectedSkills: readonly LibrarySkillModel[];
  selectedBackupSkills: readonly LibrarySkillModel[];
  selectedArchiveSkills: readonly LibrarySkillModel[];
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  pending: "archive" | "backup" | null;
  notice: string | null;
  archiveReviewOpen: boolean;
  setArchiveReviewOpen(open: boolean): void;
  setSkillSelected(skillId: string, checked: boolean): void;
  setVisibleSkillsSelected(checked: boolean): void;
  clear(): void;
  backup(): Promise<void>;
  archive(): Promise<void>;
}

export function useSkillsLibraryBulkActions(input: BulkActionsInput): SkillsLibraryBulkActions {
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<"archive" | "backup" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [archiveReviewOpen, setArchiveReviewOpenState] = useState(false);
  const selectedSkills = input.allSkills.filter((skill) => selectedSkillIds.has(skill.id));
  const selectedBackupSkills = selectedSkills.filter((skill) =>
    skill.locations.some((location) => location.sourceKind !== "cached"),
  );
  const selectedArchiveSkills = selectedSkills.filter((skill) => skill.archiveRecommendation);
  const allVisibleSelected =
    input.visibleSkills.length > 0 &&
    input.visibleSkills.every((skill) => selectedSkillIds.has(skill.id));
  const someVisibleSelected = input.visibleSkills.some((skill) => selectedSkillIds.has(skill.id));

  const clear = () => setSelectedSkillIds(new Set());
  const setSkillSelected = (skillId: string, checked: boolean) => {
    setSelectedSkillIds((current) => {
      const next = new Set(current);
      if (checked) next.add(skillId);
      else next.delete(skillId);
      return next;
    });
  };
  const setVisibleSkillsSelected = (checked: boolean) => {
    setSelectedSkillIds((current) => {
      const next = new Set(current);
      for (const skill of input.visibleSkills) {
        if (checked) next.add(skill.id);
        else next.delete(skill.id);
      }
      return next;
    });
  };
  const setArchiveReviewOpen = (open: boolean) => {
    if (pending === null) setArchiveReviewOpenState(open);
  };
  const backup = async () => {
    const action = input.actions.backup;
    if (action?.access !== "available" || selectedBackupSkills.length === 0) return;
    setPending("backup");
    input.onError(null);
    setNotice(null);
    try {
      const results = await Promise.allSettled(
        selectedBackupSkills.map((skill) => action.execute(skill.id)),
      );
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length > 0) {
        input.onError(
          `${failed.length} of ${results.length} selected skill backups failed. Try those skills again individually.`,
        );
      } else {
        setNotice(
          `Backed up ${results.length} selected skill${results.length === 1 ? "" : "s"} to Cloud.`,
        );
        clear();
      }
      await input.refresh();
    } catch (error) {
      input.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  };
  const archive = async () => {
    const action = input.actions.archive;
    if (action.access !== "available" || selectedArchiveSkills.length === 0) return;
    setPending("archive");
    input.onError(null);
    setNotice(null);
    let succeeded = 0;
    let failed = 0;
    try {
      const archiveInputs = selectedArchiveSkills.flatMap((skill) => {
        const recommendation = skill.archiveRecommendation;
        return recommendation
          ? [{ skillName: skill.name, skillPath: recommendation.skillPath }]
          : [];
      });
      const batchAction = input.actions.archiveMany;
      if (batchAction?.access === "available") {
        const result = await batchAction.execute(archiveInputs);
        succeeded = result.succeeded;
        failed = result.failed;
      } else {
        for (const archiveInput of archiveInputs) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- Filesystem moves are intentionally bounded to avoid a refresh storm on hosts without batch support.
            await action.execute(archiveInput);
            succeeded += 1;
          } catch {
            failed += 1;
          }
        }
      }

      if (failed > 0) {
        input.onError(
          `${failed} of ${succeeded + failed} selected skill archives failed. Review those skills individually.`,
        );
      }
      if (succeeded > 0) {
        setNotice(`Archived ${succeeded} selected skill${succeeded === 1 ? "" : "s"}.`);
        clear();
        setArchiveReviewOpenState(false);
      }

      try {
        await input.refresh();
      } catch (error) {
        input.onError(
          succeeded > 0
            ? "The skills were archived, but the Library could not refresh. Reload to view the current state."
            : error instanceof Error
              ? error.message
              : String(error),
        );
      }
    } catch (error) {
      input.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  };
  return {
    selectedSkillIds,
    selectedSkills,
    selectedBackupSkills,
    selectedArchiveSkills,
    allVisibleSelected,
    someVisibleSelected,
    pending,
    notice,
    archiveReviewOpen,
    setArchiveReviewOpen,
    setSkillSelected,
    setVisibleSkillsSelected,
    clear,
    backup,
    archive,
  };
}

export function SkillsLibraryBulkToolbar({
  bulk,
  actions,
}: {
  bulk: SkillsLibraryBulkActions;
  actions: DashboardLibraryActions;
}) {
  if (bulk.selectedSkills.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2">
      <span className="mr-auto text-sm font-medium">{bulk.selectedSkills.length} selected</span>
      {actions.backup?.access === "available" ? (
        <Button
          variant="outline"
          size="sm"
          disabled={bulk.selectedBackupSkills.length === 0 || bulk.pending !== null}
          onClick={() => void bulk.backup()}
        >
          <CloudUploadIcon data-icon="inline-start" />
          {bulk.pending === "backup"
            ? "Backing up"
            : `Back up ${bulk.selectedBackupSkills.length || ""}`.trim()}
        </Button>
      ) : null}
      {actions.archive.access === "available" ? (
        <Button
          variant="outline"
          size="sm"
          disabled={bulk.selectedArchiveSkills.length === 0 || bulk.pending !== null}
          onClick={() => bulk.setArchiveReviewOpen(true)}
        >
          <ArchiveIcon data-icon="inline-start" /> Archive {bulk.selectedArchiveSkills.length || ""}
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" disabled={bulk.pending !== null} onClick={bulk.clear}>
        <XIcon data-icon="inline-start" /> Clear
      </Button>
    </div>
  );
}

export function SkillsLibraryBulkArchiveDialog({ bulk }: { bulk: SkillsLibraryBulkActions }) {
  const skipped = bulk.selectedSkills.length - bulk.selectedArchiveSkills.length;
  return (
    <Dialog open={bulk.archiveReviewOpen} onOpenChange={bulk.setArchiveReviewOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Archive {bulk.selectedArchiveSkills.length} selected skill
            {bulk.selectedArchiveSkills.length === 1 ? "" : "s"}?
          </DialogTitle>
          <DialogDescription>
            Each eligible skill leaves active agent context and receives its own restore receipt. No
            skill files are permanently deleted.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {bulk.selectedArchiveSkills.map((skill) => (
            <div key={skill.id} className="rounded-lg border bg-muted/30 px-3 py-2">
              <p className="text-sm font-medium">{skill.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {skill.archiveRecommendation?.reason}
              </p>
            </div>
          ))}
        </div>
        {skipped > 0 ? (
          <p className="text-sm text-muted-foreground">
            {skipped} selected skill{skipped === 1 ? " is" : "s are"} not eligible and will be
            skipped.
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={bulk.pending !== null}
            onClick={() => bulk.setArchiveReviewOpen(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={bulk.pending !== null || bulk.selectedArchiveSkills.length === 0}
            onClick={() => void bulk.archive()}
          >
            <ArchiveIcon data-icon="inline-start" />
            {bulk.pending === "archive" ? "Archiving" : "Archive selected"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
