import {
  SkillsLibraryScreen,
  type SkillsLibraryHero,
  type SkillsLibraryPendingProposal,
} from "@selftune/dashboard-core/screens/skills";
import type { DerivedSkill } from "@selftune/ui/components";
import { deriveStatus, sortByPassRateAndChecks, timeAgo } from "@selftune/ui/lib";
import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@selftune/ui/primitives";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  InfoIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { HarnessLogo } from "@/components/HarnessLogo";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  usePortfolio,
  usePreviewQuarantinePortfolioSkill,
  useQuarantinePortfolioSkill,
  useRestorePortfolioSkill,
} from "@/hooks/usePortfolio";
import {
  useApplySkillSourceUpdate,
  useLibrary,
  usePreviewSkillSourceUpdate,
} from "@/hooks/useLibrary";
import type {
  DashboardShellResponse,
  HarnessId,
  LibrarySnapshot,
  PortfolioAuditEntry,
  SkillSummary,
} from "@/types";

type LibraryLifecycle = "active" | "library" | "draft" | "archived";

const LIFECYCLE_LABELS: Record<LibraryLifecycle, string> = {
  active: "Active",
  library: "In Library",
  draft: "Draft",
  archived: "Archived",
};

const HARNESS_LABELS: Record<HarnessId, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  pi: "Pi",
};

type LibraryLocation = LibrarySnapshot["skills"][number]["locations"][number];
type LibrarySkill = LibrarySnapshot["skills"][number];
type SkillUpdateStatus = LibrarySnapshot["skills"][number]["updateStatus"];
type LibraryOrigin = LibrarySkill["origins"][number];

const UPDATE_LABELS: Record<SkillUpdateStatus, string> = {
  available: "Update available",
  current: "Up to date",
  unknown: "Check unavailable",
  untracked: "Not tracked",
};

const SKILL_TABLE_SKELETON_ROWS = ["first", "second", "third", "fourth", "fifth"] as const;
const SKILL_TABLE_SKELETON_CELLS = [
  { id: "skill", width: "w-32", className: "" },
  { id: "state", width: "w-16", className: "" },
  { id: "source", width: "w-20", className: "" },
  { id: "location", width: "w-32", className: "" },
  { id: "harnesses", width: "w-24", className: "hidden 2xl:table-cell" },
  { id: "last-used", width: "w-16", className: "hidden xl:table-cell" },
  { id: "modified", width: "w-16", className: "hidden 2xl:table-cell" },
  { id: "update", width: "w-20", className: "hidden xl:table-cell" },
  { id: "actions", width: "w-8", className: "" },
] as const;

