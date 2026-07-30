"use client";

import type { ProjectSkillOptionModel } from "../../models";
import { CONNECTION_LABELS } from "./skill-set-constants";
import { timeAgo } from "@selftune/ui/lib";
import {
  Badge,
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@selftune/ui/primitives";

type ProjectSkillRevisionChoice = NonNullable<ProjectSkillOptionModel["revisionChoices"]>[number];

function finalPathSegment(path: string): string | null {
  return path.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? null;
}

function revisionChoiceScope(choice: ProjectSkillRevisionChoice): string {
  if (choice.sourceKind === "remote") return "Cloud";
  if (choice.sourceKind === "cached") return "Cached";
  if (choice.sourceKind === "draft") return "Draft";
  if (choice.sourceKind === "archived") return "Archived";
  if (choice.scope === "project") return finalPathSegment(choice.projectRoot ?? "") ?? "Project";
  if (choice.scope === "global") return "Global";
  if (choice.scope === "library") return "Library";
  if (choice.scope === "admin") return "Admin";
  if (choice.scope === "system") return "System";
  return "Local";
}

function revisionChoiceTitle(choice: ProjectSkillRevisionChoice): string {
  const connection = choice.connection ? CONNECTION_LABELS[choice.connection] : null;
  return [revisionChoiceScope(choice), connection].filter(Boolean).join(" · ");
}

function revisionChoiceActivity(choice: ProjectSkillRevisionChoice): string {
  return choice.lastUsedAt
    ? `Used ${timeAgo(choice.lastUsedAt)}`
    : `Updated ${timeAgo(choice.modifiedAt)}`;
}

export function SkillSetSkillPicker({
  skills,
  selectedPaths,
  onValueChange,
}: {
  skills: ProjectSkillOptionModel[];
  selectedPaths: string[];
  onValueChange(packagePaths: string[]): void;
}) {
  const selectedPathFor = (skill: ProjectSkillOptionModel) =>
    selectedPaths.find(
      (path) =>
        path === skill.packagePath ||
        skill.revisionChoices?.some((choice) => choice.packagePath === path),
    );
  const selectedSkills = skills.filter((skill) => selectedPathFor(skill) !== undefined);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Combobox
        items={skills}
        multiple
        value={selectedSkills}
        onValueChange={(selected) =>
          onValueChange(selected.map((skill) => selectedPathFor(skill) ?? skill.packagePath))
        }
        itemToStringValue={(skill) => `${skill.name} ${skill.packagePath} ${skill.contentHash}`}
      >
        <ComboboxChips aria-label="Library skills">
          <ComboboxValue>
            {selectedSkills.map((skill) => (
              <ComboboxChip key={skill.id}>{skill.name}</ComboboxChip>
            ))}
          </ComboboxValue>
          <ComboboxChipsInput placeholder="Search and add skills…" />
        </ComboboxChips>
        <ComboboxContent>
          <ComboboxEmpty>No matching skills.</ComboboxEmpty>
          <ComboboxList>
            {(skill) => (
              <ComboboxItem key={skill.id} value={skill}>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{skill.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {skill.revisionChoices && skill.revisionChoices.length > 1
                      ? `${skill.revisionChoices.length} installed versions`
                      : `${skill.contentHash.slice(0, 10)} · ${skill.packagePath}`}
                  </span>
                </span>
                <Badge variant="outline">{skill.lifecycle}</Badge>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {selectedSkills.flatMap((skill) => {
        const choices = skill.revisionChoices ?? [];
        const selectedPath = selectedPathFor(skill);
        const selectedChoice = choices.find((choice) => choice.packagePath === selectedPath);
        return choices.length > 1 && selectedPath
          ? [
              <div key={skill.id} className="flex min-w-0 flex-col gap-1.5 text-xs font-medium">
                <span>{skill.name} copy</span>
                <Select
                  value={selectedPath}
                  onValueChange={(nextPath) => {
                    if (!nextPath) return;
                    onValueChange(
                      selectedPaths.map((path) => (path === selectedPath ? nextPath : path)),
                    );
                  }}
                >
                  <SelectTrigger className="w-full" aria-label={`${skill.name} copy`}>
                    <SelectValue>
                      {selectedChoice ? revisionChoiceTitle(selectedChoice) : "Choose copy"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} className="min-w-80">
                    <SelectGroup>
                      {choices.map((choice, index) => (
                        <SelectItem key={choice.contentHash} value={choice.packagePath}>
                          <div className="flex min-w-0 flex-1 flex-col gap-1 py-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{revisionChoiceTitle(choice)}</span>
                              {index === 0 ? <Badge variant="secondary">Recommended</Badge> : null}
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {revisionChoiceActivity(choice)}
                              {choice.originLabel ? ` · ${choice.originLabel}` : ""}
                            </span>
                            <span className="truncate font-mono text-[10px] text-muted-foreground">
                              {choice.packagePath} · {choice.contentHash.slice(0, 10)}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {selectedChoice ? (
                  <span className="truncate font-normal text-muted-foreground">
                    {revisionChoiceActivity(selectedChoice)} · {selectedChoice.packagePath}
                  </span>
                ) : null}
              </div>,
            ]
          : [];
      })}
    </div>
  );
}
