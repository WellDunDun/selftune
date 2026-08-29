import { ArrowUpDownIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import type { LibrarySkillModel } from "../../models";
import { LIFECYCLE_LABELS } from "./SkillsLibraryFilters";
import { Button, TableHead } from "@selftune/ui/primitives";

export type SortColumn =
  | "skill"
  | "category"
  | "state"
  | "source"
  | "connections"
  | "triggers"
  | "lastUsed"
  | "updated";
export type SortDirection = "asc" | "desc";
export type SortState = { column: SortColumn; direction: SortDirection };
type NullableComparison = { comparison: number; hasNull: boolean };

const SORT_TEXT_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export function sourceLabel(skill: LibrarySkillModel): string {
  return skill.sources.map((source) => source.label).join(", ") || "Unknown source";
}
function compareNullable<T>(
  left: T | null,
  right: T | null,
  compare: (left: T, right: T) => number,
): NullableComparison {
  if (left === null && right === null) return { comparison: 0, hasNull: true };
  if (left === null) return { comparison: 1, hasNull: true };
  if (right === null) return { comparison: -1, hasNull: true };
  return { comparison: compare(left, right), hasNull: false };
}

function sortTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function sortSourceValue(skill: LibrarySkillModel): string | null {
  return skill.sources.length > 0 ? sourceLabel(skill) : null;
}

function sortConnectionsValue(skill: LibrarySkillModel): string | null {
  const connections = [
    ...new Set(
      skill.locations.flatMap((location) => (location.connection ? [location.connection] : [])),
    ),
  ].toSorted((left, right) => SORT_TEXT_COLLATOR.compare(left, right));
  return connections.length > 0 ? connections.join(", ") : null;
}

function sortTriggerValue(skill: LibrarySkillModel): number | null {
  return typeof skill.lifetimeTriggerCount === "number" &&
    Number.isFinite(skill.lifetimeTriggerCount)
    ? skill.lifetimeTriggerCount
    : null;
}

function compareSkillValues(
  left: LibrarySkillModel,
  right: LibrarySkillModel,
  column: SortColumn,
): NullableComparison {
  switch (column) {
    case "skill":
      return compareNullable(left.name, right.name, (a, b) => SORT_TEXT_COLLATOR.compare(a, b));
    case "category":
      return compareNullable(left.category?.label ?? null, right.category?.label ?? null, (a, b) =>
        SORT_TEXT_COLLATOR.compare(a, b),
      );
    case "state":
      return compareNullable(
        left.statusBadge?.label ?? LIFECYCLE_LABELS[left.lifecycle] ?? null,
        right.statusBadge?.label ?? LIFECYCLE_LABELS[right.lifecycle] ?? null,
        (a, b) => SORT_TEXT_COLLATOR.compare(a, b),
      );
    case "source":
      return compareNullable(sortSourceValue(left), sortSourceValue(right), (a, b) =>
        SORT_TEXT_COLLATOR.compare(a, b),
      );
    case "connections":
      return compareNullable(sortConnectionsValue(left), sortConnectionsValue(right), (a, b) =>
        SORT_TEXT_COLLATOR.compare(a, b),
      );
    case "triggers":
      return compareNullable(sortTriggerValue(left), sortTriggerValue(right), (a, b) => a - b);
    case "lastUsed":
      return compareNullable(
        sortTimestamp(left.lastUsedAt),
        sortTimestamp(right.lastUsedAt),
        (a, b) => a - b,
      );
    case "updated":
      return compareNullable(
        sortTimestamp(left.modifiedAt),
        sortTimestamp(right.modifiedAt),
        (a, b) => a - b,
      );
  }
}

export function sortSkills(
  skills: readonly LibrarySkillModel[],
  sort: SortState,
): LibrarySkillModel[] {
  return skills
    .map((skill, index) => ({ skill, index }))
    .toSorted((left, right) => {
      const primary = compareSkillValues(left.skill, right.skill, sort.column);
      if (primary.comparison !== 0) {
        if (primary.hasNull) return primary.comparison;
        return sort.direction === "asc" ? primary.comparison : -primary.comparison;
      }

      const nameComparison = SORT_TEXT_COLLATOR.compare(left.skill.name, right.skill.name);
      if (nameComparison !== 0) return nameComparison;

      const idComparison = SORT_TEXT_COLLATOR.compare(left.skill.id, right.skill.id);
      return idComparison !== 0 ? idComparison : left.index - right.index;
    })
    .map(({ skill }) => skill);
}

export function SortableTableHead({
  column,
  label,
  sort,
  onSort,
  className,
}: {
  column: SortColumn;
  label: string;
  sort: SortState | null;
  onSort(column: SortColumn): void;
  className?: string;
}) {
  const direction = sort?.column === column ? sort.direction : null;
  const ariaSort: "none" | "ascending" | "descending" =
    direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none";
  const SortIcon =
    direction === "asc" ? ChevronUpIcon : direction === "desc" ? ChevronDownIcon : ArrowUpDownIcon;
  const stateLabel = direction
    ? `, currently ${direction === "asc" ? "ascending" : "descending"}`
    : "";

  return (
    <TableHead className={className} aria-sort={ariaSort}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-mx-1 h-7 px-1.5 text-sm"
        aria-label={`Sort by ${label}${stateLabel}`}
        title={`Sort ${label} ${direction === "asc" ? "descending" : "ascending"}`}
        onClick={() => onSort(column)}
      >
        {label}
        <SortIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </Button>
    </TableHead>
  );
}
