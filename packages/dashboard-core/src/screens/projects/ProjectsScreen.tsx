"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDownIcon,
  FileDownIcon,
  EyeIcon,
  FolderIcon,
  FolderKanbanIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  Share2Icon,
  Trash2Icon,
} from "lucide-react";

import { useDashboardHostAdapter, type DashboardProjectsContribution } from "../../host";
import { CloudFeatureGateDialog } from "../../gates";
import type {
  ProjectCatalogSkillSetExpansionModel,
  ProjectSkillSetInput,
  ProjectSkillSetInputSkill,
  ProjectSkillSetSuggestionModel,
} from "../../models";
import { SkillSetEditor } from "./SkillSetEditor";
import { SkillSetIntelligencePanels } from "./SkillSetIntelligencePanels";
import { ProjectSetupDialog } from "./ProjectSetupDialog";
import { ShareSkillSetDialog } from "./ShareSkillSetDialog";
import {
  SkillSetPageHeader,
  SkillSetWorkspaceNavigation,
  type SkillSetWorkspaceView,
} from "./SkillSetWorkspaceNavigation";
import { CONNECTION_LABELS, type SkillSetEditorMode } from "./skill-set-constants";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  HarnessLabel,
  PageHeader,
  PageScaffold,
} from "@selftune/ui/components";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
} from "@selftune/ui/primitives";

export { SkillSetEditor, SkillSetSkillPicker } from "./SkillSetEditor";
export { PlanReview } from "./SkillSetInstallationPreview";

const useNoShareRecipients = () => [] as const;

export interface ProjectActionFailure {
  title: string;
  message: string;
  suggestion: string | null;
  retryable: boolean;
}

function failureCode(cause: unknown): string | null {
  return cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    typeof cause.code === "string"
    ? cause.code
    : null;
}

function failureSuggestion(cause: unknown): string | null {
  return cause !== null &&
    typeof cause === "object" &&
    "suggestion" in cause &&
    typeof cause.suggestion === "string"
    ? cause.suggestion
    : null;
}

function failureRetryable(cause: unknown): boolean {
  return (
    cause !== null && typeof cause === "object" && "retryable" in cause && cause.retryable === true
  );
}

export function projectActionFailure(cause: unknown): ProjectActionFailure {
  const code = failureCode(cause);
  const message =
    cause instanceof Error
      ? cause.message
      : cause !== null &&
          typeof cause === "object" &&
          "message" in cause &&
          typeof cause.message === "string"
        ? cause.message
        : String(cause);
  const title =
    code === "AUTH_MISSING"
      ? "Sync & Backup authentication required"
      : code === "API_ERROR" && failureRetryable(cause)
        ? "Sync & Backup is offline"
        : code === "FILE_NOT_FOUND"
          ? "Pinned skill unavailable"
          : code === "OPERATION_FAILED" && /integrity|verification/i.test(message)
            ? "Skill verification failed"
            : code === "GUARD_BLOCKED"
              ? "Skill Set apply blocked"
              : "Skill Set action failed";
  return {
    title,
    message,
    suggestion: failureSuggestion(cause),
    retryable: failureRetryable(cause),
  };
}

