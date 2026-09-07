import { ArchiveIcon, ChevronDownIcon, CopyIcon } from "lucide-react";

import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@selftune/ui/primitives";

export type ReviewFilter = "all" | "archive" | "consolidate";

export function initialReviewFilter(): ReviewFilter {
  const review = new URLSearchParams(globalThis.window?.location.search ?? "").get("review");
  return review === "archive" || review === "consolidate" ? review : "all";
}

export function SkillsLibraryRecommendationFilter({
  value,
  archiveCount,
  consolidateCount,
  onChange,
}: {
  value: ReviewFilter;
  archiveCount: number;
  consolidateCount: number;
  onChange(value: ReviewFilter): void;
}) {
  const activeLabel =
    value === "archive"
      ? "Archive candidates"
      : value === "consolidate"
        ? "Duplicate installations"
        : "Review recommendations";
  const totalCount = archiveCount + consolidateCount;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            className="min-w-44 justify-between"
            aria-label="Review recommendations"
          >
            <span className="flex items-center gap-2">
              {activeLabel}
              {totalCount > 0 ? <Badge variant="secondary">{totalCount}</Badge> : null}
            </span>
            <ChevronDownIcon />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuItem onClick={() => onChange("all")}>Browse all skills</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Recommendations</DropdownMenuLabel>
          <DropdownMenuItem disabled={archiveCount === 0} onClick={() => onChange("archive")}>
            <ArchiveIcon />
            <span className="min-w-0 flex-1">
              <span className="block">Archive candidates</span>
              <span className="block text-xs font-normal text-muted-foreground">
                No meaningful recent use
              </span>
            </span>
            <Badge variant="secondary">{archiveCount}</Badge>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={consolidateCount === 0}
            onClick={() => onChange("consolidate")}
          >
            <CopyIcon />
            <span className="min-w-0 flex-1">
              <span className="block">Duplicate installations</span>
              <span className="block text-xs font-normal text-muted-foreground">
                Multiple copies can be consolidated
              </span>
            </span>
            <Badge variant="secondary">{consolidateCount}</Badge>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
