"use client";

import { useState, type ReactNode } from "react";
import { LibraryIcon, Undo2Icon } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@selftune/ui/primitives";
import type { DashboardLibraryActions } from "../../host";
import type { LibrarySkillModel } from "../../models";
import { ContextSavings } from "./ContextSavings";
import { OnDemandSkillTable } from "./OnDemandSkillTable";

export function OnDemandSkillsReview({
  skills,
  actions,
  refresh,
  introduction,
  initialOpen = false,
  onDismiss,
}: {
  skills: readonly LibrarySkillModel[];
  actions: Pick<DashboardLibraryActions, "moveToLibraryMany" | "restore">;
  refresh(): void | Promise<void>;
  introduction?: ReactNode;
  initialOpen?: boolean;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<"move" | "undo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<readonly { skillName: string; restoreId: string }[]>([]);
  const eligible = skills.filter(
    (skill) =>
      skill.lifecycle === "active" &&
      (skill.onDemandSources?.length ||
        skill.onDemandSource?.contentHash ||
        skill.archiveRecommendation?.contentHash),
  );
  const suggestions = eligible.filter(
    (skill) => skill.onDemandReason || skill.archiveRecommendation,
  );
  const chosen = eligible.filter((skill) => selected.has(skill.id));
  const installations = chosen.reduce(
    (count, skill) => count + (skill.onDemandSources?.length ?? 1),
    0,
  );
  const action = actions.moveToLibraryMany;
  if (action?.access !== "available") return null;

  const move = async () => {
    if (pending || !chosen.length) return;
    setPending("move");
    setError(null);
    setNotice(null);
    try {
      const inputs = chosen.flatMap((skill) => {
        if (skill.onDemandSources?.length)
          return skill.onDemandSources.map((source) => ({
            skillName: skill.name,
            skillPath: source.skillPath,
            expectedContentHash: source.contentHash,
          }));
        const recommendation = skill.onDemandSource ?? skill.archiveRecommendation;
        return recommendation?.contentHash
          ? [
              {
                skillName: skill.name,
                skillPath: recommendation.skillPath,
                expectedContentHash: recommendation.contentHash,
              },
            ]
          : [];
      });
      const result = await action.execute(inputs);
      setReceipts((previous) => [
        ...new Map(
          [...previous, ...(result.receipts ?? [])].map((receipt) => [receipt.restoreId, receipt]),
        ).values(),
      ]);
      if (result.succeeded) {
        setNotice(
          `${result.succeeded} installation${result.succeeded === 1 ? "" : "s"} moved to the searchable Library. Identical copies share one revision. Undo restores original locations.`,
        );
      }
      if (result.failed) {
        setError(
          result.failures
            ?.map((failure) => `${failure.skillName}: ${failure.message}`)
            .join("\n") ||
            `${result.failed} skills could not be moved. Refresh and review them again.`,
        );
      } else {
        if (!introduction) setOpen(false);
        setSelected(new Set());
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const undo = async () => {
    const restore = actions.restore;
    if (restore.access !== "available" || pending) return;
    setPending("undo");
    setError(null);
    const remaining = [];
    for (const receipt of receipts) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- Restore filesystem locations sequentially and retain failed receipts for retry.
        await restore.execute(receipt.restoreId);
      } catch (cause) {
        remaining.push(receipt);
        setError(`${receipt.skillName}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    setReceipts(remaining);
    setNotice(
      remaining.length
        ? "Some installations could not be restored. Undo can retry them."
        : "Restored the original installations. The searchable Library copies are still available.",
    );
    try {
      await refresh();
    } catch {
      setError("Refresh the Library to see the restored installations.");
    }
    setPending(null);
  };

  const choices = (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        disabled={!suggestions.length || pending !== null}
        onClick={() => {
          setSelected(new Set());
          setError(null);
          setOpen(true);
        }}
      >
        <LibraryIcon /> Review {suggestions.length} suggestion
        {suggestions.length === 1 ? "" : "s"}
      </Button>
      <Button
        variant="outline"
        disabled={!eligible.length || pending !== null}
        onClick={() => {
          setSelected(new Set());
          setError(null);
          setOpen(true);
        }}
      >
        Choose skills
      </Button>
      <span className="text-xs text-muted-foreground">
        {suggestions.length
          ? "Based on local usage history"
          : "No inactivity suggestions yet. You can still choose skills yourself."}
      </span>
    </div>
  );
  const feedback = (
    <>
      {notice ? (
        <div role="status" className="rounded-lg border bg-muted/30 p-3 text-sm">
          {notice}
          {receipts.length && actions.restore.access === "available" ? (
            <Button
              className="ml-2"
              size="sm"
              variant="outline"
              disabled={pending !== null}
              onClick={() => void undo()}
            >
              <Undo2Icon />
              {pending === "undo" ? "Restoring" : "Undo"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error && !open ? (
        <p role="alert" className="whitespace-pre-line text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
  const close = () => {
    setOpen(false);
    onDismiss?.();
  };
  return (
    <div className={introduction ? "" : "mt-4 space-y-3"}>
      {introduction ? (
        <Button variant="outline" onClick={() => setOpen(true)}>
          <LibraryIcon /> Use on demand
        </Button>
      ) : (
        <>
          {choices}
          {feedback}
        </>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) {
            if (next) setOpen(true);
            else close();
          }
        }}
      >
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-[min(1200px,96vw)]">
          <DialogHeader>
            <DialogTitle>Keep skills for on-demand use</DialogTitle>
            <DialogDescription>
              Choose which skills should stop loading by default. Keep them searchable for the tasks
              that need them.
            </DialogDescription>
          </DialogHeader>
          {introduction ? feedback : null}
          <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0">
              <OnDemandSkillTable
                skills={eligible}
                selected={selected}
                onSelectionChange={setSelected}
                pending={pending !== null}
              />
              {introduction ? (
                <details className="mt-3 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">How to load a saved skill later</summary>
                  <div className="mt-3">{introduction}</div>
                </details>
              ) : null}
            </div>
            <aside
              aria-label="Selection impact"
              className="min-w-0 space-y-4 rounded-lg border bg-muted/20 p-4"
            >
              <div>
                <h3 className="text-base font-semibold">
                  {chosen.length
                    ? `${chosen.length} skill${chosen.length === 1 ? "" : "s"} will load only on request`
                    : "Select skills to preview the change"}
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {chosen.length
                    ? `${installations} active installation${installations === 1 ? "" : "s"} removed from default discovery. A verified Library copy stays searchable.`
                    : "Nothing changes until you confirm. Select a row to see its estimated context savings."}
                </p>
              </div>
              {chosen.length ? (
                <div className="text-sm">
                  <p className="font-medium">
                    {chosen.length === 1 ? chosen[0]?.name : "Your selected skills"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Your agent can find and activate {chosen.length === 1 ? "it" : "them"} for a
                    task. Identical copies consolidate automatically. Undo restores every original
                    location.
                  </p>
                </div>
              ) : null}
              <ContextSavings skills={skills} selectedIds={selected} />
              <p className="text-xs text-muted-foreground">
                Estimates apply to new sessions. Existing conversations do not shrink.
              </p>
            </aside>
          </div>
          {error ? (
            <p role="alert" className="whitespace-pre-line text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={pending !== null} onClick={close}>
              {introduction ? "Done" : "Cancel"}
            </Button>
            <Button disabled={!chosen.length || pending !== null} onClick={() => void move()}>
              {pending === "move"
                ? "Moving to Library"
                : `Move ${chosen.length} skill${chosen.length === 1 ? "" : "s"} to on-demand`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
