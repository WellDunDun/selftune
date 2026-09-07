"use client";

import { useMemo, useState } from "react";
import { AlertTriangleIcon, CheckCircle2Icon, FolderArchiveIcon, LinkIcon } from "lucide-react";

import type { DashboardDecisionsActions, DashboardLibraryActions } from "../../host";
import type { DashboardDecisionModel, LibrarySkillModel } from "../../models";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@selftune/ui/primitives";

interface ConsolidationResult {
  skillId: string;
  skillName: string;
  status: "applied" | "failed" | "rolled_back";
  decision?: DashboardDecisionModel;
  error?: string;
  rollbackError?: string;
}

type AvailableConsolidationAction = Extract<
  NonNullable<DashboardLibraryActions["consolidate"]>,
  { access: "available" }
>;

type AvailableDecisionRollbackAction = Extract<
  DashboardDecisionsActions["rollback"],
  { access: "available" }
>;

function plural(value: number, singular: string, pluralValue = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralValue}`;
}

export function SkillsLibraryBulkConsolidationDialog({
  skills,
  action,
  rollbackAction,
  decisionsHref,
  onClose,
  onReviewSkill,
  onApplied,
}: {
  skills: readonly LibrarySkillModel[];
  action: AvailableConsolidationAction;
  rollbackAction?: AvailableDecisionRollbackAction;
  decisionsHref: string;
  onClose(): void;
  onReviewSkill(skill: LibrarySkillModel): void;
  onApplied(): void | Promise<void>;
}) {
  const [reviewSkills] = useState(() => [...skills]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
    () =>
      new Set(
        reviewSkills.flatMap((skill) =>
          skill.consolidationRecommendation?.canonical.confidence === "source_current"
            ? [skill.id]
            : [],
        ),
      ),
  );
  const [phase, setPhase] = useState<
    "review" | "applying" | "results" | "confirming_undo" | "rolling_back"
  >("review");
  const [results, setResults] = useState<ConsolidationResult[]>([]);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [undoAttempted, setUndoAttempted] = useState(false);

  const selectedSkills = useMemo(
    () => reviewSkills.filter((skill) => selectedSkillIds.has(skill.id)),
    [reviewSkills, selectedSkillIds],
  );
  const selectedImpact = useMemo(
    () =>
      selectedSkills.reduce(
        (impact, skill) => ({
          archives: impact.archives + (skill.consolidationRecommendation?.targets.length ?? 0),
          links: impact.links + (skill.consolidationRecommendation?.projectCount ?? 0),
        }),
        { archives: 0, links: 0 },
      ),
    [selectedSkills],
  );
  const reviewRequired = reviewSkills.filter(
    (skill) => skill.consolidationRecommendation?.canonical.confidence === "review_required",
  );
  const rollbackCandidates = results.filter(
    (result) =>
      result.status === "applied" &&
      result.decision?.kind === "skill_consolidation" &&
      result.decision.recoveryStatus === "applied",
  );

  const apply = async () => {
    if (selectedSkills.length === 0) return;
    setPhase("applying");
    setResults([]);
    setRefreshError(null);
    const completed: ConsolidationResult[] = [];
    for (const skill of selectedSkills) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- local filesystem mutations must not race.
        const decision = await action.execute(skill.id);
        completed.push({
          skillId: skill.id,
          skillName: skill.name,
          status: "applied",
          decision,
        });
      } catch (error) {
        completed.push({
          skillId: skill.id,
          skillName: skill.name,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      setResults([...completed]);
    }
    try {
      await onApplied();
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error));
    }
    setPhase("results");
  };

  const undoAll = async () => {
    if (!rollbackAction || rollbackCandidates.length === 0) return;
    setPhase("rolling_back");
    setUndoAttempted(true);
    setRefreshError(null);
    let updated = [...results];
    for (const candidate of rollbackCandidates) {
      const decision = candidate.decision;
      if (!decision) continue;
      try {
        // oxlint-disable-next-line no-await-in-loop -- recovery receipts mutate overlapping local state.
        await rollbackAction.execute(decision.id);
        updated = updated.map((result) =>
          result.skillId === candidate.skillId
            ? { ...result, status: "rolled_back", rollbackError: undefined }
            : result,
        );
      } catch (error) {
        updated = updated.map((result) =>
          result.skillId === candidate.skillId
            ? {
                ...result,
                rollbackError: error instanceof Error ? error.message : String(error),
              }
            : result,
        );
      }
      setResults(updated);
    }
    try {
      await onApplied();
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error));
    }
    setPhase("results");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && phase !== "applying" && phase !== "rolling_back") onClose();
      }}
    >
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        {phase === "confirming_undo" ? (
          <>
            <DialogHeader className="shrink-0 border-b px-5 py-4 pr-14">
              <DialogTitle>Undo this cleanup?</DialogTitle>
              <DialogDescription>
                SelfTune will remove the managed project links and restore the original archived
                copies for {plural(rollbackCandidates.length, "skill")}. Each recovery receipt is
                applied independently, so a failure will not hide successful restores.
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <ul className="space-y-2">
                {rollbackCandidates.map((result) => (
                  <li key={result.skillId} className="rounded-lg border px-3 py-2 text-sm">
                    {result.skillName}
                  </li>
                ))}
              </ul>
            </div>
            <DialogFooter className="shrink-0 border-t px-5 py-4">
              <Button variant="outline" onClick={() => setPhase("results")}>
                Keep cleanup
              </Button>
              <Button variant="destructive" onClick={() => void undoAll()}>
                Undo {plural(rollbackCandidates.length, "consolidation")}
              </Button>
            </DialogFooter>
          </>
        ) : phase === "results" || phase === "rolling_back" ? (
          <>
            <DialogHeader className="shrink-0 border-b px-5 py-4 pr-14">
              <div className="flex items-center gap-2">
                <CheckCircle2Icon className="size-5 text-primary" />
                <DialogTitle>
                  {undoAttempted && rollbackCandidates.length === 0
                    ? "Cleanup undone"
                    : "Consolidation complete"}
                </DialogTitle>
              </div>
              <DialogDescription>
                {undoAttempted
                  ? "Restored copies remain protected by their durable decision history."
                  : "Each applied skill has its own durable receipt and can be undone independently from Decisions."}
              </DialogDescription>
              {refreshError ? (
                <p className="text-xs text-warning">
                  Results are saved, but the Library could not refresh: {refreshError}
                </p>
              ) : null}
            </DialogHeader>
            <div className="min-h-0 flex-1 divide-y overflow-y-auto px-5">
              {results.map((result) => (
                <div
                  key={result.skillId}
                  className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div>
                    <p className="text-sm font-medium">{result.skillName}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {result.rollbackError
                        ? `Undo failed: ${result.rollbackError}`
                        : result.status === "rolled_back"
                          ? "Managed links removed and original copies restored."
                          : result.status === "applied"
                            ? "Archived and linked with a recoverable receipt."
                            : result.error}
                    </p>
                  </div>
                  <Badge
                    variant={
                      result.rollbackError || result.status === "failed"
                        ? "destructive"
                        : result.status === "rolled_back"
                          ? "outline"
                          : "secondary"
                    }
                  >
                    {result.rollbackError
                      ? "Undo failed"
                      : result.status === "rolled_back"
                        ? "Undone"
                        : result.status === "applied"
                          ? "Applied"
                          : "Failed"}
                  </Badge>
                </div>
              ))}
              {reviewRequired.map((skill) => (
                <div
                  key={`review:${skill.id}`}
                  className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div>
                    <p className="text-sm font-medium">{skill.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {skill.name} still needs canonical review.
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => onReviewSkill(skill)}>
                    Review individually
                  </Button>
                </div>
              ))}
            </div>
            <DialogFooter className="shrink-0 border-t px-5 py-4">
              <Button
                variant="outline"
                nativeButton={false}
                disabled={phase === "rolling_back"}
                render={<a href={decisionsHref} />}
              >
                Open Decisions
              </Button>
              {rollbackAction && rollbackCandidates.length > 0 ? (
                <Button
                  variant="destructive"
                  disabled={phase === "rolling_back"}
                  onClick={() => setPhase("confirming_undo")}
                >
                  {phase === "rolling_back" ? "Undoing cleanup…" : "Undo all from this cleanup"}
                </Button>
              ) : null}
              <Button disabled={phase === "rolling_back"} onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader className="shrink-0 border-b px-5 py-4 pr-14">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle>Review duplicate installations</DialogTitle>
                <Badge variant="secondary">{plural(reviewSkills.length, "recommendation")}</Badge>
              </div>
              <DialogDescription>
                Source-confirmed recommendations are preselected. Ambiguous revisions stay held back
                for individual review.
              </DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">Apply</TableHead>
                    <TableHead>Skill and canonical source</TableHead>
                    <TableHead>Installed copies</TableHead>
                    <TableHead>Plan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reviewSkills.map((skill) => {
                    const recommendation = skill.consolidationRecommendation;
                    if (!recommendation) return null;
                    const sourceConfirmed =
                      recommendation.canonical.confidence === "source_current";
                    return (
                      <TableRow key={skill.id}>
                        <TableCell>
                          <Checkbox
                            checked={selectedSkillIds.has(skill.id)}
                            disabled={!sourceConfirmed || phase === "applying"}
                            aria-label={`Consolidate ${skill.name}`}
                            onCheckedChange={(checked) => {
                              setSelectedSkillIds((current) => {
                                const next = new Set(current);
                                if (checked) next.add(skill.id);
                                else next.delete(skill.id);
                                return next;
                              });
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex min-w-0 flex-col items-start gap-1">
                            <span className="font-medium">{skill.name}</span>
                            <Badge variant={sourceConfirmed ? "secondary" : "warning"}>
                              {sourceConfirmed ? "Source-confirmed current" : "Review required"}
                            </Badge>
                            <span className="max-w-72 break-all font-mono text-xs text-muted-foreground">
                              {recommendation.canonical.packagePath}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <p>{plural(recommendation.installedCount, "installation")}</p>
                          <p className="text-xs text-muted-foreground">
                            {sourceConfirmed
                              ? plural(
                                  recommendation.projectCount,
                                  "project copy",
                                  "project copies",
                                )
                              : "No source-current revision"}
                          </p>
                        </TableCell>
                        <TableCell>
                          {sourceConfirmed ? (
                            <div className="space-y-1 text-xs">
                              <p className="flex items-center gap-1.5">
                                <FolderArchiveIcon className="size-3.5" /> Archive{" "}
                                {recommendation.targets.length}
                              </p>
                              <p className="flex items-center gap-1.5 text-muted-foreground">
                                <LinkIcon className="size-3.5" /> Create{" "}
                                {plural(recommendation.projectCount, "project link")}
                              </p>
                            </div>
                          ) : (
                            <Button variant="ghost" size="sm" onClick={() => onReviewSkill(skill)}>
                              <AlertTriangleIcon data-icon="inline-start" /> Compare revisions
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <DialogFooter className="shrink-0 items-center border-t px-5 py-4 sm:justify-between">
              <div className="mr-auto text-left">
                <p className="text-sm font-medium">
                  {plural(selectedSkills.length, "skill")} selected
                </p>
                <p className="text-xs text-muted-foreground">
                  Archive {plural(selectedImpact.archives, "copy", "copies")} · create{" "}
                  {plural(selectedImpact.links, "project link")} · permanent deletion: none
                </p>
              </div>
              <Button variant="outline" disabled={phase === "applying"} onClick={onClose}>
                Cancel
              </Button>
              <Button
                disabled={phase === "applying" || selectedSkills.length === 0}
                onClick={() => void apply()}
              >
                {phase === "applying"
                  ? `Applying ${Math.min(results.length + 1, selectedSkills.length)} of ${selectedSkills.length}`
                  : "Apply safe consolidations"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function initiallyOpenBulkConsolidation(): boolean {
  const search = new URLSearchParams(globalThis.window?.location.search ?? "");
  return search.get("review") === "consolidate" && search.get("bulk") === "1";
}

export function SkillsLibraryBulkConsolidationSurface({
  skills,
  action,
  rollbackAction,
  decisionsHref,
  onReviewSkill,
  onApplied,
}: {
  skills: readonly LibrarySkillModel[];
  action: AvailableConsolidationAction;
  rollbackAction?: AvailableDecisionRollbackAction;
  decisionsHref: string;
  onReviewSkill(skill: LibrarySkillModel): void;
  onApplied(): void | Promise<void>;
}) {
  const [open, setOpen] = useState(initiallyOpenBulkConsolidation);

  if (skills.length === 0) return null;

  return (
    <>
      <div className="flex flex-col gap-3 border-y bg-muted/20 px-1 py-4 sm:flex-row sm:items-center">
        <div className="mr-auto">
          <p className="text-sm font-medium">
            {skills.length} duplicate-install recommendation{skills.length === 1 ? "" : "s"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Source-confirmed revisions can be safely applied together; ambiguous revisions remain
            held for review.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Review all
        </Button>
      </div>

      {open ? (
        <SkillsLibraryBulkConsolidationDialog
          skills={skills}
          action={action}
          rollbackAction={rollbackAction}
          decisionsHref={decisionsHref}
          onClose={() => setOpen(false)}
          onReviewSkill={(skill) => {
            setOpen(false);
            onReviewSkill(skill);
          }}
          onApplied={onApplied}
        />
      ) : null}
    </>
  );
}