export function ProjectActionNotice({ failure }: { failure: ProjectActionFailure }) {
  return (
    <Card role="alert">
      <CardHeader>
        <CardTitle>{failure.title}</CardTitle>
        <CardDescription>{failure.message}</CardDescription>
      </CardHeader>
      {failure.suggestion || failure.retryable ? (
        <CardContent className="flex flex-col gap-1 text-sm text-muted-foreground">
          {failure.suggestion ? <p>{failure.suggestion}</p> : null}
          {failure.retryable ? <p>You can retry without changing the project.</p> : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

function actionUpgrade(action: { access: string; href?: string }): string | null {
  return action.access === "upgrade" ? (action.href ?? null) : null;
}

function normalizedStrings(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))].toSorted();
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return JSON.stringify(normalizedStrings(left)) === JSON.stringify(normalizedStrings(right));
}

export function suggestionEditedFields(
  suggestion: ProjectSkillSetSuggestionModel,
  value: ProjectSkillSetInput,
): string[] {
  const fields: string[] = [];
  if (value.name.trim() !== suggestion.name.trim()) fields.push("name");
  if (value.description.trim() !== suggestion.description.trim()) fields.push("description");
  if (!sameStrings(value.connections, suggestion.connections)) fields.push("connections");
  if (
    !sameStrings(
      value.skills.map((skill) => skill.name),
      suggestion.skills.map((skill) => skill.name),
    )
  ) {
    fields.push("skills");
  }
  return fields;
}

function ProjectsSkeleton() {
  return (
    <PageScaffold aria-label="Loading Skill Sets" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    </PageScaffold>
  );
}

function ProjectsUnavailable({ reason }: { reason: string }) {
  return (
    <PageScaffold data-parity-root="projects">
      <PageHeader
        title="Skill Sets"
        description="Create reusable Skill Sets and apply them to project folders."
      />
      <Card>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Skill Sets unavailable</EmptyTitle>
            <EmptyDescription>{reason}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Card>
    </PageScaffold>
  );
}

function ProjectsError({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <PageScaffold data-parity-root="projects">
      <PageHeader
        title="Skill Sets"
        description="Create reusable Skill Sets and apply them to project folders."
      />
      <Card>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Skill Sets could not be loaded</EmptyTitle>
            <EmptyDescription>{message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={onRetry}>
              <RefreshCwIcon data-icon="inline-start" /> Retry
            </Button>
          </EmptyContent>
        </Empty>
      </Card>
    </PageScaffold>
  );
}

function ProjectsUpgrade({ href }: { href: string }) {
  return (
    <PageScaffold data-parity-root="projects">
      <PageHeader
        title="Skill Sets"
        description="Create reusable Skill Sets and apply them to project folders."
      />
      <Card>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Upgrade to use Skill Sets</EmptyTitle>
            <EmptyDescription>
              This host exposes Skill Sets as an upgrade-only capability.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button nativeButton={false} render={<a href={href} />}>
              View upgrade options
            </Button>
          </EmptyContent>
        </Empty>
      </Card>
    </PageScaffold>
  );
}

function AvailableProjects({
  projects,
}: {
  projects: DashboardProjectsContribution & { access: "available" };
}) {
  const inventory = projects.useInventory();
  const intelligence = projects.useIntelligence();
  const actions = projects.useActions();
  const useShareRecipients = actions.useShareRecipients ?? useNoShareRecipients;
  const shareRecipients = useShareRecipients();
  const [workspaceView, setWorkspaceView] = useState<SkillSetWorkspaceView>("sets");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRecommendationKey, setSelectedRecommendationKey] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const [editorMode, setEditorMode] = useState<SkillSetEditorMode | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [cloudShareGateOpen, setCloudShareGateOpen] = useState(false);
  const [sourceSuggestion, setSourceSuggestion] = useState<ProjectSkillSetSuggestionModel | null>(
    null,
  );
  const [sourceExpansion, setSourceExpansion] =
    useState<ProjectCatalogSkillSetExpansionModel | null>(null);
  const [error, setError] = useState<ProjectActionFailure | null>(null);
  const [projectSetupOpen, setProjectSetupOpen] = useState(false);
  const [projectSetupIds, setProjectSetupIds] = useState<string[]>([]);

  const skillSets = useMemo(() => inventory.data?.skillSets ?? [], [inventory.data]);
  const captureCandidates = inventory.data?.captureCandidates ?? [];
  const selected = selectedRecommendationKey
    ? null
    : (skillSets.find((skillSet) => skillSet.id === selectedId) ?? skillSets[0] ?? null);
  const activeReceipts = (inventory.data?.receipts ?? []).filter(
    (receipt) => receipt.status === "applied" || receipt.status === "applying",
  );
  const selectedReceipts = activeReceipts.filter((receipt) => receipt.skillSetId === selected?.id);
  const connectedHarnessesById = new Map(
    (inventory.data?.connectedHarnesses ?? []).map((harness) => [harness.id, harness]),
  );
  const intelligenceReport = intelligence.access === "available" ? intelligence.data : null;
  const suggestionCount =
    (intelligenceReport?.catalogExpansions.length ?? 0) +
    (intelligenceReport?.suggestions.length ?? 0);
  useEffect(() => {
    if (!selectedId && !selectedRecommendationKey && skillSets[0]) {
      setSelectedId(skillSets[0].id);
    }
  }, [selectedId, selectedRecommendationKey, skillSets]);

  const run = async <T,>(operation: Promise<T>, success: (value: T) => void | Promise<void>) => {
    setError(null);
    try {
      const result = await operation;
      await success(result);
      await inventory.refresh();
    } catch (cause) {
      setError(projectActionFailure(cause));
    }
  };

  if (inventory.isLoading) return <ProjectsSkeleton />;
  if (inventory.error) {
    return <ProjectsError message={inventory.error} onRetry={() => void inventory.refresh()} />;
  }

  const createUpgrade = actionUpgrade(actions.create);
  const editorPending =
    editorMode === "create"
      ? actions.create.access === "available" && Boolean(actions.create.isPending)
      : editorMode === "edit"
        ? actions.update.access === "available" && Boolean(actions.update.isPending)
        : editorMode === "derive"
          ? actions.derive.access === "available" && Boolean(actions.derive.isPending)
          : false;
  const supportsInstallation =
    actions.plan.access === "available" || actions.apply.access === "available";
  const canProvision =
    actions.provision?.preview.access === "available" &&
    actions.provision.execute.access === "available";
  const supportsIntelligence = intelligence.access === "available";
  const canCapture = actions.derive.access === "available";

  function openCreateEditor() {
    setSourceSuggestion(null);
    setSourceExpansion(null);
    setEditorMode(actions.create.access === "available" ? "create" : "derive");
  }

  return (
    <PageScaffold data-parity-root="projects" className="max-w-full overflow-x-hidden">
      <SkillSetPageHeader
        skillSetCount={skillSets.length}
        activeInstallCount={activeReceipts.length}
        supportsInstallation={supportsInstallation}
        canCreate={
          skillSets.length > 0 &&
          (actions.create.access === "available" || actions.derive.access === "available")
        }
        upgradeHref={createUpgrade}
        onCreate={openCreateEditor}
        canSetUpProject={canProvision}
        onSetUpProject={() => {
          setProjectSetupIds(selected ? [selected.id] : skillSets.map((skillSet) => skillSet.id));
          setProjectSetupOpen(true);
        }}
      />

      {error ? <ProjectActionNotice failure={error} /> : null}

      {supportsIntelligence ? (
        <SkillSetWorkspaceNavigation
          value={workspaceView}
          skillSetCount={skillSets.length}
          outcomeCount={intelligenceReport?.outcomes.length ?? 0}
          traceSignalCount={intelligenceReport?.traceSignals.length ?? 0}
          onValueChange={setWorkspaceView}
        />
      ) : null}

      {workspaceView === "outcomes" ? (
        <SkillSetIntelligencePanels
          intelligence={intelligence}
          reviewAction={actions.reviewSuggestion}
          view="outcomes"
          onReview={() => undefined}
          onReviewExpansion={() => undefined}
        />
      ) : null}

      {workspaceView === "trace-signals" ? (
        <SkillSetIntelligencePanels
          intelligence={intelligence}
          reviewAction={actions.reviewSuggestion}
          prepareCandidate={actions.prepareTraceCandidate}
          loadTargets={actions.traceCandidateTargets}
          submitTarget={actions.submitTraceCandidateTarget}
          view="trace-signals"
          onReview={() => undefined}
          onReviewExpansion={() => undefined}
        />
      ) : null}

      {workspaceView === "sets" && skillSets.length === 0 ? (
        <Card className="bg-transparent">
          <Empty className="min-h-96">
            <EmptyHeader>
              <EmptyTitle>No Skill Sets yet</EmptyTitle>
              <EmptyDescription>
                {canCapture
                  ? "Create a reusable collection of skills and connections, or capture one from an existing project."
                  : "Create a reusable collection of skills and connections for your workspace."}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <div className="flex flex-wrap justify-center gap-2">
                {actions.create.access === "available" || actions.derive.access === "available" ? (
                  <Button onClick={openCreateEditor}>
                    <PlusIcon data-icon="inline-start" />
                    Create Skill Set
                  </Button>
                ) : null}
              </div>
            </EmptyContent>
          </Empty>
        </Card>
      ) : workspaceView === "sets" ? (
        <div className="grid min-w-0 gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
          <aside className="min-w-0" aria-label="Skill Set navigation">
            <div className="flex flex-col gap-1">
              <nav className="flex flex-col gap-1" aria-label="Saved Skill Sets">
                {skillSets.map((skillSet) => (
                  <Button
                    key={skillSet.id}
                    variant={selected?.id === skillSet.id ? "secondary" : "ghost"}
                    className="h-auto min-w-0 justify-start py-3 text-left"
                    onClick={() => {
                      setSelectedId(skillSet.id);
                      setSelectedRecommendationKey(null);
                    }}
                  >
                    <FolderKanbanIcon data-icon="inline-start" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{skillSet.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        v{skillSet.revision} · {skillSet.skills.length} skills ·{" "}
                        {skillSet.ownerScope === "workspace" ? "Workspace" : "Personal"}
                      </span>
                    </span>
                  </Button>
                ))}
              </nav>
              {supportsIntelligence && suggestionCount > 0 ? (
                <Collapsible open={suggestionsOpen} onOpenChange={setSuggestionsOpen}>
                  <CollapsibleTrigger className="mt-3 flex w-full items-center justify-between gap-2 border-t border-border/70 px-3 pt-4 text-left text-sm font-medium">
                    <span className="flex items-center gap-2">
                      <SparklesIcon className="size-4 text-muted-foreground" /> Suggested
                      <Badge
                        variant="outline"
                        className="h-5 min-w-5 justify-center px-1.5 text-[10px] tabular-nums"
                      >
                        {suggestionCount}
                      </Badge>
                    </span>
                    <ChevronDownIcon
                      className="size-4 text-muted-foreground transition-transform data-[open=true]:rotate-180"
                      data-open={suggestionsOpen}
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-2 flex flex-col gap-1">
                    {intelligenceReport?.catalogExpansions.map((expansion) => (
                      <Button
                        key={expansion.id}
                        variant={
                          selectedRecommendationKey === `catalog:${expansion.id}`
                            ? "secondary"
                            : "ghost"
                        }
                        className="h-auto min-w-0 justify-start py-2.5 text-left"
                        onClick={() => {
                          setSelectedRecommendationKey(`catalog:${expansion.id}`);
                          setSelectedId(null);
                        }}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{expansion.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {expansion.skills.length} skills · Context-backed
                          </span>
                        </span>
                      </Button>
                    ))}
                    {intelligenceReport?.suggestions.map((suggestion) => (
                      <Button
                        key={`${suggestion.id}:${suggestion.evidenceFingerprint}`}
                        variant={
                          selectedRecommendationKey === `observed:${suggestion.id}`
                            ? "secondary"
                            : "ghost"
                        }
                        className="h-auto min-w-0 justify-start py-2.5 text-left"
                        onClick={() => {
                          setSelectedRecommendationKey(`observed:${suggestion.id}`);
                          setSelectedId(null);
                        }}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{suggestion.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {suggestion.skills.length} skills · {suggestion.evidenceState}
                          </span>
                        </span>
                      </Button>
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </div>
          </aside>

          {selectedRecommendationKey ? (
            <SkillSetIntelligencePanels
              intelligence={intelligence}
              reviewAction={actions.reviewSuggestion}
              view="suggestions"
              showList={false}
              selectedRecommendationKey={selectedRecommendationKey}
              onReview={(suggestion) => {
                setSourceSuggestion(suggestion);
                setSourceExpansion(null);
                setEditorMode("create");
              }}
              onReviewExpansion={(expansion) => {
                setSourceSuggestion(null);
                setSourceExpansion(expansion);
                setEditorMode("create");
              }}
            />
          ) : selected ? (
            <article
              className="min-w-0 rounded-xl border border-border/15 bg-muted p-5 lg:p-6"
              aria-labelledby="selected-skill-set-name"
            >
              <div className="flex flex-col gap-8">
                <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h2
                      id="selected-skill-set-name"
                      className="font-headline text-2xl font-semibold tracking-tight text-foreground"
                    >
                      {selected.name}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {selected.description || "No description"}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {actions.export.access === "available" &&
                    actions.export.requiresProjectRoot !== true ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void run(
                            actions.export.access === "available"
                              ? actions.export.execute({
                                  skillSetId: selected.id,
                                  projectRoot: "",
                                })
                              : Promise.reject(),
                            (result) => {
                              toast.success(`Saved ${result.outputPath}`);
                            },
                          )
                        }
                      >
                        <FileDownIcon data-icon="inline-start" />
                        {actions.export.label ?? "Export Skill Set"}
                      </Button>
                    ) : null}
                    {actions.remove.access === "available" ? (
                      <Button
                        variant="destructive"
                        size="icon-sm"
                        aria-label="Delete Skill Set"
                        onClick={() => setDeleteOpen(true)}
                      >
                        <Trash2Icon />
                      </Button>
                    ) : null}
                  </div>
                </header>
                <div className="flex flex-col gap-8">
                  {selected.workspacePolicy?.action ? (
                    <div className="flex flex-wrap gap-2">
                      {selected.workspacePolicy.action === "require_approval" ? (
                        <Badge variant="outline">Approval required</Badge>
                      ) : selected.workspacePolicy.action === "block" ? (
                        <Badge variant="destructive">Blocked by workspace</Badge>
                      ) : selected.workspacePolicy.action === "require" ? (
                        <Badge variant="secondary">Required by workspace</Badge>
                      ) : null}
                    </div>
                  ) : null}
                  <section className="flex flex-col gap-3" aria-labelledby="skill-set-skills-title">
                    <div className="flex items-center justify-between gap-3">
                      <h3 id="skill-set-skills-title" className="text-sm font-medium">
                        Skills
                      </h3>
                      <span className="text-xs text-muted-foreground">
                        {selected.skills.length} included
                      </span>
                    </div>
                    <ul className="flex flex-col gap-1">
                      {selected.skills.map((skill) => (
                        <li key={`${skill.name}:${skill.contentHash}`} className="min-w-0 py-1">
                          <p className="truncate text-sm font-medium">{skill.name}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section
                    className="flex flex-col gap-3"
                    aria-labelledby="skill-set-harnesses-title"
                  >
                    <h3 id="skill-set-harnesses-title" className="text-sm font-medium">
                      Harnesses
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {selected.connections.map((connection) => (
                        <HarnessLabel
                          key={connection}
                          {...(connectedHarnessesById.get(connection) ?? {
                            name: CONNECTION_LABELS[connection],
                            icon: null,
                          })}
                        />
                      ))}
                    </div>
                  </section>
                  <section
                    className="flex flex-col gap-3"
                    aria-labelledby="installed-projects-title"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h3 id="installed-projects-title" className="text-sm font-medium">
                        Installed projects
                      </h3>
                      <span className="text-xs text-muted-foreground">
                        {selectedReceipts.length} active
                      </span>
                    </div>
                    {selectedReceipts.length > 0 ? (
                      <ul className="flex flex-col gap-2">
                        {selectedReceipts.map((receipt) => (
                          <li
                            key={receipt.id}
                            className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <FolderIcon
                                className="size-4 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                              <span className="truncate text-sm" title={receipt.projectRoot}>
                                {receipt.projectRoot}
                              </span>
                            </div>
                            {actions.rollback.access === "available" ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  void run(
                                    actions.rollback.access === "available"
                                      ? actions.rollback.execute(receipt.id)
                                      : Promise.reject(),
                                    (rolledBack) => {
                                      toast.success(`Rolled back ${rolledBack.skillSetName}`);
                                    },
                                  )
                                }
                              >
                                Rollback
                              </Button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        This Skill Set has not been installed in a project yet.
                      </p>
                    )}
                  </section>
                </div>
                <footer className="flex flex-wrap items-center justify-end gap-2">
                  {actions.shareGatePreview ? (
                    <Button
                      variant="ghost"
                      nativeButton={false}
                      render={<a href={actions.shareGatePreview.href} />}
                    >
                      <EyeIcon data-icon="inline-start" />
                      {actions.shareGatePreview.label}
                    </Button>
                  ) : null}
                  {actions.share?.access === "available" ? (
                    <Button variant="outline" onClick={() => setShareOpen(true)}>
                      <Share2Icon data-icon="inline-start" />
                      Share
                    </Button>
                  ) : actions.share?.access === "upgrade" ? (
                    <Button variant="outline" onClick={() => setCloudShareGateOpen(true)}>
                      <Share2Icon data-icon="inline-start" />
                      Share with Cloud
                    </Button>
                  ) : null}
                  {actions.update.access === "available" ? (
                    <Button variant="outline" onClick={() => setEditorMode("edit")}>
                      <PencilIcon data-icon="inline-start" />
                      Edit Skill Set
                    </Button>
                  ) : null}
                  {canProvision ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setProjectSetupIds([selected.id]);
                        setProjectSetupOpen(true);
                      }}
                    >
                      Set up in a project
                    </Button>
                  ) : null}
                </footer>
              </div>
            </article>
          ) : null}
        </div>
      ) : null}

      <SkillSetEditor
        mode={editorMode ?? "create"}
        open={editorMode !== null}
        availableSkills={inventory.data?.availableSkills ?? []}
        initialValue={editorMode === "edit" ? selected : null}
        draftValue={
          editorMode === "create" && sourceSuggestion
            ? {
                name: sourceSuggestion.name,
                description: sourceSuggestion.description,
                connections: sourceSuggestion.connections,
                skills: sourceSuggestion.skills.map((skill) => ({ ...skill })),
              }
            : editorMode === "create" && sourceExpansion
              ? {
                  name: sourceExpansion.name,
                  description: sourceExpansion.description,
                  connections: sourceExpansion.connections,
                  skills: sourceExpansion.skills.flatMap((skill): ProjectSkillSetInputSkill[] => {
                    if (skill.provenance === "installed" && skill.packagePath) {
                      return [{ name: skill.name, packagePath: skill.packagePath }];
                    }
                    if (
                      skill.provenance === "catalog" &&
                      skill.catalogId &&
                      skill.source &&
                      skill.installSpec
                    ) {
                      return [
                        {
                          name: skill.name,
                          provenance: "catalog",
                          catalogId: skill.catalogId,
                          source: skill.source,
                          installSpec: skill.installSpec,
                          downloadUrl: skill.downloadUrl,
                        },
                      ];
                    }
                    return [];
                  }),
                }
              : null
        }
        captureCandidates={captureCandidates}
        connectedHarnesses={inventory.data?.connectedHarnesses ?? []}
        canCreate={actions.create.access === "available"}
        canCapture={actions.derive.access === "available"}
        isPending={editorPending}
        onModeChange={setEditorMode}
        onOpenChange={(open) => {
          if (!open) {
            setEditorMode(null);
            setSourceSuggestion(null);
            setSourceExpansion(null);
          }
        }}
        onSubmit={(value) => {
          if (
            "projectRoot" in value &&
            actions.derive.access === "available" &&
            value.projectRoot.trim().length > 0
          ) {
            void run(actions.derive.execute(value), (created) => {
              setSelectedId(created.id);
              setSelectedRecommendationKey(null);
              setEditorMode(null);
              toast.success(`Captured ${created.name}`);
            });
          } else if (
            editorMode === "edit" &&
            selected &&
            actions.update.access === "available" &&
            "skills" in value
          ) {
            void run(
              actions.update.execute({
                ...value,
                id: selected.id,
                parentRevisionHash: selected.revisionHash,
                skills: value.skills.flatMap((skill) =>
                  skill.provenance === "catalog" ? [] : [skill],
                ),
              }),
              (updated) => {
                setSelectedId(updated.id);
                setSelectedRecommendationKey(null);
                setEditorMode(null);
                toast.success(`Updated ${updated.name}`);
              },
            );
          } else if (actions.create.access === "available" && "skills" in value) {
            void run(actions.create.execute(value), async (created) => {
              if (
                sourceSuggestion &&
                actions.reviewSuggestion.access === "available" &&
                intelligence.access === "available"
              ) {
                const editedFields = suggestionEditedFields(sourceSuggestion, value);
                try {
                  await actions.reviewSuggestion.execute({
                    suggestionId: sourceSuggestion.id,
                    evidenceFingerprint: sourceSuggestion.evidenceFingerprint,
                    decision: editedFields.length === 0 ? "accepted" : "edited",
                    reasonCode:
                      editedFields.length === 0
                        ? "accepted_as_suggested"
                        : "edited_before_creation",
                    reason:
                      editedFields.length === 0
                        ? "Created without changing the suggested composition."
                        : "Created after reviewing and changing the suggestion.",
                    resultingSkillSetId: created.id,
                    resultingRevisionHash: created.revisionHash,
                    editedFields,
                    result: {
                      name: value.name,
                      description: value.description,
                      connections: value.connections,
                      skills: value.skills.map((skill) => skill.name),
                    },
                  });
                  await intelligence.refresh();
                } catch (cause) {
                  setError({
                    title: "Skill Set created, but feedback was not recorded",
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "The suggestion review could not be saved.",
                    suggestion: "Refresh suggestions and retry the review if it remains visible.",
                    retryable: true,
                  });
                }
              }
              setSelectedId(created.id);
              setSelectedRecommendationKey(null);
              setEditorMode(null);
              setSourceSuggestion(null);
              setSourceExpansion(null);
              toast.success(`Created ${created.name}`);
            });
          }
        }}
      />
      {selected && actions.share?.access === "available" ? (
        <ShareSkillSetDialog
          skillSet={selected}
          open={shareOpen}
          onOpenChange={setShareOpen}
          action={actions.share}
          recipients={shareRecipients}
          workspaceAction={actions.shareWithWorkspace}
        />
      ) : null}
      {actions.share?.access === "upgrade" ? (
        <CloudFeatureGateDialog
          kind="skill-set"
          open={cloudShareGateOpen}
          onOpenChange={setCloudShareGateOpen}
          upgradeHref={actions.share.href}
          context={{
            name: selected?.name,
            detail: `${selected?.skills.length ?? 0} included skills · Revision ${selected?.revision ?? 1}`,
          }}
        />
      ) : null}
      {canProvision && actions.provision ? (
        <ProjectSetupDialog
          open={projectSetupOpen}
          onOpenChange={setProjectSetupOpen}
          provision={actions.provision}
          captureCandidates={captureCandidates}
          skillSetIds={projectSetupIds}
          skillSets={skillSets}
          receipts={inventory.data?.receipts ?? []}
          connectedHarnesses={inventory.data?.connectedHarnesses ?? []}
          toErrorMessage={(cause) => projectActionFailure(cause).message}
          onCompleted={async (result) => {
            toast.success(
              `Configured ${result.projectRoot} with ${result.receiptCount} Skill Set${result.receiptCount === 1 ? "" : "s"}.`,
            );
            await inventory.refresh();
          }}
        />
      ) : null}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Skill Set?</DialogTitle>
            <DialogDescription>
              {selected
                ? `${selected.name} will be removed from this library. Existing project installs are not changed.`
                : "This Skill Set will be removed from this library."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!selected || actions.remove.access !== "available"}
              onClick={() => {
                if (!selected || actions.remove.access !== "available") return;
                void run(actions.remove.execute(selected.id), () => {
                  setDeleteOpen(false);
                  setSelectedId(null);
                  toast.success(`Deleted ${selected.name}`);
                });
              }}
            >
              Delete Skill Set
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageScaffold>
  );
}

export function ProjectsScreen() {
  const projects = useDashboardHostAdapter().projects;
  if (projects.access === "unavailable") return <ProjectsUnavailable reason={projects.reason} />;
  if (projects.access === "upgrade") return <ProjectsUpgrade href={projects.href} />;
  return <AvailableProjects projects={projects} />;
}
