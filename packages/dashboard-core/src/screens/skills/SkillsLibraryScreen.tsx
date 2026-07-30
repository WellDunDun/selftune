"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowRightIcon,
  CheckIcon,
  InfoIcon,
  LinkIcon,
  MoreHorizontalIcon,
  Trash2Icon,
  Share2Icon,
} from "lucide-react";

import { type DashboardDecisionsActions, useDashboardHostAdapter } from "../../host";
import { CloudFeatureGateDialog } from "../../gates";
import type {
  DashboardDecisionModel,
  LibraryMergeModel,
  LibrarySkillModel,
  LibrarySourceUpdateModel,
  LibraryUpdateReceiptModel,
  LibraryUpdateStatus,
} from "../../models";
import { SkillDetail } from "./SkillDetail";
import { CorrectionStudyReviewPanel } from "./CorrectionStudyReviewPanel";
import { LibrarySourceControl } from "./LibrarySourceControl";
import { ShareSkillDialog } from "./ShareSkillDialog";
import { LibraryConnections } from "./LibraryConnections";
import { SkillsLibraryUnavailable, SkillsLibraryUpgrade } from "./SkillsLibraryAccessStates";
import { SkillsLibraryArchiveReviewDialog } from "./SkillsLibraryArchiveReviewDialog";
import { SkillsLibraryConsolidationReviewDialog } from "./SkillsLibraryConsolidationReviewDialog";
import { SkillsLibraryBulkConsolidationSurface } from "./SkillsLibraryBulkConsolidationDialog";
import {
  SkillsLibraryBulkArchiveDialog,
  SkillsLibraryBulkToolbar,
  useSkillsLibraryBulkActions,
} from "./SkillsLibraryBulkActions";
import {
  initialInventoryFilter,
  type InventoryFilter,
  LIFECYCLE_LABELS,
  type SourceFilter,
  SkillsLibraryFilters,
} from "./SkillsLibraryFilters";
import { initialReviewFilter, type ReviewFilter } from "./SkillsLibraryRecommendationFilter";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  PageHeader,
  PageScaffold,
  SkillsLibraryError,
  SkillsLibrarySkeleton,
  StatusBadge,
  TriggerSparkline,
} from "@selftune/ui/components";
import { timeAgo } from "@selftune/ui/lib";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@selftune/ui/primitives";

export { SkillDetail } from "./SkillDetail";

const UPDATE_LABELS: Record<LibraryUpdateStatus, string> = {
  available: "Update available",
  current: "Up to date",
  unknown: "Check unavailable",
  untracked: "Not tracked",
};

function isInteractiveTableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("a, button, input, textarea, select, [role=combobox], [role=menuitem]") !== null
  );
}

function sourceLabel(skill: LibrarySkillModel): string {
  return skill.sources.map((source) => source.label).join(", ") || "Unknown source";
}

