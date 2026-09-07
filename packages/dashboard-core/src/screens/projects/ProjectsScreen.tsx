"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  CheckIcon,
  ChevronDownIcon,
  FileDownIcon,
  EyeIcon,
  FolderIcon,
  FolderKanbanIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  Share2Icon,
  Trash2Icon,
} from "lucide-react";

import {
  type DashboardAssignedSkillSetsContribution,
  type DashboardLibraryActions,
  type DashboardLibraryContribution,
  type DashboardProjectsContribution,
  useSkillSetsModule,
} from "../../host";
import { CloudFeatureGateDialog } from "../../gates";
import type {
  ProjectCatalogSkillSetExpansionModel,
  ProjectSkillSetInput,
  ProjectSkillSetInputSkill,
  ProjectSkillSetPackPreviewModel,
  ProjectSkillSetPluginHost,
  ProjectSkillSetPluginInstallPreviewModel,
  ProjectSkillSetPublishPreviewModel,
  ProjectSkillSetReleaseReceiptModel,
  ProjectSkillSetSuggestionModel,
} from "../../models";
import { SkillSetEditor } from "./SkillSetEditor";
import { SkillSetIntelligencePanels } from "./SkillSetIntelligencePanels";
import { ProjectSetupDialog } from "./ProjectSetupDialog";
import { ShareSkillSetDialog } from "./ShareSkillSetDialog";
import { PublishSkillSetDialog } from "./PublishSkillSetDialog";
import { AssignedSkillSets } from "./AssignedSkillSets";
import { SharedSkillSetPacks } from "./SharedSkillSetPacks";
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
  HarnessIcon,
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
  Input,
  Label,
  Skeleton,
} from "@selftune/ui/primitives";
import { cn } from "@selftune/ui/lib";

export { SkillSetEditor, SkillSetSkillPicker } from "./SkillSetEditor";
export { PlanReview } from "./SkillSetInstallationPreview";

const useNoShareRecipients = () => [] as const;
const useNoPacks = () => ({
  data: null,
  isLoading: false,
  error: null,
  refresh: () => undefined,
});

export interface ProjectActionFailure {
  title: string;
  message: string;
  suggestion: string | null;
  retryable: boolean;
}

function failureProperty(cause: unknown, property: string): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(Object(cause), property);
}

function failureStringProperty(cause: unknown, property: string): string | null {
  const value = failureProperty(cause, property)?.value;
  return value === String(value) ? String(value) : null;
}

const failureCode = (cause: unknown) => failureStringProperty(cause, "code");

const failureSuggestion = (cause: unknown) => failureStringProperty(cause, "suggestion");

const failureRetryable = (cause: unknown) => failureProperty(cause, "retryable")?.value === true;

