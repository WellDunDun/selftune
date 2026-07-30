"use client";

import { useEffect, useMemo, useState } from "react";
import { FolderIcon, FolderOpenIcon } from "lucide-react";
import { HarnessLabel } from "@selftune/ui/components";

import type { DashboardProjectsActions } from "../../host";
import type {
  ProjectCaptureCandidateModel,
  ProjectConnectionId,
  ProjectHarnessModel,
  ProjectProvisionInput,
  ProjectProvisionPlanModel,
  ProjectProvisionResultModel,
  ProjectReceiptModel,
  ProjectSkillSetModel,
} from "../../models";
import { CONNECTION_LABELS } from "./skill-set-constants";
import {
  Accordion,
  AccordionContent,
  AccordionHeader,
  AccordionItem,
  AccordionTrigger,
  AnimatePresence,
  Button,
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  motion,
  useReducedMotion,
} from "@selftune/ui/primitives";

type ProjectProvisionActions = NonNullable<DashboardProjectsActions["provision"]>;
type HarnessChoice = Pick<ProjectHarnessModel, "id" | "name"> & {
  icon?: ProjectHarnessModel["icon"] | null;
};

export function ProjectSetupDialog({
  open,
  onOpenChange,
  provision,
  captureCandidates,
  skillSetIds,
  skillSets,
  receipts,
  connectedHarnesses,
  onCompleted,
  toErrorMessage,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  provision: ProjectProvisionActions;
  captureCandidates: ProjectCaptureCandidateModel[];
  skillSetIds: string[];
  skillSets: ProjectSkillSetModel[];
  receipts: ProjectReceiptModel[];
  connectedHarnesses: ProjectHarnessModel[];
  onCompleted(result: ProjectProvisionResultModel): void | Promise<void>;
  toErrorMessage(cause: unknown): string;
}) {
  const shouldReduceMotion = useReducedMotion();
  const [projectRoot, setProjectRoot] = useState("");
  const [step, setStep] = useState<"project" | "skill_sets" | "review">("project");
  const [selectedSkillSetIds, setSelectedSkillSetIds] = useState<string[]>(skillSetIds);
  const [targetHarnesses, setTargetHarnesses] = useState<ProjectConnectionId[]>([]);
  const [plan, setPlan] = useState<ProjectProvisionPlanModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recentSkillSets = useMemo(() => {
    const ids = [...new Set(receipts.map((receipt) => receipt.skillSetId))];
    return ids
      .map((id) => skillSets.find((skillSet) => skillSet.id === id))
      .filter((skillSet): skillSet is ProjectSkillSetModel => skillSet !== undefined)
      .slice(0, 6);
  }, [receipts, skillSets]);
  const selectedSkillSets = skillSets.filter((skillSet) =>
    selectedSkillSetIds.includes(skillSet.id),
  );
  const defaultHarnesses = connectedHarnesses.map((harness) => harness.id);
  const harnessChoices: HarnessChoice[] = [
    ...connectedHarnesses,
    ...targetHarnesses
      .filter((id) => !connectedHarnesses.some((harness) => harness.id === id))
      .map((id) => ({ id, name: CONNECTION_LABELS[id], icon: null })),
  ];

  useEffect(() => {
    if (!open) return;
    setStep("project");
    setSelectedSkillSetIds(skillSetIds);
    setPlan(null);
    setError(null);
  }, [open, skillSetIds]);

  function close() {
    setPlan(null);
    setError(null);
    onOpenChange(false);
  }

  function toggleSkillSet(skillSetId: string) {
    setSelectedSkillSetIds((ids) =>
      ids.includes(skillSetId) ? ids.filter((id) => id !== skillSetId) : [...ids, skillSetId],
    );
    setPlan(null);
    setError(null);
  }

  function selectProject(projectRoot: string, harnesses = defaultHarnesses) {
    setProjectRoot(projectRoot);
    setTargetHarnesses(harnesses);
    setPlan(null);
    setError(null);
    setStep("skill_sets");
  }

  function chooseProjectFolder() {
    if (!provision.chooseFolder) return;
    void provision.chooseFolder().then(
      (folder) => {
        if (folder) selectProject(folder);
      },
      (cause) => setError(toErrorMessage(cause)),
    );
  }

  function input(): ProjectProvisionInput {
    return {
      projectRoot,
      skillSetIds: selectedSkillSetIds,
      harnesses: targetHarnesses,
      createReactProject: false,
    };
  }

  function preview() {
    if (provision.preview.access !== "available") return;
    void provision.preview.execute(input()).then(
      (nextPlan) => {
        setPlan(nextPlan);
        setStep("review");
      },
      (cause) => setError(toErrorMessage(cause)),
    );
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : close())}>
      <DialogContent className="h-[min(680px,calc(100dvh-2rem))] grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-6 overflow-hidden p-7 sm:max-w-xl sm:p-8">
        <DialogHeader>
          <DialogTitle>Set up a project</DialogTitle>
          <DialogDescription>
            Choose a project, select Skill Sets, then review the change.
          </DialogDescription>
        </DialogHeader>
        <ol className="grid grid-cols-3 gap-2 text-xs" aria-label="Setup steps">
          {[
            ["project", "Project"],
            ["skill_sets", "Skill Sets"],
            ["review", "Review"],
          ].map(([id, label], index) => (
            <li
              key={id}
              className={
                step === id
                  ? "font-medium text-foreground transition-colors duration-200"
                  : "text-muted-foreground transition-colors duration-200"
              }
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>
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
              {step === "project" ? (
                <>
                  <section className="grid gap-3" aria-label="Project actions">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-24 flex-col items-start justify-start border-border/70 bg-card p-4 text-left font-normal transition-[transform,border-color,background-color] hover:-translate-y-px hover:border-foreground/30 hover:bg-accent/40 active:translate-y-0"
                      onClick={chooseProjectFolder}
                      disabled={!provision.chooseFolder}
                    >
                      <FolderOpenIcon className="mb-4 size-5 text-muted-foreground" />
                      <span className="text-sm font-medium">Open project</span>
                    </Button>
                  </section>
                  {captureCandidates.length > 0 ? (
                    <section className="py-1">
                      <div className="mb-2 flex items-center justify-between gap-4">
                        <h2 className="text-xs font-medium text-muted-foreground">
                          Recent projects
                        </h2>
                        <span className="text-xs text-muted-foreground">
                          {captureCandidates.length} detected
                        </span>
                      </div>
                      <div className="flex flex-col gap-1">
                        {captureCandidates.slice(0, 6).map((candidate) => {
                          const selected = projectRoot === candidate.projectRoot;
                          return (
                            <button
                              key={candidate.projectRoot}
                              type="button"
                              className="flex w-full items-center justify-between gap-4 rounded-sm py-2 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-pressed={selected}
                              onClick={() =>
                                selectProject(candidate.projectRoot, candidate.connections)
                              }
                            >
                              <span className={selected ? "text-sm font-medium" : "text-sm"}>
                                {candidate.name}
                              </span>
                              <span
                                className="max-w-[55%] truncate text-xs text-muted-foreground"
                                title={candidate.projectRoot}
                              >
                                {candidate.projectRoot}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ) : null}
                  {projectRoot ? (
                    <p className="truncate text-xs text-muted-foreground" title={projectRoot}>
                      Selected: {projectRoot}
                    </p>
                  ) : null}
                </>
              ) : null}

              {step === "skill_sets" ? (
                <>
                  {recentSkillSets.length > 0 ? (
                    <SkillSetList
                      title="Recently installed"
                      skillSets={recentSkillSets}
                      selectedIds={selectedSkillSetIds}
                      onToggle={toggleSkillSet}
                    />
                  ) : null}
                  <SkillSetPicker
                    skillSets={skillSets}
                    selectedIds={selectedSkillSetIds}
                    onValueChange={(selected) => {
                      setSelectedSkillSetIds(selected.map((skillSet) => skillSet.id));
                      setPlan(null);
                      setError(null);
                    }}
                  />
                  <HarnessPicker
                    harnesses={harnessChoices}
                    selectedIds={targetHarnesses}
                    onValueChange={(selected) => {
                      setTargetHarnesses(selected.map((harness) => harness.id));
                      setPlan(null);
                      setError(null);
                    }}
                  />
                </>
              ) : null}

              {step === "review" && plan ? (
                <>
                  <section className="flex flex-col gap-3">
                    <div className="flex min-w-0 items-center gap-2 text-sm">
                      <FolderIcon
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <p className="truncate" title={projectRoot}>
                        {projectRoot}
                      </p>
                    </div>
                    <Accordion
                      multiple
                      defaultValue={selectedSkillSets.map((skillSet) => skillSet.id)}
                    >
                      {selectedSkillSets.map((skillSet) => (
                        <AccordionItem key={skillSet.id} value={skillSet.id}>
                          <AccordionHeader>
                            <AccordionTrigger>{skillSet.name}</AccordionTrigger>
                          </AccordionHeader>
                          <AccordionContent>
                            <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                              <ul className="flex flex-wrap gap-x-3 gap-y-1">
                                {skillSet.skills.map((skill) => (
                                  <li key={`${skill.packagePath}:${skill.contentHash}`}>
                                    {skill.name}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      ))}
                    </Accordion>
                  </section>
                  <p className="text-sm text-muted-foreground">
                    {plan.creates} create · {plan.unchanged} unchanged · {plan.conflicts} conflicts
                    · {plan.missingDependencies} downloads
                  </p>
                </>
              ) : null}
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </motion.div>
          </AnimatePresence>
        </div>
        {step !== "project" ? (
          <DialogFooter className="mx-0 mb-0 rounded-none border-0 bg-transparent p-0">
            {step === "skill_sets" ? (
              <>
                <Button variant="outline" onClick={() => setStep("project")}>
                  Back
                </Button>
                <Button
                  disabled={selectedSkillSetIds.length === 0 || targetHarnesses.length === 0}
                  onClick={preview}
                >
                  Review changes
                </Button>
              </>
            ) : null}
            {step === "review" ? (
              <>
                <Button variant="outline" onClick={() => setStep("skill_sets")}>
                  Back
                </Button>
                <Button
                  disabled={!plan || plan.conflicts > 0}
                  onClick={() => {
                    if (provision.execute.access !== "available") return;
                    void provision.execute.execute(input()).then(
                      async (result) => {
                        await onCompleted(result);
                        close();
                      },
                      (cause) => setError(toErrorMessage(cause)),
                    );
                  }}
                >
                  Install Skill Sets
                </Button>
              </>
            ) : null}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SkillSetList({
  title,
  skillSets,
  selectedIds,
  onToggle,
}: {
  title: string;
  skillSets: ProjectSkillSetModel[];
  selectedIds: string[];
  onToggle(skillSetId: string): void;
}) {
  return (
    <section className="py-1">
      <h2 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h2>
      <div className="flex flex-col gap-1">
        {skillSets.map((skillSet) => {
          const selected = selectedIds.includes(skillSet.id);
          return (
            <button
              key={skillSet.id}
              type="button"
              className="flex w-full items-center justify-between gap-4 rounded-sm py-2 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-pressed={selected}
              onClick={() => onToggle(skillSet.id)}
            >
              <span className={selected ? "text-sm font-medium" : "text-sm"}>{skillSet.name}</span>
              <span className="text-xs text-muted-foreground">
                {selected ? "Selected" : `${skillSet.skills.length} skills`}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function SkillSetPicker({
  skillSets,
  selectedIds,
  onValueChange,
}: {
  skillSets: ProjectSkillSetModel[];
  selectedIds: string[];
  onValueChange(selected: ProjectSkillSetModel[]): void;
}) {
  const selectedSkillSets = skillSets.filter((skillSet) => selectedIds.includes(skillSet.id));
  return (
    <section className="flex flex-col gap-2 py-1">
      <h2 className="text-xs font-medium text-muted-foreground">Add Skill Sets</h2>
      <Combobox
        items={skillSets}
        multiple
        value={selectedSkillSets}
        onValueChange={onValueChange}
        itemToStringValue={(skillSet) => `${skillSet.name} ${skillSet.description}`}
      >
        <ComboboxChips aria-label="Skill Sets">
          <ComboboxValue>
            {selectedSkillSets.map((skillSet) => (
              <ComboboxChip key={skillSet.id}>{skillSet.name}</ComboboxChip>
            ))}
          </ComboboxValue>
          <ComboboxChipsInput placeholder="Search and add Skill Sets…" />
        </ComboboxChips>
        <ComboboxContent>
          <ComboboxEmpty>No matching Skill Sets.</ComboboxEmpty>
          <ComboboxList>
            {(skillSet) => (
              <ComboboxItem key={skillSet.id} value={skillSet}>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{skillSet.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {skillSet.description}
                  </span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </section>
  );
}

function HarnessPicker({
  harnesses,
  selectedIds,
  onValueChange,
}: {
  harnesses: HarnessChoice[];
  selectedIds: ProjectConnectionId[];
  onValueChange(selected: HarnessChoice[]): void;
}) {
  const selectedHarnesses = harnesses.filter((harness) => selectedIds.includes(harness.id));
  return (
    <section className="flex flex-col gap-2 py-1">
      <h2 className="text-xs font-medium text-muted-foreground">Target harnesses</h2>
      <Combobox
        items={harnesses}
        multiple
        value={selectedHarnesses}
        onValueChange={onValueChange}
        itemToStringValue={(harness) => harness.name}
      >
        <ComboboxChips aria-label="Target harnesses">
          <ComboboxValue>
            {selectedHarnesses.map((harness) => (
              <ComboboxChip key={harness.id}>
                <HarnessLabel {...harness} variant="inline" />
              </ComboboxChip>
            ))}
          </ComboboxValue>
          <ComboboxChipsInput placeholder="Search and add harnesses…" />
        </ComboboxChips>
        <ComboboxContent>
          <ComboboxEmpty>No matching harnesses.</ComboboxEmpty>
          <ComboboxList>
            {(harness) => (
              <ComboboxItem key={harness.id} value={harness}>
                <HarnessLabel {...harness} variant="inline" />
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </section>
  );
}
