"use client";

import { RefreshCwIcon, SearchIcon } from "lucide-react";

import type { LibraryLifecycle } from "../../models";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@selftune/ui/primitives";
import {
  SkillsLibraryRecommendationFilter,
  type ReviewFilter,
} from "./SkillsLibraryRecommendationFilter";

export const LIFECYCLE_LABELS: Record<LibraryLifecycle, string> = {
  active: "Active",
  library: "In Library",
  draft: "Draft",
  archived: "Archived",
};

export type InventoryFilter = LibraryLifecycle | "all";
export type SourceFilter = "all" | "github" | "upload" | "draft" | "local" | "other";

function isInventoryFilter(value: unknown): value is InventoryFilter {
  return value === "all" || (typeof value === "string" && value in LIFECYCLE_LABELS);
}

function isSourceFilter(value: unknown): value is SourceFilter {
  return ["all", "github", "upload", "draft", "local", "other"].includes(String(value));
}

/**
 * The library opens on active skills. Archived and draft entries accumulate
 * without bound, so an unfiltered default buries what the workspace is actually
 * running. An explicit `?state=` still wins, including `state=all`.
 */
export function initialInventoryFilter(): InventoryFilter {
  if (typeof window === "undefined") return "active";
  const state = new URLSearchParams(window.location.search).get("state");
  return isInventoryFilter(state) ? state : "active";
}

export function SkillsLibraryFilters({
  search,
  lifecycle,
  category,
  categoryOptions,
  connection,
  connections,
  source,
  review,
  archiveRecommendationCount,
  consolidationRecommendationCount,
  refreshing,
  onSearchChange,
  onLifecycleChange,
  onCategoryChange,
  onConnectionChange,
  onSourceChange,
  onReviewChange,
  onRefresh,
}: {
  search: string;
  lifecycle: InventoryFilter;
  category: string;
  categoryOptions: readonly { id: string; label: string }[];
  connection: string;
  connections: readonly string[];
  source: SourceFilter;
  review: ReviewFilter;
  archiveRecommendationCount: number;
  consolidationRecommendationCount: number;
  refreshing: boolean;
  onSearchChange(value: string): void;
  onLifecycleChange(value: InventoryFilter): void;
  onCategoryChange(value: string): void;
  onConnectionChange(value: string): void;
  onSourceChange(value: SourceFilter): void;
  onReviewChange(value: ReviewFilter): void;
  onRefresh(): void;
}) {
  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap">
      <label className="relative min-w-0 flex-1 lg:min-w-72">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search skills or locations"
          aria-label="Search skills or locations"
          className="pl-9"
        />
      </label>
      <Select
        value={lifecycle}
        onValueChange={(value) => {
          if (isInventoryFilter(value)) onLifecycleChange(value);
        }}
      >
        <SelectTrigger aria-label="Filter by state" className="min-w-40">
          <SelectValue>
            {lifecycle === "all" ? "All states" : LIFECYCLE_LABELS[lifecycle]}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All states</SelectItem>
            {Object.entries(LIFECYCLE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {categoryOptions.length > 0 ? (
        <Select value={category} onValueChange={(value) => onCategoryChange(value ?? "all")}>
          <SelectTrigger aria-label="Filter by category" className="min-w-40">
            <SelectValue>
              {category === "all"
                ? "All categories"
                : (categoryOptions.find((option) => option.id === category)?.label ?? category)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All categories</SelectItem>
              {categoryOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : null}
      <Select value={connection} onValueChange={(value) => onConnectionChange(value ?? "all")}>
        <SelectTrigger aria-label="Filter by connection" className="min-w-40">
          <SelectValue>{connection === "all" ? "All connections" : connection}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All connections</SelectItem>
            {connections.map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select
        value={source}
        onValueChange={(value) => {
          if (isSourceFilter(value)) onSourceChange(value);
        }}
      >
        <SelectTrigger aria-label="Filter by source" className="min-w-40">
          <SelectValue>{source === "all" ? "All sources" : source}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="github">GitHub</SelectItem>
            <SelectItem value="upload">Uploaded</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="local">Local</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <SkillsLibraryRecommendationFilter
        value={review}
        archiveCount={archiveRecommendationCount}
        consolidateCount={consolidationRecommendationCount}
        onChange={onReviewChange}
      />
      <Button
        variant="outline"
        size="icon"
        aria-label="Refresh skills"
        disabled={refreshing}
        onClick={onRefresh}
      >
        <RefreshCwIcon className={refreshing ? "animate-spin" : ""} />
      </Button>
    </div>
  );
}
