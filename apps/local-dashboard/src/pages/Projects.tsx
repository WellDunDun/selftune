import { Badge, Checkbox } from "@selftune/ui/primitives";
import { PageHeader, PageScaffold } from "@selftune/ui/components";
import {
  ArchiveRestoreIcon,
  CheckIcon,
  ChevronRightIcon,
  FileDownIcon,
  FolderInputIcon,
  FolderGit2Icon,
  LinkIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useLibrary } from "@/hooks/useLibrary";
import {
  useApplySkillSet,
  useCreateSkillSet,
  useDeriveSkillSet,
  useExportSkillSet,
  usePreviewSkillSet,
  useRollbackSkillSet,
  useSkillSets,
  useUpdateSkillSet,
} from "@/hooks/useSkillSets";

type HarnessChoice = "codex" | "claude_code" | "opencode" | "openclaw" | "pi";

const harnessLabels: Record<HarnessChoice, string> = {
  codex: "Codex",
  claude_code: "Claude Code",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  pi: "Pi",
};

function ProjectsSkeleton() {
  return (
    <PageScaffold aria-label="Loading projects" aria-busy="true">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-7 w-24" />
        </div>
      </header>
      <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]" aria-hidden="true">
        <section className="flex flex-col gap-2">
          <Skeleton className="h-3 w-20" />
          <div className="divide-y divide-border/60 border border-border/60">
            {["first", "second", "third", "fourth"].map((id) => (
              <div key={id} className="flex items-center gap-3 px-3 py-3">
                <Skeleton className="size-4 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-32 max-w-full" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="flex flex-col gap-5">
          <div className="flex items-start justify-between gap-4 border-b border-border/60 pb-4">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-64 max-w-full" />
            </div>
            <Skeleton className="h-7 w-20" />
          </div>
          <Skeleton className="h-9 w-full" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        </section>
      </div>
    </PageScaffold>
  );
}

export function Projects() {
  const skillSets = useSkillSets();
  const library = useLibrary();
  const createSet = useCreateSkillSet();
  const updateSet = useUpdateSkillSet();
  const deriveSet = useDeriveSkillSet();
  const exportSet = useExportSkillSet();
  const previewSet = usePreviewSkillSet();
  const applySet = useApplySkillSet();
  const rollbackSet = useRollbackSkillSet();
  const [showCreate, setShowCreate] = useState(false);
  const [captureMode, setCaptureMode] = useState(false);
  const [editingSetId, setEditingSetId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [harnesses, setHarnesses] = useState<HarnessChoice[]>(["codex"]);
  const [selectedSkillPaths, setSelectedSkillPaths] = useState<string[]>([]);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(
    () => skillSets.data?.sets[0]?.set_id ?? null,
  );
  const [projectRoot, setProjectRoot] = useState("");

  useEffect(() => {
    const sets = skillSets.data?.sets ?? [];
    if (!selectedSetId && sets[0]) setSelectedSetId(sets[0].set_id);
    if (selectedSetId && !sets.some((set) => set.set_id === selectedSetId)) {
      setSelectedSetId(sets[0]?.set_id ?? null);
    }
  }, [selectedSetId, skillSets.data]);

  const selectedSet = skillSets.data?.sets.find((set) => set.set_id === selectedSetId) ?? null;
  const availableSkills = useMemo(
    () =>
      (library.data?.skills ?? []).flatMap((skill) =>
        skill.revisions.flatMap((revision) => {
          const location = revision.locations.find(
            (candidate) => candidate.sourceKind !== "archived",
          );
          return location
            ? [
                {
                  key: `${skill.skillId}:${revision.contentHash}`,
                  name: skill.name,
                  package_path: location.packagePath,
                  content_hash: revision.contentHash,
                  lifecycle: skill.lifecycle,
                },
              ]
            : [];
        }),
      ),
    [library.data],
  );
  const selectedAvailableSkills = useMemo(
    () => availableSkills.filter((skill) => selectedSkillPaths.includes(skill.package_path)),
    [availableSkills, selectedSkillPaths],
  );
  const activeReceipts = (skillSets.data?.receipts ?? []).filter(
    (receipt) =>
      (receipt.status === "applied" || receipt.status === "applying") &&
      receipt.operations.length > 0,
  );
  const hasSkillSets = (skillSets.data?.sets.length ?? 0) > 0;

  if (skillSets.isLoading || library.isLoading) return <ProjectsSkeleton />;

  const loadError = skillSets.error ?? library.error;
  if (loadError) {
    return (
      <PageScaffold>
        <div className="flex items-center justify-between border border-destructive/30 bg-destructive/10 p-4">
          <p className="text-sm text-destructive">
            {loadError instanceof Error ? loadError.message : "Projects could not be loaded."}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void skillSets.refetch();
              void library.refetch();
            }}
          >
            <RefreshCwIcon /> Retry
          </Button>
        </div>
      </PageScaffold>
    );
  }

  function toggleHarness(harness: HarnessChoice) {
    setHarnesses((current) =>
      current.includes(harness)
        ? current.filter((candidate) => candidate !== harness)
        : [...current, harness],
    );
  }

  function openNewSkillSet() {
    setCaptureMode(false);
    setEditingSetId(null);
    setName("");
    setDescription("");
    setHarnesses(["codex"]);
    setSelectedSkillPaths([]);
    setShowCreate(true);
  }

  function openCaptureProject() {
    setCaptureMode(true);
    setEditingSetId(null);
    setName("");
    setDescription("");
    setHarnesses(["codex"]);
    setProjectRoot("");
    setShowCreate(true);
  }

  function submitCreate() {
    if (captureMode) {
      deriveSet.mutate(
        { name, description, harnesses, project_root: projectRoot },
        {
          onSuccess: (manifest) => {
            setSelectedSetId(manifest.set_id);
            setName("");
            setDescription("");
            setShowCreate(false);
            setCaptureMode(false);
            toast.success(`Captured ${manifest.name}`);
          },
          onError: (error) =>
            toast.error("Project could not be captured", {
              description: error instanceof Error ? error.message : String(error),
            }),
        },
      );
      return;
    }
    if (editingSetId) {
      const current = skillSets.data?.sets.find((set) => set.set_id === editingSetId);
      if (!current) return;
      updateSet.mutate(
        {
          set_id: current.set_id,
          parent_revision_hash: current.revision_hash,
          name,
          description,
          harnesses,
          skills: selectedAvailableSkills.map((skill) => ({
            name: skill.name,
            package_path: skill.package_path,
          })),
        },
        {
          onSuccess: (manifest) => {
            setSelectedSetId(manifest.set_id);
            setShowCreate(false);
            setEditingSetId(null);
            toast.success(`Updated ${manifest.name} to v${manifest.revision}`);
          },
          onError: (error) =>
            toast.error("Skill Set could not be updated", {
              description: error instanceof Error ? error.message : String(error),
            }),
        },
      );
      return;
    }
    createSet.mutate(
      {
        name,
        description,
        harnesses,
        skills: selectedAvailableSkills.map((skill) => ({
          name: skill.name,
          package_path: skill.package_path,
        })),
      },
      {
        onSuccess: (manifest) => {
          setSelectedSetId(manifest.set_id);
          setName("");
          setDescription("");
          setSelectedSkillPaths([]);
          setShowCreate(false);
          toast.success(`Created ${manifest.name}`);
        },
        onError: (error) =>
          toast.error("Skill Set could not be created", {
            description: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  function preview() {
    if (!selectedSet) return;
    previewSet.mutate(
      { set_id: selectedSet.set_id, project_root: projectRoot },
      {
        onError: (error) =>
          toast.error("Preview failed", {
            description: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  function apply() {
    if (!selectedSet || !previewSet.data) return;
    applySet.mutate(
      { set_id: selectedSet.set_id, project_root: projectRoot },
      {
        onSuccess: (receipt) => {
          toast.success(
            receipt.status === "unchanged"
              ? `${receipt.set_name} is already applied`
              : `Applied ${receipt.set_name}`,
          );
          previewSet.reset();
        },
        onError: (error) =>
          toast.error("Apply failed", {
            description: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  return (
    <PageScaffold>
      <PageHeader
        title="Projects"
        description={`${skillSets.data?.sets.length ?? 0} Skill Sets, ${activeReceipts.length} active installs`}
        actions={
          hasSkillSets ? (
            <>
              <Button variant="outline" size="sm" onClick={openCaptureProject}>
                <FolderInputIcon data-icon="inline-start" /> Capture Project
              </Button>
              <Button size="sm" onClick={openNewSkillSet}>
                <PlusIcon data-icon="inline-start" /> New Skill Set
              </Button>
            </>
          ) : undefined
        }
      />

      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          setShowCreate(open);
          if (!open) {
            setCaptureMode(false);
            setEditingSetId(null);
          }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {editingSetId ? "Edit Skill Set" : captureMode ? "Capture Project" : "New Skill Set"}
            </DialogTitle>
            <DialogDescription>
              {captureMode
                ? "Create a Skill Set from the skills already configured in a project folder."
                : "Choose the harnesses and Library skills this Skill Set should install."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              submitCreate();
            }}
          >
            <div
              className={
                captureMode
                  ? "grid gap-5"
                  : "grid gap-5 md:grid-cols-[minmax(240px,0.8fr)_minmax(360px,1.2fr)]"
              }
            >
              <div className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-foreground">Name</span>
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Research project"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-foreground">Description</span>
                  <Input
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Optional"
                  />
                </label>
                <fieldset>
                  <legend className="mb-2 text-xs font-medium text-foreground">Harnesses</legend>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    {(
                      [
                        ["codex", "Codex"],
                        ["claude_code", "Claude Code"],
                        ["opencode", "OpenCode"],
                        ["openclaw", "OpenClaw"],
                        ["pi", "Pi"],
                      ] as const
                    ).map(([value, label]) => (
                      <label
                        key={value}
                        className="inline-flex min-w-0 items-center gap-2 whitespace-nowrap text-sm text-foreground"
                      >
                        <Checkbox
                          checked={harnesses.includes(value)}
                          onCheckedChange={() => toggleHarness(value)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                {captureMode ? (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-foreground">Project folder</span>
                    <Input
                      value={projectRoot}
                      onChange={(event) => setProjectRoot(event.target.value)}
                      placeholder="/Users/you/Projects/example"
                    />
                  </label>
                ) : null}
              </div>

              {!captureMode ? (
                <div className="min-w-0">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">Skills</span>
                    <span className="text-xs text-muted-foreground">
                      {selectedSkillPaths.length} selected
                    </span>
                  </div>
                  {availableSkills.length === 0 ? (
                    <div className="border border-border/60 p-4 text-sm text-muted-foreground">
                      No Library revisions found.
                    </div>
                  ) : (
                    <Combobox
                      items={availableSkills}
                      multiple
                      value={selectedAvailableSkills}
                      onValueChange={(skills) =>
                        setSelectedSkillPaths(skills.map((skill) => skill.package_path))
                      }
                      itemToStringValue={(skill) =>
                        `${skill.name} ${skill.package_path} ${skill.content_hash}`
                      }
                    >
                      <ComboboxChips aria-label="Skills">
                        <ComboboxValue>
                          {selectedAvailableSkills.map((skill) => (
                            <ComboboxChip key={skill.key}>{skill.name}</ComboboxChip>
                          ))}
                        </ComboboxValue>
                        <ComboboxChipsInput placeholder="Search and add skills…" />
                      </ComboboxChips>
                      <ComboboxContent>
                        <ComboboxEmpty>No matching skills.</ComboboxEmpty>
                        <ComboboxList>
                          {(skill) => (
                            <ComboboxItem key={skill.key} value={skill}>
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium text-foreground">
                                  {skill.name}
                                </span>
                                <span className="block truncate text-[11px] text-muted-foreground">
                                  {skill.content_hash.slice(0, 10)} · {skill.package_path}
                                </span>
                              </span>
                              <Badge
                                variant="outline"
                                className="border-border/60 text-muted-foreground"
                              >
                                {skill.lifecycle}
                              </Badge>
                            </ComboboxItem>
                          )}
                        </ComboboxList>
                      </ComboboxContent>
                    </Combobox>
                  )}
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  !name.trim() ||
                  harnesses.length === 0 ||
                  (captureMode ? !projectRoot.trim() : selectedSkillPaths.length === 0) ||
                  createSet.isPending ||
                  updateSet.isPending ||
                  deriveSet.isPending
                }
              >
                <CheckIcon />{" "}
                {deriveSet.isPending
                  ? "Capturing"
                  : updateSet.isPending
                    ? "Updating"
                    : createSet.isPending
                      ? "Creating"
                      : editingSetId
                        ? "Update"
                        : captureMode
                          ? "Capture"
                          : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        {!hasSkillSets ? (
          <Empty className="min-h-[420px] lg:col-span-2">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderGit2Icon />
              </EmptyMedia>
              <EmptyTitle>No Skill Sets yet</EmptyTitle>
              <EmptyDescription>
                Create a reusable bundle of Library skills and harnesses, or capture one from an
                existing project.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={openNewSkillSet}>
                  <PlusIcon data-icon="inline-start" />
                  Create Skill Set
                </Button>
                <Button variant="outline" onClick={openCaptureProject}>
                  <FolderInputIcon data-icon="inline-start" />
                  Capture Project
                </Button>
              </div>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <section aria-label="Skill Sets">
              <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                Skill Sets
              </div>
              <div className="border border-border/60">
                {skillSets.data?.sets.map((set) => (
                  <Button
                    key={set.set_id}
                    variant={selectedSetId === set.set_id ? "secondary" : "ghost"}
                    onClick={() => {
                      setSelectedSetId(set.set_id);
                      previewSet.reset();
                    }}
                    className="h-auto w-full justify-start rounded-none border-b border-border/50 px-3 py-3 text-left last:border-b-0"
                  >
                    <FolderGit2Icon className="size-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {set.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        v{set.revision} · {set.skills.length} skill
                        {set.skills.length === 1 ? "" : "s"}
                      </span>
                    </span>
                    <ChevronRightIcon className="size-4 text-muted-foreground" />
                  </Button>
                ))}
              </div>
            </section>

            <section aria-label="Project installation">
              {selectedSet ? (
                <div className="flex flex-col gap-5">
                  <div className="flex flex-col gap-3 border-b border-border/60 pb-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h2 className="text-base font-semibold text-foreground">
                        {selectedSet.name}
                      </h2>
                      {selectedSet.description ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {selectedSet.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {selectedSet.harnesses.map((harness) => (
                        <Badge key={harness} variant="outline" className="border-border/60">
                          {harnessLabels[harness as HarnessChoice]}
                        </Badge>
                      ))}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Edit Skill Set"
                        onClick={() => {
                          setCaptureMode(false);
                          setEditingSetId(selectedSet.set_id);
                          setName(selectedSet.name);
                          setDescription(selectedSet.description);
                          setHarnesses(selectedSet.harnesses);
                          setSelectedSkillPaths(
                            selectedSet.skills.flatMap((pinned) => {
                              const available = availableSkills.find(
                                (skill) =>
                                  skill.name === pinned.name &&
                                  skill.content_hash === pinned.content_hash,
                              );
                              return available ? [available.package_path] : [];
                            }),
                          );
                          setShowCreate(true);
                        }}
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!projectRoot.trim() || exportSet.isPending}
                        onClick={() =>
                          exportSet.mutate(
                            {
                              set_id: selectedSet.set_id,
                              project_root: projectRoot,
                            },
                            {
                              onSuccess: ({ output_path }) => toast.success(`Saved ${output_path}`),
                              onError: (error) =>
                                toast.error("Manifest could not be saved", {
                                  description:
                                    error instanceof Error ? error.message : String(error),
                                }),
                            },
                          )
                        }
                      >
                        <FileDownIcon /> Save to Project
                      </Button>
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 text-xs font-medium text-foreground">Pinned skills</div>
                    <div className="flex flex-wrap gap-2">
                      {selectedSet.skills.map((skill) => (
                        <span
                          key={`${skill.name}:${skill.content_hash}`}
                          className="inline-flex items-center gap-2 border border-border/60 bg-muted/20 px-2.5 py-1.5 text-xs text-foreground"
                        >
                          {skill.name}
                          <code className="text-[10px] text-muted-foreground">
                            {skill.content_hash.slice(0, 8)}
                          </code>
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-foreground">Project folder</span>
                      <Input
                        value={projectRoot}
                        onChange={(event) => {
                          setProjectRoot(event.target.value);
                          previewSet.reset();
                        }}
                        placeholder="/Users/you/Projects/example"
                      />
                    </label>
                    <Button
                      variant="outline"
                      className="self-end"
                      disabled={!projectRoot.trim() || previewSet.isPending}
                      onClick={preview}
                    >
                      <LinkIcon /> {previewSet.isPending ? "Checking" : "Preview"}
                    </Button>
                  </div>

                  {previewSet.data ? (
                    <div className="border border-border/60">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-muted/20 px-3 py-2">
                        <div className="flex gap-3 text-xs">
                          <span className="text-primary">{previewSet.data.creates} create</span>
                          <span className="text-muted-foreground">
                            {previewSet.data.unchanged} unchanged
                          </span>
                          <span
                            className={
                              previewSet.data.conflicts > 0
                                ? "text-destructive"
                                : "text-muted-foreground"
                            }
                          >
                            {previewSet.data.conflicts} conflicts
                          </span>
                        </div>
                        <Button
                          size="sm"
                          disabled={
                            previewSet.data.conflicts > 0 ||
                            previewSet.data.creates === 0 ||
                            applySet.isPending
                          }
                          onClick={apply}
                        >
                          <LinkIcon /> {applySet.isPending ? "Applying" : "Apply"}
                        </Button>
                      </div>
                      {previewSet.data.operations.map((operation) => (
                        <div
                          key={`${operation.harness}:${operation.skill_name}`}
                          className="grid gap-2 border-b border-border/50 px-3 py-2.5 last:border-b-0 sm:grid-cols-[110px_150px_minmax(0,1fr)] sm:items-center"
                        >
                          <Badge
                            variant="outline"
                            className={
                              operation.action === "conflict"
                                ? "w-fit border-destructive/30 text-destructive"
                                : operation.action === "create"
                                  ? "w-fit border-primary/30 text-primary"
                                  : "w-fit border-border/60 text-muted-foreground"
                            }
                          >
                            {operation.action === "conflict" ? (
                              <ShieldAlertIcon className="mr-1 size-3" />
                            ) : null}
                            {operation.action}
                          </Badge>
                          <span className="text-sm text-foreground">{operation.skill_name}</span>
                          <code className="truncate text-[10px] text-muted-foreground">
                            {operation.target_path}
                          </code>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="border border-border/60 p-8 text-center text-sm text-muted-foreground">
                  Create a Skill Set to configure a project.
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {activeReceipts.length > 0 ? (
        <section aria-labelledby="active-installs-heading">
          <h2
            id="active-installs-heading"
            className="mb-2 text-xs font-medium uppercase text-muted-foreground"
          >
            Active installs
          </h2>
          <div className="border border-border/60">
            {activeReceipts.map((receipt) => (
              <div
                key={receipt.receipt_id}
                className="flex flex-col gap-3 border-b border-border/50 px-3 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{receipt.set_name}</p>
                    {receipt.status === "applying" ? (
                      <Badge variant="outline" className="border-amber-400/30 text-amber-400">
                        Incomplete apply
                      </Badge>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{receipt.project_root}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rollbackSet.isPending}
                  onClick={() =>
                    rollbackSet.mutate(
                      { receipt_id: receipt.receipt_id },
                      {
                        onSuccess: () => toast.success(`Rolled back ${receipt.set_name}`),
                        onError: (error) =>
                          toast.error("Rollback blocked", {
                            description: error instanceof Error ? error.message : String(error),
                          }),
                      },
                    )
                  }
                >
                  <ArchiveRestoreIcon /> Roll back
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </PageScaffold>
  );
}