function uniqueOrigins(origins: readonly LibraryOrigin[]): LibraryOrigin[] {
  const seen = new Set<string>();
  return origins.filter((origin) => {
    const key = `${origin.kind}:${origin.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceFolder(skill: LibrarySkill, origin: LibraryOrigin): string | null {
  const matchingLocation = skill.locations.find(
    (location) => location.origin?.kind === origin.kind && location.origin.label === origin.label,
  );
  return matchingLocation?.packagePath ?? skill.locations[0]?.packagePath ?? null;
}

function safeSourceUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return null;
    if (url.hostname.toLowerCase() === "github.com") {
      url.pathname = url.pathname.replace(/\.git\/?$/i, "");
    }
    return url.href;
  } catch {
    return null;
  }
}

async function openSourceFolder(path: string): Promise<void> {
  try {
    const openFolder = window.selftuneDesktop?.openFolder;
    if (openFolder) {
      await openFolder(path);
      return;
    }
    await navigator.clipboard.writeText(path);
    toast.info("Folder path copied", {
      description: "Open this path in your file manager.",
    });
  } catch (error) {
    toast.error("Folder could not be opened", {
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

function SourceButton({ origin, path }: { origin: LibraryOrigin; path: string | null }) {
  const url = safeSourceUrl(origin.url);
  if (url) {
    return (
      <Button
        variant="outline"
        size="xs"
        nativeButton={false}
        className="max-w-52"
        title={url}
        aria-label={`Open ${origin.label} repository`}
        render={<a href={url} target="_blank" rel="noreferrer" />}
      >
        <span className="truncate">{origin.label}</span>
        <ExternalLinkIcon data-icon="inline-end" />
      </Button>
    );
  }
  if (path) {
    return (
      <Button
        variant="outline"
        size="xs"
        className="max-w-52"
        title={path}
        aria-label={`Open ${origin.label} folder`}
        onClick={() => void openSourceFolder(path)}
      >
        <span className="truncate">{origin.label}</span>
        <FolderOpenIcon data-icon="inline-end" />
      </Button>
    );
  }
  return (
    <Badge variant="outline" className="max-w-52" title={origin.label}>
      <span className="truncate">{origin.label}</span>
    </Badge>
  );
}

function librarySkillKey(skill: LibrarySkill): string {
  const locations = skill.locations
    .map((location) => `${location.sourceKind}:${location.packagePath}`)
    .toSorted();
  return [skill.skillId, skill.name, ...locations].join(":");
}

function pathName(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
}

function locationDisplay(location: LibraryLocation): {
  key: string;
  label: string;
  title: string;
} {
  if (location.scope === "global") {
    return { key: "global", label: "Global", title: "Installed globally" };
  }
  if (location.scope === "project") {
    const directory = location.projectRoot ?? location.packagePath;
    return {
      key: `project:${directory}`,
      label: pathName(directory),
      title: directory,
    };
  }
  if (location.scope === "library") {
    return { key: "library", label: "Library", title: location.packagePath };
  }
  if (location.scope === "admin") {
    return { key: "admin", label: "Admin", title: location.packagePath };
  }
  if (location.scope === "system") {
    return { key: "system", label: "System", title: location.packagePath };
  }
  return {
    key: `unknown:${location.packagePath}`,
    label: pathName(location.packagePath),
    title: location.packagePath,
  };
}

function formatTimestamp(timestamp: string | null, emptyLabel: string): string {
  return timestamp ? timeAgo(timestamp) : emptyLabel;
}

function timestampTitle(timestamp: string | null): string | undefined {
  if (!timestamp) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

function isLibraryLifecycle(value: string): value is LibraryLifecycle {
  return value in LIFECYCLE_LABELS;
}

function LibraryInventory() {
  const library = useLibrary();
  const portfolio = usePortfolio();
  const quarantine = useQuarantinePortfolioSkill();
  const previewQuarantine = usePreviewQuarantinePortfolioSkill();
  const restore = useRestorePortfolioSkill();
  const previewSourceUpdate = usePreviewSkillSourceUpdate();
  const applySourceUpdate = useApplySkillSourceUpdate();
  const [search, setSearch] = useState("");
  const [lifecycle, setLifecycle] = useState<LibraryLifecycle | "all">("all");
  const [harness, setHarness] = useState("all");
  const [archiveReview, setArchiveReview] = useState<PortfolioAuditEntry | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);

  const selectedSkill =
    library.data?.skills.find((skill) => librarySkillKey(skill) === selectedSkillId) ?? null;

  const visibleSkills = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return (library.data?.skills ?? []).filter((skill) => {
      if (lifecycle !== "all" && skill.lifecycle !== lifecycle) return false;
      if (harness !== "all" && !skill.locations.some((location) => location.harness === harness)) {
        return false;
      }
      if (!normalizedSearch) return true;
      return [
        skill.name,
        skill.skillId,
        ...skill.origins.map((origin) => origin.label),
        ...skill.locations.flatMap((location) => [
          location.packagePath,
          location.projectRoot ?? "",
          location.scope,
          location.harness ?? "",
        ]),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearch);
    });
  }, [harness, library.data, lifecycle, search]);

  const openArchiveReview = (skill: PortfolioAuditEntry) => {
    previewQuarantine.mutate(
      { skillName: skill.skill_name, skillPath: skill.skill_path },
      { onSuccess: () => setArchiveReview(skill) },
    );
  };

  const confirmArchive = () => {
    if (!archiveReview) return;
    quarantine.mutate(
      {
        skillName: archiveReview.skill_name,
        skillPath: archiveReview.skill_path,
      },
      { onSuccess: () => setArchiveReview(null) },
    );
  };

  const openSkillDetail = (skill: LibrarySkill) => {
    previewSourceUpdate.reset();
    applySourceUpdate.reset();
    setSelectedSkillId(librarySkillKey(skill));
  };

  const closeSkillDetail = () => {
    setSelectedSkillId(null);
    previewSourceUpdate.reset();
    applySourceUpdate.reset();
  };

  const applySelectedSourceUpdate = () => {
    if (!selectedSkill || previewSourceUpdate.data?.status !== "available") return;
    applySourceUpdate.mutate({
      skillName: selectedSkill.name,
      strategy: previewSourceUpdate.data.conflicts > 0 ? "take_upstream" : "abort",
    });
  };

  return (
    <section className="min-w-0 max-w-full border-y border-border/20 bg-background/30 py-5">
      <div className="flex flex-col gap-4 px-1">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-headline text-lg font-semibold text-foreground">Skill Library</h2>
              {library.data ? (
                <Badge variant="outline" className="border-border/40 bg-muted/40 text-foreground">
                  {library.data.counts.total}
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              One skill identity, with every revision and active location grouped beneath it.
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
            <InputGroup className="h-9 min-w-0 bg-muted/30 sm:w-72">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search skills or locations"
                aria-label="Search skills or locations"
              />
            </InputGroup>
            <Select
              value={lifecycle}
              onValueChange={(value) => {
                if (value !== null) {
                  setLifecycle(value === "all" || isLibraryLifecycle(value) ? value : "all");
                }
              }}
            >
              <SelectTrigger
                className="h-9 min-w-32 bg-muted/30"
                aria-label="Filter skills by lifecycle"
              >
                <SelectValue>
                  {lifecycle === "all" ? "All states" : LIFECYCLE_LABELS[lifecycle]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
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
            <Select
              value={harness}
              onValueChange={(value) => {
                if (value !== null) setHarness(value);
              }}
            >
              <SelectTrigger
                className="h-9 min-w-36 bg-muted/30"
                aria-label="Filter skills by harness"
              >
                <SelectValue>
                  {harness === "all"
                    ? "All harnesses"
                    : (HARNESS_LABELS[harness as HarnessId] ?? harness)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>
                  <SelectItem value="all">All harnesses</SelectItem>
                  {Object.entries(HARNESS_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              title="Refresh installed inventory"
              aria-label="Refresh installed inventory"
              onClick={() => void Promise.all([library.refetch(), portfolio.refetch()])}
              disabled={library.isFetching || portfolio.isFetching}
            >
              <RefreshCwIcon
                className={`size-4 ${library.isFetching || portfolio.isFetching ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </div>

        {library.isError ? (
          <div className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {library.error instanceof Error
              ? library.error.message
              : "The Skill Library could not be loaded."}
          </div>
        ) : null}

        <div className="max-w-full overflow-x-auto border border-border/20">
          <table className="w-full min-w-[680px] border-collapse text-left text-sm xl:min-w-[840px] 2xl:min-w-[960px]">
            <thead className="bg-muted/50 text-[11px] uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Skill</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Location</th>
                <th className="hidden px-3 py-2 font-medium 2xl:table-cell">Harnesses</th>
                <th className="hidden px-3 py-2 font-medium xl:table-cell">Last used</th>
                <th className="hidden px-3 py-2 font-medium 2xl:table-cell">Modified</th>
                <th className="hidden px-3 py-2 font-medium xl:table-cell">Update</th>
                <th className="w-20 px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/15" aria-busy={library.isLoading}>
              {library.isLoading ? (
                SKILL_TABLE_SKELETON_ROWS.map((rowId) => (
                  <tr key={rowId} aria-label="Loading skill">
                    {SKILL_TABLE_SKELETON_CELLS.map((cell) => (
                      <td key={cell.id} className={`px-3 py-3 ${cell.className}`}>
                        <Skeleton className={`h-4 ${cell.width}`} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : visibleSkills.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                    No skills match this view.
                  </td>
                </tr>
              ) : (
                visibleSkills.map((skill) => {
                  const evidence = portfolio.data?.audit.skills.find(
                    (entry) => entry.skill_name.toLowerCase() === skill.skillId,
                  );
                  const archive = portfolio.data?.quarantined.find(
                    (entry) => entry.skill_name.toLowerCase() === skill.skillId,
                  );
                  const installedLocations = skill.locations.filter(
                    (location) => location.sourceKind === "installed",
                  );
                  const harnesses = [
                    ...new Set(
                      skill.locations.flatMap((location) =>
                        location.harness ? [location.harness] : [],
                      ),
                    ),
                  ];
                  const locations = [
                    ...new Map(
                      skill.locations.map((location) => {
                        const display = locationDisplay(location);
                        return [display.key, display];
                      }),
                    ).values(),
                  ];
                  return (
                    <tr key={librarySkillKey(skill)} className="bg-background/20 hover:bg-muted/20">
                      <td className="max-w-48 px-3 py-3">
                        <p className="font-medium text-foreground">{skill.name}</p>
                        <p
                          className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                          title={skill.locations[0]?.packagePath}
                        >
                          {skill.locations[0]?.packagePath}
                        </p>
                      </td>
                      <td className="px-3 py-3">
                        <Badge variant="outline" className="border-border/40 bg-muted/40">
                          {LIFECYCLE_LABELS[skill.lifecycle]}
                        </Badge>
                      </td>
                      <td className="max-w-56 px-3 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {uniqueOrigins(skill.origins).map((origin) => (
                            <SourceButton
                              key={`${origin.kind}:${origin.label}`}
                              origin={origin}
                              path={sourceFolder(skill, origin)}
                            />
                          ))}
                        </div>
                      </td>
                      <td className="max-w-52 px-3 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {locations.map((location) => (
                            <Badge key={location.key} variant="secondary" title={location.title}>
                              {location.label}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="hidden w-36 px-3 py-3 2xl:table-cell">
                        {harnesses.length > 0 ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {harnesses.map((harnessId) => (
                              <Tooltip key={harnessId}>
                                <TooltipTrigger
                                  render={
                                    <span
                                      aria-label={HARNESS_LABELS[harnessId]}
                                      className="inline-flex rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    />
                                  }
                                >
                                  <HarnessLogo id={harnessId} className="size-7 rounded" />
                                </TooltipTrigger>
                                <TooltipContent>{HARNESS_LABELS[harnessId]}</TooltipContent>
                              </Tooltip>
                            ))}
                          </div>
                        ) : (
                          <span className="text-muted-foreground" title="Stored only">
                            —<span className="sr-only">Stored only</span>
                          </span>
                        )}
                      </td>
                      <td
                        className="hidden whitespace-nowrap px-3 py-3 text-xs text-muted-foreground xl:table-cell"
                        title={timestampTitle(skill.lastUsedAt)}
                      >
                        {formatTimestamp(skill.lastUsedAt, "Never observed")}
                      </td>
                      <td
                        className="hidden whitespace-nowrap px-3 py-3 text-xs text-muted-foreground 2xl:table-cell"
                        title={timestampTitle(skill.lastModifiedAt)}
                      >
                        {formatTimestamp(skill.lastModifiedAt, "Unknown")}
                      </td>
                      <td className="hidden px-3 py-3 xl:table-cell">
                        <Badge
                          variant={skill.updateStatus === "available" ? "warning" : "outline"}
                          className={
                            skill.updateStatus === "current"
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                              : ""
                          }
                        >
                          {UPDATE_LABELS[skill.updateStatus]}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title="View skill locations"
                            aria-label={`View ${skill.name} locations`}
                            onClick={() => openSkillDetail(skill)}
                          >
                            <InfoIcon className="size-4" />
                          </Button>
                          {archive ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Restore skill"
                              aria-label={`Restore ${skill.name}`}
                              onClick={() => restore.mutate(archive.quarantine_id)}
                              disabled={restore.isPending}
                            >
                              <ArchiveRestoreIcon className="size-4" />
                            </Button>
                          ) : evidence &&
                            evidence.classification !== "protected" &&
                            installedLocations.length === 1 ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Quarantine skill"
                              aria-label={`Quarantine ${skill.name}`}
                              onClick={() => openArchiveReview(evidence)}
                              disabled={quarantine.isPending || previewQuarantine.isPending}
                            >
                              <ArchiveIcon className="size-4" />
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {quarantine.error || restore.error ? (
          <p className="text-xs text-destructive">{(quarantine.error ?? restore.error)?.message}</p>
        ) : null}
      </div>
      <Dialog
        open={archiveReview !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveReview(null);
        }}
      >
        {archiveReview ? (
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Archive {archiveReview.skill_name}?</DialogTitle>
              <DialogDescription>{archiveReview.reason}</DialogDescription>
            </DialogHeader>
            {archiveReview.classification === "unobserved" ? (
              <p className="border-l-2 border-primary px-3 text-xs text-foreground">
                This skill is not observed. That is not evidence that it is unused.
              </p>
            ) : null}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
              <dt className="text-muted-foreground">Leaves active context</dt>
              <dd className="break-all text-foreground">{archiveReview.package_path}</dd>
              <dt className="text-muted-foreground">Recovery</dt>
              <dd className="text-foreground">Exact location retained in a restore receipt</dd>
              <dt className="text-muted-foreground">Deletion</dt>
              <dd className="text-foreground">None</dd>
            </dl>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setArchiveReview(null)}>
                Cancel
              </Button>
              <Button onClick={confirmArchive} disabled={quarantine.isPending}>
                <ArchiveIcon className="size-4" /> Archive skill
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
      <Dialog
        open={selectedSkill !== null}
        onOpenChange={(open) => {
          if (!open) closeSkillDetail();
        }}
      >
        {selectedSkill ? (
          <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-2xl">
            <DialogHeader className="sticky top-0 border-b border-border/30 bg-popover px-5 py-4 pr-14">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="truncate">{selectedSkill.name}</DialogTitle>
                <Badge variant="outline" className="border-border/40 bg-muted/30">
                  {LIFECYCLE_LABELS[selectedSkill.lifecycle]}
                </Badge>
                <Badge variant={selectedSkill.updateStatus === "available" ? "warning" : "outline"}>
                  {UPDATE_LABELS[selectedSkill.updateStatus]}
                </Badge>
              </div>
              <DialogDescription className="text-xs">
                {selectedSkill.locations.length} concrete location
                {selectedSkill.locations.length === 1 ? "" : "s"}
              </DialogDescription>
            </DialogHeader>

            <div className="border-b border-border/20 px-5 py-4">
              <p className="text-[11px] font-medium uppercase text-muted-foreground">Source</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {uniqueOrigins(selectedSkill.origins).map((origin) => (
                  <SourceButton
                    key={`${origin.kind}:${origin.label}`}
                    origin={origin}
                    path={sourceFolder(selectedSkill, origin)}
                  />
                ))}
              </div>
              {selectedSkill.revisions.length > 0 ? (
                <p className="mt-3 font-mono text-[10px] text-muted-foreground">
                  {selectedSkill.revisions.length} local revision
                  {selectedSkill.revisions.length === 1 ? "" : "s"}:{" "}
                  {selectedSkill.revisions
                    .map((revision) => revision.contentHash.slice(0, 10))
                    .join(", ")}
                </p>
              ) : null}
            </div>

            <div>
              {selectedSkill.locations.map((location) => {
                const display = locationDisplay(location);
                return (
                  <div
                    key={`${location.sourceKind}:${location.packagePath}:${location.harness ?? "none"}`}
                    className="border-b border-border/15 px-5 py-4 last:border-b-0"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" title={display.title}>
                        {display.label}
                      </Badge>
                      <Badge variant="outline" className="border-border/40 bg-muted/20">
                        {location.sourceKind}
                      </Badge>
                      {location.harness ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
                          <HarnessLogo id={location.harness} className="size-5 rounded-sm" />
                          {HARNESS_LABELS[location.harness]}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">No active harness</span>
                      )}
                    </div>
                    <p className="mt-3 break-all font-mono text-[11px] text-foreground">
                      {location.packagePath}
                    </p>
                    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                      <dt className="text-muted-foreground">Last used</dt>
                      <dd title={timestampTitle(location.lastUsedAt)} className="text-foreground">
                        {formatTimestamp(location.lastUsedAt, "Never observed")}
                      </dd>
                      <dt className="text-muted-foreground">Modified</dt>
                      <dd title={timestampTitle(location.modifiedAt)} className="text-foreground">
                        {formatTimestamp(location.modifiedAt, "Unknown")}
                      </dd>
                      <dt className="text-muted-foreground">Update</dt>
                      <dd className="text-foreground">{UPDATE_LABELS[location.updateStatus]}</dd>
                    </dl>
                  </div>
                );
              })}
            </div>

            <div className="border-t border-border/30 bg-muted/15 px-5 py-4">
              {previewSourceUpdate.data ? (
                <div className="mb-4">
                  <p className="text-sm font-medium text-foreground">
                    {previewSourceUpdate.data.status === "current"
                      ? "This skill is current."
                      : `${previewSourceUpdate.data.installed_hash.slice(0, 10)} to ${previewSourceUpdate.data.latest_hash.slice(0, 10)}`}
                  </p>
                  {previewSourceUpdate.data.conflicts > 0 ? (
                    <div className="mt-3 border-l-2 border-amber-500 px-3 text-xs text-foreground">
                      Local changes were found in {previewSourceUpdate.data.conflicts} location
                      {previewSourceUpdate.data.conflicts === 1 ? "" : "s"}. Replacing from upstream
                      will preserve backups in the update receipt.
                    </div>
                  ) : null}
                  {previewSourceUpdate.data.conflicts === 0 ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                      All {previewSourceUpdate.data.locations.length} tracked location
                      {previewSourceUpdate.data.locations.length === 1 ? "" : "s"} match the
                      recorded upstream revision.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-2">
                      {previewSourceUpdate.data.locations
                        .filter((location) => location.local_state !== "clean")
                        .map((location) => (
                          <div
                            key={location.package_path}
                            className="flex items-start justify-between gap-3 text-xs"
                          >
                            <span className="min-w-0 break-all font-mono text-muted-foreground">
                              {location.package_path}
                            </span>
                            <Badge variant="warning" className="shrink-0" title={location.reason}>
                              Local changes
                            </Badge>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              ) : null}

              {previewSourceUpdate.error || applySourceUpdate.error ? (
                <p className="mb-3 text-xs text-destructive">
                  {(previewSourceUpdate.error ?? applySourceUpdate.error)?.message}
                </p>
              ) : null}
              {applySourceUpdate.data ? (
                <p className="mb-3 text-xs text-emerald-400">
                  Updated to {applySourceUpdate.data.installed_hash.slice(0, 10)}. Backup receipt{" "}
                  {applySourceUpdate.data.receipt_id.slice(0, 8)} retained.
                </p>
              ) : null}

              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" onClick={closeSkillDetail}>
                  Close
                </Button>
                {!applySourceUpdate.data &&
                !previewSourceUpdate.data &&
                selectedSkill.origins.some((origin) => origin.kind === "github") ? (
                  <Button
                    onClick={() => previewSourceUpdate.mutate(selectedSkill.name)}
                    disabled={previewSourceUpdate.isPending}
                  >
                    <RefreshCwIcon
                      className={`size-4 ${previewSourceUpdate.isPending ? "animate-spin" : ""}`}
                    />
                    Check source
                  </Button>
                ) : null}
                {!applySourceUpdate.data && previewSourceUpdate.data?.status === "available" ? (
                  <Button
                    variant={previewSourceUpdate.data.conflicts > 0 ? "destructive" : "default"}
                    onClick={applySelectedSourceUpdate}
                    disabled={applySourceUpdate.isPending}
                  >
                    <DownloadIcon className="size-4" />
                    {previewSourceUpdate.data.conflicts > 0
                      ? "Replace with upstream"
                      : "Install update"}
                  </Button>
                ) : null}
              </div>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </section>
  );
}

/* ── Helpers ───────────────────────────────────────────────── */

function deriveSkills(skills: SkillSummary[]): DerivedSkill[] {
  return sortByPassRateAndChecks(
    skills.map((s) => ({
      name: s.skill_name,
      scope: s.skill_scope,
      platforms: [],
      passRate: s.total_checks > 0 ? s.pass_rate : null,
      checks: s.total_checks,
      status: deriveStatus(s.pass_rate, s.total_checks),
      uniqueSessions: s.unique_sessions,
      triggeredCount: s.triggered_count,
      lastSeen: s.last_seen,
    })),
  );
}

function aggregatePassRate(skills: SkillSummary[]): number | null {
  const graded = skills.filter((s) => s.total_checks >= 5);
  if (graded.length === 0) return null;
  const totalChecks = graded.reduce((sum, s) => sum + s.total_checks, 0);
  const totalPasses = graded.reduce((sum, s) => sum + Math.round(s.pass_rate * s.total_checks), 0);
  return totalChecks > 0 ? totalPasses / totalChecks : null;
}

function findMostActiveSkill(
  skills: SkillSummary[],
  evolution: DashboardShellResponse["latest_evolutions"],
): {
  skill: SkillSummary;
  latestEvolution: DashboardShellResponse["latest_evolutions"][number] | null;
} | null {
  const sorted = evolution
    .filter((e) => e.skill_name)
    .toSorted((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  for (const evo of sorted) {
    const skill = skills.find((s) => s.skill_name === evo.skill_name);
    if (skill) return { skill, latestEvolution: evo };
  }

  if (skills.length > 0) {
    const top = skills.toSorted((a, b) => b.total_checks - a.total_checks)[0];
    return { skill: top, latestEvolution: sorted[0] ?? null };
  }
  return null;
}

/* ── Render-prop helpers for React Router links ────────────── */

function renderHeroActions(skillName: string) {
  const encoded = encodeURIComponent(skillName);
  return (
    <>
      <Button
        nativeButton={false}
        render={<Link to={`/skills/${encoded}`} />}
        variant="ghost"
        size="lg"
      >
        Configure
      </Button>
      <Button nativeButton={false} render={<Link to={`/skills/${encoded}`} />} size="lg">
        View Report
      </Button>
    </>
  );
}

function renderCardActions(skillName: string) {
  const encoded = encodeURIComponent(skillName);
  return (
    <>
      <Button
        nativeButton={false}
        render={<Link to={`/skills/${encoded}`} />}
        variant="ghost"
        size="sm"
        className="flex-1"
      >
        Configure
      </Button>
      <Button
        nativeButton={false}
        render={<Link to={`/skills/${encoded}`} />}
        variant="secondary"
        size="sm"
        className="flex-1"
      >
        View Report
      </Button>
    </>
  );
}

/* ── Main Component ────────────────────────────────────────── */

export function SkillsLibrary({
  overviewQuery,
}: {
  overviewQuery: UseQueryResult<DashboardShellResponse>;
}) {
  const { data, isLoading, isError, error, refetch } = overviewQuery;

  const allSkills = useMemo(() => (data ? deriveSkills(data.skills) : []), [data]);

  const heroData = useMemo(() => {
    if (!data) return null;
    return findMostActiveSkill(data.skills, data.latest_evolutions);
  }, [data]);

  const heroSkill = useMemo<SkillsLibraryHero | null>(() => {
    if (!heroData) return null;
    return {
      skillName: heroData.skill.skill_name,
      skillScope: heroData.skill.skill_scope,
      passRate: heroData.skill.total_checks > 0 ? heroData.skill.pass_rate : null,
      totalChecks: heroData.skill.total_checks,
      uniqueSessions: heroData.skill.unique_sessions,
      status: deriveStatus(heroData.skill.pass_rate, heroData.skill.total_checks),
      latestEvolutionTimestamp: heroData.latestEvolution?.timestamp ?? null,
    };
  }, [heroData]);

  const pendingProposals = useMemo<SkillsLibraryPendingProposal[]>(() => {
    if (!data) return [];
    return data.pending_proposals.map((proposal) => ({
      id: proposal.proposal_id,
      skillName: proposal.skill_name ?? null,
      action: proposal.action,
    }));
  }, [data]);

  return (
    <SkillsLibraryScreen
      skills={allSkills}
      inventoryControl={<LibraryInventory />}
      heroSkill={heroSkill}
      aggregatePassRate={data ? aggregatePassRate(data.skills) : null}
      gradedCount={data ? data.skills.filter((skill) => skill.total_checks >= 5).length : 0}
      pendingProposals={pendingProposals}
      isLoading={isLoading}
      error={
        isError ? (error instanceof Error ? error.message : "Failed to load skills library.") : null
      }
      onRetry={() => {
        void refetch();
      }}
      renderHeroActions={renderHeroActions}
      renderCardActions={renderCardActions}
    />
  );
}
