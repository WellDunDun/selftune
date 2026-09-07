import { useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@selftune/ui/primitives";
import type { LibrarySkillModel } from "../../models";
import { LibraryConnections } from "./LibraryConnections";
import {
  SortableTableHead,
  sortSkills,
  type SortState,
  type SortColumn,
} from "./SkillsLibrarySorting";
import { contextFootprint } from "./context-footprint";

const PAGE_SIZE = 20;
function skillDescription(skill: LibrarySkillModel): string {
  return (
    skill.contextEntries?.find((entry) => entry.metadata?.description)?.metadata?.description ??
    "No description available"
  );
}
function savingsLabel(skill: LibrarySkillModel): string {
  const rows = contextFootprint([skill], new Set([skill.id]));
  if (!rows.length || rows.some((row) => row.unknown)) return "Unknown";
  const amounts = rows.map((row) => row.savings);
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  return low === high ? `~${low}` : `~${low}–${high}`;
}

export function OnDemandSkillTable({
  skills,
  selected,
  onSelectionChange,
  pending,
}: {
  skills: readonly LibrarySkillModel[];
  selected: ReadonlySet<string>;
  onSelectionChange(ids: Set<string>): void;
  pending: boolean;
}) {
  const [search, setSearch] = useState("");
  const [suggestedOnly, setSuggestedOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<SortState>({ column: "skill", direction: "asc" });
  const query = search.trim().toLowerCase();
  const filtered = sortSkills(
    skills.filter(
      (skill) =>
        (!suggestedOnly || skill.onDemandReason || skill.archiveRecommendation) &&
        [skill.name, skillDescription(skill), ...skill.locations.map((location) => location.path)]
          .join(" ")
          .toLowerCase()
          .includes(query),
    ),
    sort,
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const setMany = (rows: readonly LibrarySkillModel[], checked: boolean) => {
    const next = new Set(selected);
    for (const skill of rows) {
      if (checked) next.add(skill.id);
      else next.delete(skill.id);
    }
    onSelectionChange(next);
  };
  const changeSort = (column: SortColumn) => {
    setSort({
      column,
      direction: sort.column === column && sort.direction === "asc" ? "desc" : "asc",
    });
    setPage(0);
  };
  return (
    <section aria-label="Choose on-demand skills" className="min-w-0 space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Search on-demand skills"
          placeholder="Search skills or descriptions…"
          value={search}
          className="min-w-40 flex-1"
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
        />
        <Button
          variant={suggestedOnly ? "secondary" : "outline"}
          aria-pressed={suggestedOnly}
          onClick={() => {
            setSuggestedOnly(!suggestedOnly);
            setPage(0);
          }}
        >
          Suggested only
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {filtered.length} matching · {selected.size} selected
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || !filtered.length}
            onClick={() => setMany(filtered, true)}
          >
            Select all {filtered.length} matches
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || !selected.size}
            onClick={() => onSelectionChange(new Set())}
          >
            Clear selection
          </Button>
        </div>
      </div>
      <div className="max-h-[48dvh] overflow-auto rounded-lg border">
        <Table aria-label="On-demand skill library" className="table-fixed">
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label="Select current page"
                  disabled={pending || !visible.length}
                  checked={visible.length > 0 && visible.every((skill) => selected.has(skill.id))}
                  onCheckedChange={(checked) => setMany(visible, checked === true)}
                />
              </TableHead>
              <SortableTableHead label="Skill" column="skill" sort={sort} onSort={changeSort} />
              <TableHead className="w-28">Harnesses</TableHead>
              <TableHead className="w-28 text-right">Tokens freed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((skill) => (
              <TableRow key={skill.id} data-state={selected.has(skill.id) ? "selected" : undefined}>
                <TableCell>
                  <Checkbox
                    aria-label={`Keep ${skill.name} on demand`}
                    disabled={pending}
                    checked={selected.has(skill.id)}
                    onCheckedChange={(checked) => setMany([skill], checked === true)}
                  />
                </TableCell>
                <TableCell className="overflow-hidden">
                  <div className="truncate font-medium" title={skill.name}>
                    {skill.name}
                  </div>
                  <div
                    className="truncate text-xs text-muted-foreground"
                    title={skillDescription(skill)}
                  >
                    {skillDescription(skill)}
                  </div>
                  {skill.onDemandReason || skill.archiveRecommendation ? (
                    <span
                      className="text-xs text-muted-foreground"
                      title={skill.onDemandReason ?? skill.archiveRecommendation?.reason}
                    >
                      Suggested · usage evidence
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <LibraryConnections skill={skill} />
                </TableCell>
                <TableCell
                  className="text-right text-sm tabular-nums"
                  title="Estimated discovery tokens per new session. Ranges span harnesses and project scopes; they are not added together."
                >
                  {savingsLabel(skill)}
                </TableCell>
              </TableRow>
            ))}
            {!visible.length ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  No matching eligible skills. Try another search or turn off Suggested only.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Page {currentPage + 1} of {pageCount} · up to {PAGE_SIZE} skills per page
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={currentPage + 1 === pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </section>
  );
}
