"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  ProjectConnectionId,
  ProjectSkillOptionModel,
  ProjectSkillSetInputSkill,
} from "../../models";
import { CONNECTION_LABELS, CONNECTIONS } from "./skill-set-constants";
import { ProjectCaptureCandidates } from "./ProjectCaptureCandidates";
import type { SkillSetEditorProps } from "./SkillSetEditor.types";
import { SkillSetSkillPicker } from "./SkillSetSkillPicker";
import { SkillSetSetupDialog } from "./SkillSetSetupDialog";
import {
  AnimatePresence,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
  motion,
  useReducedMotion,
} from "@selftune/ui/primitives";
import { FolderInputIcon, Layers3Icon } from "lucide-react";

export type { SkillSetEditorProps } from "./SkillSetEditor.types";
export { SkillSetSkillPicker } from "./SkillSetSkillPicker";

function draftSkillPath(skill: ProjectSkillSetInputSkill): string {
  return skill.provenance === "catalog" ? `catalog:${skill.catalogId}` : skill.packagePath;
}

export function SkillSetEditor(props: SkillSetEditorProps) {
  return props.mode === "edit" ? (
    <SkillSetEditDialog {...props} />
  ) : (
    <SkillSetSetupDialog {...props} />
  );
}

function SkillSetEditDialog({
  mode,
  open,
  availableSkills,
  initialValue,
  draftValue,
  captureCandidates,
  canCreate,
  canCapture,
  isPending,
  onOpenChange,
  onModeChange,
  onSubmit,
}: SkillSetEditorProps) {
  const catalogDraftSkills = useMemo(
    () => draftValue?.skills.filter((skill) => skill.provenance === "catalog") ?? [],
    [draftValue],
  );
  const selectableSkills = useMemo<ProjectSkillOptionModel[]>(
    () => [
      ...availableSkills,
      ...catalogDraftSkills.map((skill) => ({
        id: `catalog:${skill.catalogId}`,
        name: skill.name,
        packagePath: `catalog:${skill.catalogId}`,
        contentHash: skill.installSpec,
        lifecycle: "Catalog",
      })),
    ],
    [availableSkills, catalogDraftSkills],
  );
  const [name, setName] = useState(initialValue?.name ?? draftValue?.name ?? "");
  const [description, setDescription] = useState(
    initialValue?.description ?? draftValue?.description ?? "",
  );
  const [connections, setConnections] = useState<ProjectConnectionId[]>(
    initialValue?.connections ?? draftValue?.connections ?? ["codex"],
  );
  const [selectedPaths, setSelectedPaths] = useState(
    initialValue?.skills.map((skill) => skill.packagePath) ??
      draftValue?.skills.map(draftSkillPath) ??
      [],
  );
  const [projectRoot, setProjectRoot] = useState("");
  const [wizardStep, setWizardStep] = useState<"details" | "review">("details");
  const wasOpen = useRef(false);
  const shouldReduceMotion = useReducedMotion();

  useEffect(() => {
    const isNewEditorSession = open && !wasOpen.current;
    wasOpen.current = open;
    if (!isNewEditorSession) return;
    setName(initialValue?.name ?? draftValue?.name ?? "");
    setDescription(initialValue?.description ?? draftValue?.description ?? "");
    setConnections(initialValue?.connections ?? draftValue?.connections ?? ["codex"]);
    setSelectedPaths(
      (initialValue?.skills ?? draftValue?.skills)?.flatMap((pinned) => {
        const pinnedPath = "contentHash" in pinned ? pinned.packagePath : draftSkillPath(pinned);
        const available = selectableSkills.find(
          (skill) =>
            skill.packagePath === pinnedPath ||
            ("contentHash" in pinned &&
              skill.name === pinned.name &&
              skill.contentHash === pinned.contentHash),
        );
        return available ? [available.packagePath] : [];
      }) ?? [],
    );
    setProjectRoot("");
    setWizardStep("details");
  }, [draftValue, initialValue, open, selectableSkills]);

  const title =
    mode === "edit"
      ? "Edit Skill Set"
      : mode === "derive"
        ? "Create from Project"
        : draftValue
          ? "Review Suggested Skill Set"
          : "New Skill Set";
  const valid =
    name.trim().length > 0 &&
    connections.length > 0 &&
    (mode === "derive" ? projectRoot.trim().length > 0 : selectedPaths.length > 0);
  const isCreationWizard = mode !== "edit";
  const selectedSkills = selectedPaths.flatMap((packagePath) => {
    const skill = selectableSkills.find(
      (candidate) =>
        candidate.packagePath === packagePath ||
        candidate.revisionChoices?.some((choice) => choice.packagePath === packagePath),
    );
    return skill ? [{ skill, packagePath }] : [];
  });

  function submit() {
    if (!valid) return;
    if (mode === "derive") {
      onSubmit({ name, description, connections, projectRoot });
      return;
    }
    onSubmit({
      name,
      description,
      connections,
      skills: selectedSkills.map(({ skill, packagePath }): ProjectSkillSetInputSkill => {
        const catalogSkill = catalogDraftSkills.find(
          (candidate) => `catalog:${candidate.catalogId}` === skill.packagePath,
        );
        return catalogSkill ?? { name: skill.name, packagePath };
      }),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          isCreationWizard
            ? "h-[min(680px,calc(100dvh-2rem))] grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-6 overflow-hidden p-7 sm:max-w-3xl sm:p-8"
            : "max-h-[min(760px,calc(100vh-2rem))] overflow-y-auto sm:max-w-3xl"
        }
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode === "derive"
              ? "Choose a detected project or enter another folder to create a reusable Skill Set."
              : draftValue
                ? "Review the evidence-backed draft, make any changes, and save it as a Skill Set."
                : "Choose connections and searchable Library skills for this reusable Skill Set."}
          </DialogDescription>
        </DialogHeader>
        {isCreationWizard ? (
          <ol className="grid grid-cols-2 gap-2 text-xs" aria-label="Create Skill Set steps">
            {[
              ["details", "Details & skills"],
              ["review", "Review"],
            ].map(([id, label], index) => (
              <li
                key={id}
                className={
                  wizardStep === id
                    ? "font-medium text-foreground transition-colors duration-200"
                    : "text-muted-foreground transition-colors duration-200"
                }
              >
                {index + 1}. {label}
              </li>
            ))}
          </ol>
        ) : null}
        <form
          className={isCreationWizard ? "contents" : "flex flex-col gap-5"}
          onSubmit={(event) => {
            event.preventDefault();
            if (isCreationWizard && wizardStep === "details") {
              if (valid) setWizardStep("review");
              return;
            }
            submit();
          }}
        >
          <div className={isCreationWizard ? "min-h-0 overflow-y-auto pr-1" : undefined}>
            <AnimatePresence initial={false} mode="wait">
              <motion.div
                key={isCreationWizard ? wizardStep : "edit"}
                initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: -4 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.2, ease: "easeOut" }}
                className="flex flex-col gap-5"
              >
                {!isCreationWizard || wizardStep === "details" ? (
                  <>
                    {isCreationWizard && canCreate && canCapture ? (
                      <ToggleGroup
                        value={[mode]}
                        onValueChange={(value) => {
                          const nextMode = value[0];
                          if (nextMode === "create" || nextMode === "derive") {
                            onModeChange(nextMode);
                            setWizardStep("details");
                          }
                        }}
                        aria-label="Skill Set creation method"
                        className="w-full"
                      >
                        <ToggleGroupItem value="create" className="flex-1">
                          <Layers3Icon /> From Library
                        </ToggleGroupItem>
                        <ToggleGroupItem value="derive" className="flex-1">
                          <FolderInputIcon /> From Project
                        </ToggleGroupItem>
                      </ToggleGroup>
                    ) : null}
                    <div className={mode === "derive" ? "grid gap-5" : "grid gap-5 md:grid-cols-2"}>
                      <div className="flex flex-col gap-4">
                        <label className="flex flex-col gap-1.5 text-xs font-medium">
                          Name
                          <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Software Development"
                          />
                        </label>
                        <label className="flex flex-col gap-1.5 text-xs font-medium">
                          Description
                          <Textarea
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            placeholder="Optional"
                          />
                        </label>
                        <fieldset className="flex flex-col gap-2">
                          <legend className="text-xs font-medium">Connections</legend>
                          <div className="grid grid-cols-2 gap-2">
                            {CONNECTIONS.map(([value, label]) => (
                              <label
                                key={value}
                                className="flex items-center gap-2 text-sm font-normal"
                              >
                                <Checkbox
                                  checked={connections.includes(value)}
                                  onCheckedChange={() =>
                                    setConnections((current) =>
                                      current.includes(value)
                                        ? current.filter((connection) => connection !== value)
                                        : [...current, value],
                                    )
                                  }
                                />
                                {label}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        {mode === "derive" ? (
                          <>
                            <ProjectCaptureCandidates
                              candidates={captureCandidates}
                              selectedProjectRoot={projectRoot}
                              onSelect={(candidate) => {
                                setProjectRoot(candidate.projectRoot);
                                setName(candidate.name);
                                setConnections(candidate.connections);
                              }}
                            />
                            <label className="flex flex-col gap-1.5 text-xs font-medium">
                              Another project folder
                              <Input
                                value={projectRoot}
                                onChange={(event) => setProjectRoot(event.target.value)}
                                placeholder="/Users/you/Projects/example"
                              />
                            </label>
                          </>
                        ) : null}
                      </div>

                      {mode !== "derive" ? (
                        <fieldset className="flex min-w-0 flex-col gap-3">
                          <legend className="text-xs font-medium">Library skills</legend>
                          <SkillSetSkillPicker
                            skills={selectableSkills}
                            selectedPaths={selectedPaths}
                            onValueChange={setSelectedPaths}
                          />
                          <p className="text-xs text-muted-foreground">
                            {selectedPaths.length} selected
                          </p>
                        </fieldset>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <section className="flex flex-col gap-5">
                    <div className="flex flex-col gap-1">
                      <h2 className="text-base font-medium">{name}</h2>
                      {description ? (
                        <p className="text-sm text-muted-foreground">{description}</p>
                      ) : null}
                    </div>
                    <dl className="grid gap-4 text-sm">
                      <div className="flex flex-col gap-1">
                        <dt className="text-xs font-medium text-muted-foreground">Harnesses</dt>
                        <dd>
                          {connections
                            .map((connection) => CONNECTION_LABELS[connection])
                            .join(", ")}
                        </dd>
                      </div>
                      {mode === "derive" ? (
                        <div className="flex flex-col gap-1">
                          <dt className="text-xs font-medium text-muted-foreground">Project</dt>
                          <dd className="truncate" title={projectRoot}>
                            {projectRoot}
                          </dd>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <dt className="text-xs font-medium text-muted-foreground">Skills</dt>
                          <dd>
                            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                              {selectedSkills.map(({ skill, packagePath }) => (
                                <li key={packagePath}>{skill.name}</li>
                              ))}
                            </ul>
                          </dd>
                        </div>
                      )}
                    </dl>
                  </section>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
          {isCreationWizard ? (
            <DialogFooter className="mx-0 mb-0 rounded-none border-0 bg-transparent p-0">
              {wizardStep === "details" ? (
                <Button type="submit" disabled={!valid}>
                  Review Skill Set
                </Button>
              ) : (
                <>
                  <Button type="button" variant="outline" onClick={() => setWizardStep("details")}>
                    Back
                  </Button>
                  <Button type="submit" disabled={isPending}>
                    {isPending ? "Creating…" : "Create Skill Set"}
                  </Button>
                </>
              )}
            </DialogFooter>
          ) : (
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!valid || isPending}>
                {isPending ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
