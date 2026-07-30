"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FolderInputIcon, Layers3Icon } from "lucide-react";

import type {
  ProjectConnectionId,
  ProjectHarnessModel,
  ProjectSkillOptionModel,
  ProjectSkillSetDeriveInput,
  ProjectSkillSetInput,
  ProjectSkillSetInputSkill,
} from "../../models";
import { ProjectCaptureCandidates } from "./ProjectCaptureCandidates";
import type { SkillSetEditorProps } from "./SkillSetEditor.types";
import { SkillSetSkillPicker } from "./SkillSetSkillPicker";
import { CONNECTION_LABELS, CONNECTIONS } from "./skill-set-constants";
import { HarnessLabel } from "@selftune/ui/components";
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
  motion,
  Textarea,
  useReducedMotion,
} from "@selftune/ui/primitives";

function draftSkillPath(skill: ProjectSkillSetInputSkill): string {
  return skill.provenance === "catalog" ? `catalog:${skill.catalogId}` : skill.packagePath;
}

export function SkillSetSetupDialog({
  mode,
  open,
  availableSkills,
  draftValue,
  captureCandidates,
  connectedHarnesses = [],
  canCreate,
  canCapture,
  isPending,
  onOpenChange,
  onModeChange,
  onSubmit,
}: SkillSetEditorProps) {
  const defaultConnections = useMemo(
    () => connectedHarnesses.map((harness) => harness.id),
    [connectedHarnesses],
  );
  const initialConnections = useMemo(
    () => Array.from(new Set([...defaultConnections, ...(draftValue?.connections ?? [])])),
    [defaultConnections, draftValue],
  );
  const shouldReduceMotion = useReducedMotion();
  const [step, setStep] = useState<"method" | "details" | "review">("method");
  const [name, setName] = useState(draftValue?.name ?? "");
  const [description, setDescription] = useState(draftValue?.description ?? "");
  const [connections, setConnections] = useState<ProjectConnectionId[]>(initialConnections);
  const [selectedPaths, setSelectedPaths] = useState(draftValue?.skills.map(draftSkillPath) ?? []);
  const [projectRoot, setProjectRoot] = useState("");
  const wasOpen = useRef(false);
  const catalogDraftSkills = useMemo(
    () => draftValue?.skills.filter((skill) => skill.provenance === "catalog") ?? [],
    [draftValue],
  );
  const installedDraftSkills = useMemo(
    () => draftValue?.skills.filter((skill) => skill.provenance !== "catalog") ?? [],
    [draftValue],
  );
  const selectableSkills = useMemo<ProjectSkillOptionModel[]>(() => {
    const knownPaths = new Set(
      availableSkills.flatMap((skill) => [
        skill.packagePath,
        ...(skill.revisionChoices?.map((choice) => choice.packagePath) ?? []),
      ]),
    );
    return [
      ...availableSkills,
      ...catalogDraftSkills.map((skill) => ({
        id: `catalog:${skill.catalogId}`,
        name: skill.name,
        packagePath: `catalog:${skill.catalogId}`,
        contentHash: skill.installSpec,
        lifecycle: "Catalog",
      })),
      ...installedDraftSkills
        .filter((skill) => !knownPaths.has(skill.packagePath))
        .map((skill) => ({
          id: `suggested:${skill.packagePath}`,
          name: skill.name,
          packagePath: skill.packagePath,
          contentHash: skill.packagePath,
          lifecycle: "Suggested",
        })),
    ];
  }, [availableSkills, catalogDraftSkills, installedDraftSkills]);

  useEffect(() => {
    const isNewSession = open && !wasOpen.current;
    wasOpen.current = open;
    if (!isNewSession) return;
    setName(draftValue?.name ?? "");
    setDescription(draftValue?.description ?? "");
    setConnections(initialConnections);
    setSelectedPaths(draftValue?.skills.map(draftSkillPath) ?? []);
    setProjectRoot("");
    setStep(draftValue ? "review" : canCreate && canCapture ? "method" : "details");
  }, [canCapture, canCreate, draftValue, initialConnections, open]);
  const harnessChoices: Array<
    Pick<ProjectHarnessModel, "id" | "name"> & { icon?: ProjectHarnessModel["icon"] | null }
  > = [
    ...(connectedHarnesses.length > 0
      ? connectedHarnesses
      : CONNECTIONS.map(([id, connectionName]) => ({ id, name: connectionName, icon: null }))),
    ...connections
      .filter((id) => !connectedHarnesses.some((harness) => harness.id === id))
      .filter(() => connectedHarnesses.length > 0)
      .map((id) => ({ id, name: CONNECTION_LABELS[id], icon: null })),
  ];

  const selectedSkills = selectedPaths.flatMap((packagePath) => {
    const skill = selectableSkills.find(
      (candidate) =>
        candidate.packagePath === packagePath ||
        candidate.revisionChoices?.some((choice) => choice.packagePath === packagePath),
    );
    return skill ? [{ skill, packagePath }] : [];
  });
  const valid =
    name.trim().length > 0 &&
    connections.length > 0 &&
    (mode === "derive" ? projectRoot.trim().length > 0 : selectedPaths.length > 0);
  const title =
    step === "method"
      ? "New Skill Set"
      : mode === "derive"
        ? "Create from Project"
        : draftValue
          ? "Review Suggested Skill Set"
          : "New Skill Set";

  function submit() {
    if (!valid) return;
    if (mode === "derive") {
      onSubmit({
        name,
        description,
        connections,
        projectRoot,
      } satisfies ProjectSkillSetDeriveInput);
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
    } satisfies ProjectSkillSetInput);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(680px,calc(100dvh-2rem))] grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-6 overflow-hidden p-7 sm:max-w-3xl sm:p-8">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {step === "method"
              ? "Choose how you want to create the Skill Set."
              : "Choose the Skill Set details, then review it before creating it."}
          </DialogDescription>
        </DialogHeader>
        <ol className="grid grid-cols-3 gap-2 text-xs" aria-label="Create Skill Set steps">
          {["Creation method", "Details & skills", "Review"].map((label, index) => (
            <li
              key={label}
              className={
                (step === "method" ? index === 0 : step === "details" ? index === 1 : index === 2)
                  ? "font-medium text-foreground transition-colors duration-200"
                  : "text-muted-foreground transition-colors duration-200"
              }
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (step === "details") {
              if (valid) setStep("review");
              return;
            }
            submit();
          }}
        >
          <div className="min-h-0 overflow-y-auto pr-1">
            <AnimatePresence initial={false} mode="wait">
              <motion.div
                key={step}
                initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: -4 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.2, ease: "easeOut" }}
                className="flex flex-col gap-5"
              >
                {step === "method" ? (
                  <section className="grid gap-3 sm:grid-cols-2" aria-label="Creation method">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-32 flex-col items-start justify-start border-border/70 bg-card p-4 text-left font-normal transition-[transform,border-color,background-color] hover:-translate-y-px hover:border-foreground/30 hover:bg-accent/40 active:translate-y-0"
                      onClick={() => {
                        onModeChange("create");
                        setStep("details");
                      }}
                    >
                      <Layers3Icon className="mb-4 size-5 text-muted-foreground" />
                      <span className="text-sm font-medium">From Library</span>
                      <span className="mt-1 text-xs text-muted-foreground">
                        Choose skills from your Library.
                      </span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-32 flex-col items-start justify-start border-border/70 bg-card p-4 text-left font-normal transition-[transform,border-color,background-color] hover:-translate-y-px hover:border-foreground/30 hover:bg-accent/40 active:translate-y-0"
                      onClick={() => {
                        onModeChange("derive");
                        setStep("details");
                      }}
                    >
                      <FolderInputIcon className="mb-4 size-5 text-muted-foreground" />
                      <span className="text-sm font-medium">From Project</span>
                      <span className="mt-1 text-xs text-muted-foreground">
                        Build a Skill Set from a detected project.
                      </span>
                    </Button>
                  </section>
                ) : step === "details" ? (
                  <>
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
                            {harnessChoices.map((harness) => {
                              const connection = harness.id;
                              return (
                                <label
                                  key={connection}
                                  className="flex items-center gap-2 text-sm font-normal"
                                >
                                  <Checkbox
                                    checked={connections.includes(connection)}
                                    onCheckedChange={() =>
                                      setConnections((current) =>
                                        current.includes(connection)
                                          ? current.filter((item) => item !== connection)
                                          : [...current, connection],
                                      )
                                    }
                                  />
                                  <HarnessLabel {...harness} variant="inline" />
                                </label>
                              );
                            })}
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
                        <dd className="flex flex-wrap gap-2">
                          {connections.map((connection) => (
                            <HarnessLabel
                              key={connection}
                              {...(harnessChoices.find((harness) => harness.id === connection) ?? {
                                name: CONNECTION_LABELS[connection],
                                icon: null,
                              })}
                            />
                          ))}
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
          <DialogFooter className="mx-0 mb-0 rounded-none border-0 bg-transparent p-0">
            {step === "method" ? null : step === "details" ? (
              <Button type="submit" disabled={!valid}>
                Review Skill Set
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => setStep("details")}>
                  Back
                </Button>
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Creating…" : "Create Skill Set"}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