export function projectActionFailure(cause: unknown): ProjectActionFailure {
  const code = failureCode(cause);
  const message =
    cause instanceof Error
      ? cause.message
      : (failureStringProperty(cause, "message") ?? String(cause));
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
  assignments,
  projects,
  libraryActions,
}: {
  assignments?: DashboardAssignedSkillSetsContribution;
  projects: DashboardProjectsContribution & { access: "available" };
  libraryActions?: DashboardLibraryActions;
}) {
  const inventory = projects.useInventory();
  const intelligence = projects.useIntelligence();
  const actions = projects.useActions();
  const useShareRecipients = actions.useShareRecipients ?? useNoShareRecipients;
  const shareRecipients = useShareRecipients();
  const usePacks = actions.usePacks ?? useNoPacks;
  const packInventory = usePacks();
  const initialPackUrl = useRef(
    globalThis.window === undefined
      ? null
      : new URLSearchParams(globalThis.window.location.search).get("pack"),
  );
  const handoffHandled = useRef(false);
  const [workspaceView, setWorkspaceView] = useState<SkillSetWorkspaceView>("sets");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRecommendationKey, setSelectedRecommendationKey] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const [editorMode, setEditorMode] = useState<SkillSetEditorMode | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishPreview, setPublishPreview] = useState<ProjectSkillSetPublishPreviewModel | null>(
    null,
  );
  const [publishReceipt, setPublishReceipt] = useState<ProjectSkillSetReleaseReceiptModel | null>(
    null,
  );
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishPreviewLoading, setPublishPreviewLoading] = useState(false);
  const [publishSubmitting, setPublishSubmitting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [pluginInstallOpen, setPluginInstallOpen] = useState(false);
  const [pluginInstallPreview, setPluginInstallPreview] =
    useState<ProjectSkillSetPluginInstallPreviewModel | null>(null);
  const [pluginInstallHosts, setPluginInstallHosts] = useState<ProjectSkillSetPluginHost[]>([]);
  const [packOpen, setPackOpen] = useState(initialPackUrl.current !== null);
  const [packUrl, setPackUrl] = useState(initialPackUrl.current ?? "");
  const [packPreview, setPackPreview] = useState<ProjectSkillSetPackPreviewModel | null>(null);
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

  useEffect(() => {
    const handoff = initialPackUrl.current;
    const preview = actions.importPack?.preview;
    if (!handoff || handoffHandled.current || preview?.access !== "available") return;
    handoffHandled.current = true;
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.delete("pack");
    window.history.replaceState(window.history.state, "", currentUrl);
    setError(null);
    void preview.execute(handoff).then(setPackPreview, (cause: unknown) => {
      setError(projectActionFailure(cause));
    });
  }, [actions.importPack]);

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
  const packPreviewAction =
    actions.importPack?.preview.access === "available" ? actions.importPack.preview : null;
  const packImportAction =
    actions.importPack?.execute.access === "available" ? actions.importPack.execute : null;
  const pluginInstallPreviewAction =
    actions.installPlugin?.preview.access === "available" ? actions.installPlugin.preview : null;
  const pluginInstallAction =
    actions.installPlugin?.execute.access === "available" ? actions.installPlugin.execute : null;
  const publishPreviewAction =
    actions.publishRelease?.preview.access === "available" ? actions.publishRelease.preview : null;
  const publishAction =
    actions.publishRelease?.execute.access === "available" ? actions.publishRelease.execute : null;

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
        canImport={packPreviewAction !== null && packImportAction !== null}
        onImport={() => {
          setPackPreview(null);
          setPackOpen(true);
        }}
      />

      {error ? <ProjectActionNotice failure={error} /> : null}

      {assignments ? <AssignedSkillSets contribution={assignments} /> : null}

      {supportsIntelligence || actions.usePacks ? (
        <SkillSetWorkspaceNavigation
          value={workspaceView}
          skillSetCount={skillSets.length}
          outcomeCount={intelligenceReport?.outcomes.length ?? 0}
          traceSignalCount={intelligenceReport?.traceSignals.length ?? 0}
          packCount={packInventory.data?.length ?? 0}
          showIntelligence={supportsIntelligence}
          onValueChange={setWorkspaceView}
        />
      ) : null}

      {workspaceView === "shared-packs" ? (
        <SharedSkillSetPacks
          query={packInventory}
          revoke={actions.revokePack}
          onCreatePack={() => {
            if (selected && actions.share?.access === "available") {
              setShareOpen(true);
              return;
            }
            setWorkspaceView("sets");
            openCreateEditor();
          }}
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
                {packPreviewAction && packImportAction ? (
                  <Button variant="outline" onClick={() => setPackOpen(true)}>
                    Add from URL
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
                    {pluginInstallPreviewAction && pluginInstallAction ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setPluginInstallPreview(null);
                          setPluginInstallHosts([]);
                          setPluginInstallOpen(true);
                          void run(pluginInstallPreviewAction.execute(selected.id), (preview) => {
                            setPluginInstallPreview(preview);
                            setPluginInstallHosts(
                              preview.hosts
                                .filter((host) => host.available)
                                .map((host) => host.host),
                            );
                          });
                        }}
                      >
                        <PlugIcon data-icon="inline-start" />
                        Install plugin
                      </Button>
                    ) : null}
                    {actions.export.access === "available" &&
                    actions.export.requiresProjectRoot !== true ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (actions.export.access !== "available") return;
                          if ((actions.export.formats?.length ?? 0) > 1) {
                            setExportOpen(true);
                            return;
                          }
                          void run(
                            actions.export.execute({
                              skillSetId: selected.id,
                              projectRoot: "",
                              format: actions.export.formats?.[0]?.id,
                            }),
                            (result) => {
                              toast.success(`Saved ${result.outputPath}`);
                            },
                          );
                        }}
                      >
                        <FileDownIcon data-icon="inline-start" />
                        {actions.export.label ?? "Export Skill Set"}
                      </Button>
                    ) : null}
                    {actions.remove.access === "available" ? (
                      <Button
                        variant="destructive"
                        aria-label="Delete Skill Set"
                        onClick={() => setDeleteOpen(true)}
                      >
                        <Trash2Icon data-icon="inline-start" />
                        Delete
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
                      Send a link
                    </Button>
                  ) : actions.share?.access === "upgrade" ? (
                    <Button variant="outline" onClick={() => setCloudShareGateOpen(true)}>
                      <Share2Icon data-icon="inline-start" />
                      Send a link
                    </Button>
                  ) : null}
                  {publishPreviewAction && publishAction ? (
                    <Button
                      onClick={() => {
                        setPublishPreview(null);
                        setPublishReceipt(null);
                        setPublishError(null);
                        setPublishPreviewLoading(true);
                        setPublishOpen(true);
                        void publishPreviewAction
                          .execute({
                            skillSetId: selected.id,
                            dependencyResolution: {
                              roots: selected.skills.map((skill) => skill.name),
                              available_packages: selected.skills.map((skill) => ({
                                package_id: skill.name,
                                version: "1.0.0",
                                revision_sha256: skill.contentHash,
                                dependencies: { requires: [], optional: [], conflicts: [] },
                                compatibility: {
                                  harnesses: selected.connections,
                                  required_capabilities: [],
                                },
                                provides: [],
                              })),
                              environment: {
                                harness: selected.connections[0] ?? "codex",
                                capabilities: [],
                              },
                              current_lock: [],
                            },
                          })
                          .then(setPublishPreview, (cause: unknown) => {
                            const failure = projectActionFailure(cause);
                            setPublishError(
                              [failure.message, failure.suggestion].filter(Boolean).join(" "),
                            );
                          })
                          .finally(() => setPublishPreviewLoading(false));
                      }}
                    >
                      Publish to team
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
          previewLicenseAction={libraryActions?.previewLicenseDraft}
          applyLicenseAction={libraryActions?.applyLicenseDraft}
          onShared={packInventory.refresh}
        />
      ) : null}
      {selected && publishPreviewAction && publishAction ? (
        <PublishSkillSetDialog
          skillSet={selected}
          open={publishOpen}
          onOpenChange={(open) => {
            setPublishOpen(open);
            if (!open) {
              setPublishPreview(null);
              setPublishReceipt(null);
              setPublishError(null);
              setPublishPreviewLoading(false);
              setPublishSubmitting(false);
            }
          }}
          preview={publishPreview}
          receipt={publishReceipt}
          previewPending={
            (publishPreviewLoading || Boolean(publishPreviewAction.isPending)) &&
            publishPreview === null
          }
          publishPending={publishSubmitting || Boolean(publishAction.isPending)}
          error={publishError}
          onPublish={() => {
            if (!publishPreview) return;
            setPublishError(null);
            setPublishSubmitting(true);
            void publishAction
              .execute({
                skillSetId: publishPreview.skillSetId,
                expectedSkillSetRevisionSha256: publishPreview.skillSetRevisionSha256,
                expectedEnvelopeSha256: publishPreview.envelopeSha256,
                dependencyResolution: publishPreview.dependencyInput,
                expectedDependencyLock: publishPreview.dependencies.lock,
                confirmPublish: true,
              })
              .then(setPublishReceipt, (cause: unknown) => {
                const failure = projectActionFailure(cause);
                setPublishError([failure.message, failure.suggestion].filter(Boolean).join(" "));
              })
              .finally(() => setPublishSubmitting(false));
          }}
        />
      ) : null}
      {selected && pluginInstallPreviewAction && pluginInstallAction ? (
        <Dialog
          open={pluginInstallOpen}
          onOpenChange={(open) => {
            setPluginInstallOpen(open);
            if (!open) {
              setPluginInstallPreview(null);
              setPluginInstallHosts([]);
            }
          }}
        >
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Install {selected.name} as a plugin</DialogTitle>
              <DialogDescription>
                SelfTune will register a local marketplace and ask each selected host to install the
                exact reviewed revision. It never edits Claude or Codex registry files directly.
              </DialogDescription>
            </DialogHeader>
            {pluginInstallPreview ? (
              <div className="grid gap-4">
                <div className="rounded-lg border px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">{pluginInstallPreview.pluginName}</p>
                      <p className="text-xs text-muted-foreground">
                        {pluginInstallPreview.skillNames.length} skills · skills only · local user
                        scope
                      </p>
                    </div>
                    <Badge variant="outline">{pluginInstallPreview.pluginVersion}</Badge>
                  </div>
                  <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">
                    Revision {pluginInstallPreview.revisionHash}
                  </p>
                </div>
                <div
                  className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                  role="group"
                  aria-label="Plugin destinations"
                >
                  {pluginInstallPreview.hosts.map((host) => {
                    const selectedHost = pluginInstallHosts.includes(host.host);
                    const harness = connectedHarnessesById.get(
                      host.host === "claude" ? "claude_code" : "codex",
                    );
                    const status =
                      host.status === "already_current"
                        ? "Installed"
                        : host.status === "update_available"
                          ? "Update available"
                          : host.status === "ready"
                            ? "Ready"
                            : "Not found";
                    return (
                      <button
                        key={host.host}
                        type="button"
                        disabled={!host.available}
                        aria-pressed={selectedHost}
                        data-selected={selectedHost ? "true" : "false"}
                        className={cn(
                          "group relative min-h-44 overflow-hidden rounded-2xl border p-5 text-left transition-[transform,background-color,border-color,color] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98]",
                          selectedHost
                            ? "border-info bg-secondary text-secondary-foreground ring-1 ring-info/25"
                            : "border-border bg-background text-foreground hover:border-info/60 hover:bg-secondary/30",
                          !host.available &&
                            "cursor-not-allowed opacity-50 hover:border-border hover:bg-background",
                        )}
                        onClick={() => {
                          if (!host.available) return;
                          setPluginInstallHosts((current) =>
                            selectedHost
                              ? current.filter((candidate) => candidate !== host.host)
                              : [...new Set([...current, host.host])],
                          );
                        }}
                      >
                        <span className="flex items-start justify-between gap-4">
                          {harness?.icon ? (
                            <HarnessIcon
                              name={host.label}
                              icon={harness.icon}
                              className={cn(
                                "size-12 rounded-xl transition-transform duration-200 group-hover:scale-[1.04]",
                                selectedHost && "border-info/30 bg-background/55",
                              )}
                            />
                          ) : (
                            <span
                              aria-hidden="true"
                              className={cn(
                                "flex size-12 items-center justify-center rounded-xl border bg-muted",
                                selectedHost && "border-info/30 bg-background/55",
                              )}
                            >
                              <PlugIcon className="size-5" />
                            </span>
                          )}
                          {selectedHost ? (
                            <span
                              aria-hidden="true"
                              className="flex size-12 items-center justify-center rounded-xl bg-white/65 text-info-foreground ring-1 ring-inset ring-white/80 backdrop-blur-md"
                            >
                              <CheckIcon className="size-7" />
                            </span>
                          ) : (
                            <span className="inline-flex h-7 items-center rounded-full bg-muted px-2.5 text-[11px] font-medium text-muted-foreground">
                              {status}
                            </span>
                          )}
                        </span>
                        <span className="mt-7 block">
                          <span className="block font-headline text-lg font-semibold tracking-tight">
                            {host.label}
                          </span>
                          <span
                            className={cn(
                              "mt-1 block text-xs leading-relaxed",
                              selectedHost
                                ? "text-secondary-foreground/70"
                                : "text-muted-foreground",
                            )}
                          >
                            {host.available
                              ? host.activation
                              : `Install ${host.label} on this Mac to enable this target.`}
                          </span>
                          {host.installedVersion ? (
                            <span
                              className={cn(
                                "mt-3 block font-mono text-[10px]",
                                selectedHost
                                  ? "text-secondary-foreground/60"
                                  : "text-muted-foreground",
                              )}
                            >
                              Current {host.installedVersion}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  The host copies this plugin into its own cache. Updating the Skill Set later does
                  not change the installed plugin until you confirm another install.
                </p>
              </div>
            ) : (
              <div
                className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                aria-label="Checking installed plugin hosts"
              >
                <Skeleton className="h-44 w-full rounded-2xl" />
                <Skeleton className="h-44 w-full rounded-2xl" />
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setPluginInstallOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={
                  !pluginInstallPreview ||
                  pluginInstallHosts.length === 0 ||
                  Boolean(pluginInstallAction.isPending)
                }
                onClick={() => {
                  if (!pluginInstallPreview) return;
                  void run(
                    pluginInstallAction.execute({
                      skillSetId: pluginInstallPreview.setId,
                      expectedRevisionHash: pluginInstallPreview.revisionHash,
                      hosts: pluginInstallHosts,
                    }),
                    (receipt) => {
                      setPluginInstallOpen(false);
                      setPluginInstallPreview(null);
                      setPluginInstallHosts([]);
                      const labels = receipt.hosts.map((host) =>
                        host.host === "claude" ? "Claude" : "Codex",
                      );
                      toast.success(`Installed ${receipt.pluginName} in ${labels.join(" and ")}`);
                    },
                  );
                }}
              >
                {pluginInstallAction.isPending
                  ? "Installing…"
                  : pluginInstallHosts.length > 1
                    ? "Install in both"
                    : "Install plugin"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {selected && actions.export.access === "available" && actions.export.formats ? (
        <Dialog open={exportOpen} onOpenChange={setExportOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Export {selected.name}</DialogTitle>
              <DialogDescription>
                Every option uses the same sealed Skill Set revision. Plugin ZIPs must be inspected
                and installed through the selected host; they are not direct-install URLs.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              {actions.export.formats.map((format) => (
                <Button
                  key={format.id}
                  variant="outline"
                  className="h-auto items-start justify-start px-4 py-3 text-left"
                  onClick={() => {
                    void run(
                      actions.export.access === "available"
                        ? actions.export.execute({
                            skillSetId: selected.id,
                            projectRoot: "",
                            format: format.id,
                          })
                        : Promise.reject(),
                      (result) => {
                        setExportOpen(false);
                        toast.success(`Saved ${result.outputPath}`);
                      },
                    );
                  }}
                >
                  <span>
                    <span className="block font-medium">{format.label}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {format.description}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
      {packPreviewAction && packImportAction ? (
        <Dialog
          open={packOpen}
          onOpenChange={(open) => {
            setPackOpen(open);
            if (!open) setPackPreview(null);
          }}
        >
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Add Skill Set from URL</DialogTitle>
              <DialogDescription>
                Paste a SelfTune Pack link. Desktop verifies the origin, immutable object hash,
                component hashes, paths, and license terms before anything is imported.
              </DialogDescription>
            </DialogHeader>
            {packPreview ? (
              <div className="grid gap-4">
                <div>
                  <p className="font-medium">{packPreview.name}</p>
                  {packPreview.description ? (
                    <p className="mt-1 text-sm text-muted-foreground">{packPreview.description}</p>
                  ) : null}
                </div>
                <div className="rounded-lg border">
                  {packPreview.components.map((component) => (
                    <div
                      key={component.logicalSkillId}
                      className="flex items-center justify-between gap-4 border-b px-3 py-2 text-sm last:border-b-0"
                    >
                      <span className="font-medium">{component.logicalSkillId}</span>
                      <span className="text-muted-foreground">{component.licenseExpression}</span>
                    </div>
                  ))}
                </div>
                <p className="break-all font-mono text-xs text-muted-foreground">
                  Revision {packPreview.skillSetRevisionSha256}
                </p>
                <p className="text-xs text-muted-foreground">
                  {packPreview.mode === "private_single_claim"
                    ? "This link is consumed by the first successful download."
                    : "This is an unlisted reusable link."}{" "}
                  Expires {new Date(packPreview.expiresAt).toLocaleString()}.
                </p>
              </div>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor="skill-set-pack-url">Pack URL</Label>
                <Input
                  id="skill-set-pack-url"
                  autoFocus
                  placeholder="https://cloud.selftune.dev/p/…"
                  value={packUrl}
                  onChange={(event) => setPackUrl(event.target.value)}
                />
              </div>
            )}
            <DialogFooter>
              {packPreview ? (
                <Button variant="outline" onClick={() => setPackPreview(null)}>
                  Back
                </Button>
              ) : null}
              <Button
                disabled={!packUrl.trim()}
                onClick={() => {
                  if (!packPreview) {
                    void run(packPreviewAction.execute(packUrl.trim()), setPackPreview);
                    return;
                  }
                  void run(
                    packImportAction.execute({
                      packUrl: packPreview.packUrl,
                      expectedObjectSha256: packPreview.objectSha256,
                    }),
                    (imported) => {
                      setPackOpen(false);
                      setPackPreview(null);
                      setPackUrl("");
                      setSelectedId(imported.id);
                      toast.success(`Imported ${imported.name}`);
                    },
                  );
                }}
              >
                {packPreview ? "Import Pack" : "Review Pack"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
  const { assignments, library, projects } = useSkillSetsModule();
  if (projects.access === "unavailable") return <ProjectsUnavailable reason={projects.reason} />;
  if (projects.access === "upgrade") return <ProjectsUpgrade href={projects.href} />;
  if (library.access === "available") {
    return (
      <ProjectsWithLibraryActions assignments={assignments} projects={projects} library={library} />
    );
  }
  return <AvailableProjects assignments={assignments} projects={projects} />;
}

function ProjectsWithLibraryActions({
  assignments,
  projects,
  library,
}: {
  assignments?: DashboardAssignedSkillSetsContribution;
  projects: DashboardProjectsContribution & { access: "available" };
  library: DashboardLibraryContribution & { access: "available" };
}) {
  return (
    <AvailableProjects
      assignments={assignments}
      projects={projects}
      libraryActions={library.useActions()}
    />
  );
}