function AvailableSkillsLibrary({
  library,
  consolidationRollback,
  decisionsHref,
}: {
  library: ReturnType<typeof useDashboardHostAdapter>["library"] & {
    access: "available";
  };
  consolidationRollback?: Extract<DashboardDecisionsActions["rollback"], { access: "available" }>;
  decisionsHref: string;
}) {
  const inventory = library.useInventory();
  const actions = library.useActions();
  const updateCategoryAction = actions.updateCategory;
  const restoreAction = actions.restore;
  const removeAction = actions.remove;
  const archiveAction = actions.archive;
  const consolidateAction = actions.consolidate;
  const [search, setSearch] = useState("");
  const [lifecycle, setLifecycle] = useState<InventoryFilter>(initialInventoryFilter);
  const [review, setReview] = useState<ReviewFilter>(initialReviewFilter);
  const [reviewSelectionApplied, setReviewSelectionApplied] = useState(false);
  const [category, setCategory] = useState("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [connection, setConnection] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceUpdate, setSourceUpdate] = useState<LibrarySourceUpdateModel | null>(null);
  const [updateReceipt, setUpdateReceipt] = useState<LibraryUpdateReceiptModel | null>(null);
  const [merge, setMerge] = useState<LibraryMergeModel | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removalDecision, setRemovalDecision] = useState<DashboardDecisionModel | null>(null);
  const [archiveReview, setArchiveReview] = useState<LibrarySkillModel | null>(null);
  const [consolidationReview, setConsolidationReview] = useState<LibrarySkillModel | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [cloudShareGateOpen, setCloudShareGateOpen] = useState(false);
  const CreateSurface = actions.create.access === "available" ? actions.create.Component : null;

  const refreshInventory = async () => {
    setRefreshing(true);
    try {
      await inventory.refresh();
    } finally {
      setRefreshing(false);
    }
  };

  const skills = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (inventory.data?.skills ?? []).filter((skill) => {
      if (review === "archive" && !skill.archiveRecommendation) return false;
      if (review === "consolidate" && !skill.consolidationRecommendation) return false;
      if (lifecycle !== "all" && skill.lifecycle !== lifecycle) return false;
      if (category !== "all" && skill.category?.id !== category) return false;
      if (source !== "all" && !skill.sources.some((item) => item.kind === source)) return false;
      if (
        connection !== "all" &&
        !skill.locations.some((location) => location.connection === connection)
      ) {
        return false;
      }
      if (!query) return true;
      return [
        skill.name,
        skill.category?.label ?? "",
        ...(skill.category?.matchedTerms ?? []),
        skill.status,
        ...skill.sources.map((item) => item.label),
        ...skill.locations.flatMap((location) => [
          location.label,
          location.path,
          location.connection ?? "",
        ]),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [category, connection, inventory.data, lifecycle, review, search, source]);

  const connections = useMemo(
    () =>
      [
        ...new Set(
          (inventory.data?.skills ?? []).flatMap((skill) =>
            skill.locations.flatMap((location) =>
              location.connection ? [location.connection] : [],
            ),
          ),
        ),
      ].toSorted(),
    [inventory.data],
  );
  const consolidationSkills = useMemo(
    () => (inventory.data?.skills ?? []).filter((skill) => skill.consolidationRecommendation),
    [inventory.data],
  );
  const archiveRecommendationCount = useMemo(
    () => (inventory.data?.skills ?? []).filter((skill) => skill.archiveRecommendation).length,
    [inventory.data],
  );

  const selected = inventory.data?.skills.find((skill) => skill.id === selectedId) ?? null;
  const hasCategories = Boolean(inventory.data?.categoryOptions.length);
  const blockedCount = (inventory.data?.skills ?? []).filter(
    (skill) => skill.primaryAction?.kind === "fix",
  ).length;
  const showUpdatedAt = skills.some((skill) => skill.statusBadge && skill.modifiedAt);
  const run = async <T,>(operation: Promise<T>, onSuccess?: (value: T) => void) => {
    setActionError(null);
    try {
      const result = await operation;
      onSuccess?.(result);
      await inventory.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };
  const openSkill = (skill: LibrarySkillModel, previewUpdate = false) => {
    setSelectedId(skill.id);
    setSourceUpdate(null);
    setUpdateReceipt(null);
    setMerge(null);
    setActionError(null);
    setRemovalDecision(null);
    if (previewUpdate && actions.previewSourceUpdate.access === "available") {
      void run(actions.previewSourceUpdate.execute(skill.id), setSourceUpdate);
    }
  };
  const bulk = useSkillsLibraryBulkActions({
    actions,
    allSkills: inventory.data?.skills ?? [],
    visibleSkills: skills,
    refresh: inventory.refresh,
    onError: setActionError,
  });

  useEffect(() => {
    if (review !== "archive" || reviewSelectionApplied || skills.length === 0) return;
    bulk.setVisibleSkillsSelected(true);
    setReviewSelectionApplied(true);
  }, [bulk, review, reviewSelectionApplied, skills.length]);

  const changeReview = (next: ReviewFilter) => {
    bulk.clear();
    setReview(next);
    setReviewSelectionApplied(next !== "archive");
  };

  if (inventory.isLoading) return <SkillsLibrarySkeleton />;
  if (inventory.error) {
    return (
      <SkillsLibraryError message={inventory.error} onRetry={() => void inventory.refresh()} />
    );
  }

  return (
    <PageScaffold data-parity-root="skills-library" className="max-w-full overflow-x-hidden">
      <PageHeader
        title="Skills Library"
        description="Monitor and manage skill definitions across every connected source."
        actions={actions.primary.map((action) => (
          <Button key={action.href} nativeButton={false} render={<a href={action.href} />}>
            {action.label}
          </Button>
        ))}
      />

      <section className="flex min-w-0 flex-col gap-4">
        <SkillsLibraryFilters
          search={search}
          lifecycle={lifecycle}
          category={category}
          categoryOptions={inventory.data?.categoryOptions ?? []}
          connection={connection}
          connections={connections}
          source={source}
          review={review}
          archiveRecommendationCount={archiveRecommendationCount}
          consolidationRecommendationCount={consolidationSkills.length}
          refreshing={refreshing}
          onSearchChange={setSearch}
          onLifecycleChange={setLifecycle}
          onCategoryChange={setCategory}
          onConnectionChange={setConnection}
          onSourceChange={setSource}
          onReviewChange={changeReview}
          onRefresh={() => void refreshInventory()}
        />

        {actionError && !selected ? (
          <p className="text-sm text-destructive">{actionError}</p>
        ) : null}

        {review === "consolidate" && consolidateAction?.access === "available" ? (
          <SkillsLibraryBulkConsolidationSurface
            skills={consolidationSkills}
            action={consolidateAction}
            rollbackAction={consolidationRollback}
            decisionsHref={decisionsHref}
            onReviewSkill={setConsolidationReview}
            onApplied={() => inventory.refresh()}
          />
        ) : null}

        {bulk.notice ? <p className="text-sm text-muted-foreground">{bulk.notice}</p> : null}
        <SkillsLibraryBulkToolbar bulk={bulk} actions={actions} />

        <div className="max-w-full rounded-lg border">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={bulk.allVisibleSelected}
                    indeterminate={bulk.someVisibleSelected && !bulk.allVisibleSelected}
                    onCheckedChange={(checked) => bulk.setVisibleSkillsSelected(Boolean(checked))}
                    aria-label="Select all visible skills"
                  />
                </TableHead>
                <TableHead>Skill</TableHead>
                {hasCategories ? (
                  <TableHead className="hidden xl:table-cell">Category</TableHead>
                ) : null}
                <TableHead>State</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Connections</TableHead>
                <TableHead className="hidden md:table-cell">Triggers</TableHead>
                <TableHead className="hidden lg:table-cell">Last used</TableHead>
                {showUpdatedAt ? (
                  <TableHead className="hidden lg:table-cell">Updated</TableHead>
                ) : null}
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {skills.map((skill) => (
                <TableRow
                  key={skill.id}
                  data-state={selectedId === skill.id ? "selected" : undefined}
                  tabIndex={0}
                  aria-label={`View ${skill.name} details`}
                  className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  onClick={(event) => {
                    if (!isInteractiveTableTarget(event.target)) openSkill(skill);
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    openSkill(skill);
                  }}
                >
                  <TableCell>
                    <Checkbox
                      checked={bulk.selectedSkillIds.has(skill.id)}
                      onClick={(event) => event.stopPropagation()}
                      onCheckedChange={(checked) =>
                        bulk.setSkillSelected(skill.id, Boolean(checked))
                      }
                      aria-label={`Select ${skill.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-0 flex-col items-start">
                      <span className="truncate font-medium">{skill.name}</span>
                      <span className="max-w-52 truncate font-mono text-xs text-muted-foreground">
                        {skill.locations[0]?.path ?? skill.status}
                      </span>
                    </div>
                  </TableCell>
                  {hasCategories ? (
                    <TableCell className="hidden xl:table-cell">
                      {skill.category && updateCategoryAction.access === "available" ? (
                        <Select
                          value={skill.category.id}
                          onValueChange={(value) => {
                            if (!value) return;
                            void run(
                              updateCategoryAction.execute({
                                skillId: skill.id,
                                skillName: skill.name,
                                categoryId: value === "__automatic__" ? null : value,
                                inferredCategoryId: skill.category?.inferredId ?? value,
                              }),
                            );
                          }}
                        >
                          <SelectTrigger
                            aria-label={`Classify ${skill.name}`}
                            className="max-w-44 border-transparent hover:bg-accent/60 dark:bg-transparent dark:hover:bg-accent/40"
                            title={`${skill.category.reason} ${Math.round(skill.category.confidence * 100)}% confidence`}
                          >
                            <SelectValue>
                              <span className="flex min-w-0 items-center gap-1.5">
                                {skill.category.source === "human" ? <CheckIcon /> : null}
                                <span className="truncate">{skill.category.label}</span>
                              </span>
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {skill.category.source === "human" ? (
                                <SelectItem value="__automatic__">
                                  Automatic classification
                                </SelectItem>
                              ) : null}
                              {(inventory.data?.categoryOptions ?? []).map((option) => (
                                <SelectItem key={option.id} value={option.id}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {skill.category?.label ?? "Unclassified"}
                        </span>
                      )}
                    </TableCell>
                  ) : null}
                  <TableCell>
                    {skill.statusBadge ? (
                      <StatusBadge tone={skill.statusBadge.tone} appearance="soft" showDot={false}>
                        {skill.statusBadge.label}
                      </StatusBadge>
                    ) : (
                      <Badge variant="outline">{LIFECYCLE_LABELS[skill.lifecycle]}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-56" title={sourceLabel(skill)}>
                    <div className="flex flex-wrap gap-1">
                      {skill.sources.slice(0, 2).map((item) => (
                        <LibrarySourceControl
                          key={`${item.kind}:${item.label}`}
                          source={item}
                          actions={actions}
                          onError={setActionError}
                        />
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <LibraryConnections skill={skill} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <TriggerSparkline
                      data={skill.triggerTrend ?? []}
                      label={skill.name}
                      lifetimeTotal={skill.lifetimeTriggerCount}
                    />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {skill.lastUsedAt ? timeAgo(skill.lastUsedAt) : "Never"}
                  </TableCell>
                  {showUpdatedAt ? (
                    <TableCell className="hidden lg:table-cell">
                      {skill.modifiedAt ? timeAgo(skill.modifiedAt) : "Unknown"}
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {skill.consolidationRecommendation &&
                      consolidateAction?.access === "available" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setConsolidationReview(skill)}
                        >
                          Consolidate
                        </Button>
                      ) : null}
                      {skill.primaryAction ? (
                        <Button
                          nativeButton={false}
                          render={<a href={skill.primaryAction.href} />}
                          variant={
                            skill.primaryAction.kind === "review" ||
                            skill.primaryAction.kind === "fix"
                              ? "default"
                              : "outline"
                          }
                          size="sm"
                        >
                          {skill.primaryAction.label}
                          <ArrowRightIcon data-icon="inline-end" />
                        </Button>
                      ) : skill.updateStatus === "available" &&
                        actions.previewSourceUpdate.access === "available" ? (
                        <Button
                          size="sm"
                          aria-label={`Update ${skill.name}`}
                          onClick={() => openSkill(skill, true)}
                        >
                          Update
                        </Button>
                      ) : null}
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`More actions for ${skill.name}`}
                            />
                          }
                        >
                          <MoreHorizontalIcon />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            <DropdownMenuItem onClick={() => openSkill(skill)}>
                              <InfoIcon /> View details
                            </DropdownMenuItem>
                            {skill.detailHref ? (
                              <DropdownMenuItem render={<a href={skill.detailHref} />}>
                                Open report
                              </DropdownMenuItem>
                            ) : null}
                            {skill.restoreId && restoreAction.access === "available" ? (
                              <DropdownMenuItem
                                onClick={() =>
                                  void run(restoreAction.execute(skill.restoreId ?? ""))
                                }
                              >
                                <ArchiveRestoreIcon /> Restore skill
                              </DropdownMenuItem>
                            ) : null}
                            {skill.archiveRecommendation && archiveAction.access === "available" ? (
                              <DropdownMenuItem onClick={() => setArchiveReview(skill)}>
                                <ArchiveIcon /> Review archive
                              </DropdownMenuItem>
                            ) : null}
                            {skill.consolidationRecommendation &&
                            consolidateAction?.access === "available" ? (
                              <DropdownMenuItem onClick={() => setConsolidationReview(skill)}>
                                <LinkIcon /> Review consolidation
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuGroup>
                          {removeAction.access === "available" &&
                          skill.locations.some((location) => location.removable) ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuGroup>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => {
                                    openSkill(skill);
                                    void run(removeAction.execute(skill.id), setRemovalDecision);
                                  }}
                                >
                                  <Trash2Icon /> Review removal
                                </DropdownMenuItem>
                              </DropdownMenuGroup>
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {blockedCount > 0 ? (
          <p className="text-sm text-muted-foreground">
            {blockedCount} cloud skill{blockedCount === 1 ? " is" : "s are"} blocked for hosted
            improvement. Use the Fix validation action in its row.
          </p>
        ) : null}

        {inventory.data?.summary ? (
          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            {[
              ["Skills", inventory.data.skills.length],
              ["Ready", inventory.data.summary.ready],
              ["With snapshots", inventory.data.summary.snapshots],
              ["Pending proposals", inventory.data.summary.pendingActions],
            ].map(([label, value]) => (
              <div key={label} className="flex items-baseline gap-2">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {skills.length === 0 ? (
          <Card>
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {inventory.data?.skills.length
                    ? "No skills match these filters"
                    : "No skills yet"}
                </EmptyTitle>
                <EmptyDescription>
                  {inventory.data?.skills.length
                    ? "Clear a filter or search for a different source or location."
                    : "Add or connect a skill to populate this Library."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </Card>
        ) : null}
      </section>

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedId(null);
            setRemovalDecision(null);
          }
        }}
      >
        {selected ? (
          <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
            <DialogHeader className="shrink-0 border-b px-5 py-4 pr-14">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <DialogTitle>{selected.name}</DialogTitle>
                  <Badge variant="outline">{LIFECYCLE_LABELS[selected.lifecycle]}</Badge>
                  <Badge variant={selected.updateStatus === "available" ? "warning" : "secondary"}>
                    {UPDATE_LABELS[selected.updateStatus]}
                  </Badge>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  {actions.share?.access === "available" ? (
                    <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
                      <Share2Icon data-icon="inline-start" /> Share
                    </Button>
                  ) : actions.share?.access === "upgrade" ? (
                    <Button variant="outline" size="sm" onClick={() => setCloudShareGateOpen(true)}>
                      <Share2Icon data-icon="inline-start" /> Share with Cloud
                    </Button>
                  ) : null}
                  {selected.sources.map((item) => (
                    <LibrarySourceControl
                      key={`${item.kind}:${item.label}`}
                      source={item}
                      actions={actions}
                      onError={setActionError}
                    />
                  ))}
                </div>
              </div>
              <DialogDescription>
                {selected.locations.length} location
                {selected.locations.length === 1 ? "" : "s"} · {selected.status}
                {selected.revisionHashes.length > 0
                  ? ` · ${selected.revisionHashes.map((hash) => hash.slice(0, 12)).join(", ")}`
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <SkillDetail
              skill={selected}
              sourceUpdate={sourceUpdate}
              updateReceipt={updateReceipt}
              merge={merge}
              actionError={actionError}
              removalDecision={removalDecision}
              actions={actions}
              onPreviewUpdate={() => {
                const action = actions.previewSourceUpdate;
                if (action.access === "available") {
                  void run(action.execute(selected.id), setSourceUpdate);
                }
              }}
              onApplyUpdate={() => {
                const action = actions.applySourceUpdate;
                if (action.access === "available") {
                  void run(action.execute(selected.id), (receipt) => {
                    setUpdateReceipt(receipt);
                    setSourceUpdate(null);
                  });
                }
              }}
              onPrepareMerge={(input) => {
                const action = actions.prepareMerge;
                if (action.access === "available") void run(action.execute(input), setMerge);
              }}
              onApplyMerge={() => {
                const action = actions.applyMerge;
                if (action.access === "available") {
                  void run(action.execute(merge?.mergeId ?? ""), (receipt) => {
                    setUpdateReceipt(receipt);
                    setMerge(null);
                  });
                }
              }}
              onRemove={() => {
                const action = actions.remove;
                if (action.access === "available") {
                  void run(action.execute(selected.id), setRemovalDecision);
                }
              }}
              onRestore={() => {
                const action = actions.restore;
                if (action.access === "available" && selected.restoreId) {
                  void run(action.execute(selected.restoreId), () => setSelectedId(null));
                }
              }}
              onDecideRemoval={(decisionAction) => {
                const action = actions.decideRemoval;
                if (action.access === "available" && removalDecision) {
                  void run(
                    action.execute({
                      decisionId: removalDecision.id,
                      action: decisionAction,
                    }),
                    (decision) => {
                      setRemovalDecision(decision);
                      if (decision.status === "approved") setSelectedId(null);
                    },
                  );
                }
              }}
            />
          </DialogContent>
        ) : null}
      </Dialog>

      {selected && actions.share ? (
        <ShareSkillDialog
          skill={selected}
          action={actions.share}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      ) : null}

      {selected && actions.share?.access === "upgrade" ? (
        <CloudFeatureGateDialog
          kind="skill-share"
          open={cloudShareGateOpen}
          onOpenChange={setCloudShareGateOpen}
          upgradeHref={actions.share.href}
          context={{
            name: selected.name,
            detail: `${selected.locations.length} installed location${selected.locations.length === 1 ? "" : "s"}`,
          }}
        />
      ) : null}

      <SkillsLibraryArchiveReviewDialog
        skill={archiveReview}
        pending={archiveAction.access === "available" && archiveAction.isPending === true}
        onClose={() => setArchiveReview(null)}
        onConfirm={(input) => {
          if (archiveAction.access !== "available") return;
          void run(archiveAction.execute(input), () => setArchiveReview(null));
        }}
      />

      <SkillsLibraryConsolidationReviewDialog
        skill={consolidationReview}
        pending={consolidateAction?.access === "available" && consolidateAction.isPending === true}
        onClose={() => setConsolidationReview(null)}
        onConfirm={(skillId) => {
          if (consolidateAction?.access !== "available") return;
          void run(consolidateAction.execute(skillId), () => setConsolidationReview(null));
        }}
      />

      <SkillsLibraryBulkArchiveDialog bulk={bulk} />

      {CreateSurface ? <CreateSurface onChanged={() => inventory.refresh()} /> : null}

      {inventory.data?.note ? (
        <section className="flex flex-col gap-1 text-sm text-muted-foreground">
          <h2 className="font-medium text-foreground">{inventory.data.note.title}</h2>
          <p>
            {inventory.data.note.description}{" "}
            {inventory.data.note.link ? (
              <a
                className="text-foreground underline-offset-4 hover:underline"
                href={inventory.data.note.link.href}
              >
                {inventory.data.note.link.label}
              </a>
            ) : null}
          </p>
        </section>
      ) : null}
    </PageScaffold>
  );
}

function AvailableSkillsLibraryWithDecisions({
  library,
  decisions,
  decisionsHref,
}: {
  library: ReturnType<typeof useDashboardHostAdapter>["library"] & {
    access: "available";
  };
  decisions: ReturnType<typeof useDashboardHostAdapter>["decisions"] & {
    access: "available";
  };
  decisionsHref: string;
}) {
  const decisionActions = decisions.useActions();
  return (
    <AvailableSkillsLibrary
      library={library}
      consolidationRollback={
        decisionActions.rollback.access === "available" ? decisionActions.rollback : undefined
      }
      decisionsHref={decisionsHref}
    />
  );
}

export function SkillsLibraryScreen() {
  const adapter = useDashboardHostAdapter();
  if (adapter.library.access === "unavailable") {
    return <SkillsLibraryUnavailable reason={adapter.library.reason} />;
  }
  if (adapter.library.access === "upgrade") {
    return <SkillsLibraryUpgrade href={adapter.library.href} />;
  }
  const decisionsHref = adapter.host === "cloud" ? "/analytics" : "/insights";
  const reviewPanel = <CorrectionStudyReviewPanel contribution={adapter.correctionStudies} />;
  if (adapter.decisions.access === "available") {
    return (
      <div className="space-y-4">
        {reviewPanel}
        <AvailableSkillsLibraryWithDecisions
          library={adapter.library}
          decisions={adapter.decisions}
          decisionsHref={decisionsHref}
        />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {reviewPanel}
      <AvailableSkillsLibrary library={adapter.library} decisionsHref={decisionsHref} />
    </div>
  );
}
