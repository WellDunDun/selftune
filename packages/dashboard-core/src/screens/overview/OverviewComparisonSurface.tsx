"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EyeIcon } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@selftune/ui/primitives";
import { timeAgo } from "@selftune/ui/lib";
import type { TrustBucket } from "@selftune/ui/types";

import { useOptionalOverviewModule, type DashboardOverviewModule } from "../../host/index";
import type { OverviewComparisonRow } from "./types";

const BUCKET_ORDER: TrustBucket[] = ["at_risk", "improving", "uncertain", "stable"];

const BUCKET_CFG = {
  at_risk: {
    label: "At Risk",
    accent: "text-destructive",
    dot: "bg-destructive",
  },
  improving: { label: "Improving", accent: "text-primary", dot: "bg-primary" },
  uncertain: {
    label: "Uncertain",
    accent: "text-warning-foreground",
    dot: "bg-warning",
  },
  stable: {
    label: "Stable",
    accent: "text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
} satisfies Record<TrustBucket, { label: string; accent: string; dot: string }>;

export interface OverviewComparisonWatchlistConfig {
  initialSkills: string[];
  onChange?(skills: string[]): Promise<string[] | void>;
  emptyMessage?: ReactNode;
}

export interface OverviewComparisonSurfaceProps {
  rows: OverviewComparisonRow[];
  renderSkillLink?: (skillName: string) => ReactNode;
  libraryAction?: ReactNode;
  watchlist?: OverviewComparisonWatchlistConfig;
}

export function resolveOverviewWatchlistChange(
  watchlist: OverviewComparisonWatchlistConfig | undefined,
  overviewModule: DashboardOverviewModule | null,
) {
  return watchlist?.onChange ?? overviewModule?.mutations.updateOverviewWatchlist;
}

export function resolveOverviewWatchlistLoad(overviewModule: DashboardOverviewModule | null) {
  return overviewModule?.mutations.getOverviewWatchlist;
}

export function getOverviewWatchlistSyncKey(initialSkills: string[] | undefined): string {
  return JSON.stringify(initialSkills ?? []);
}

function parseOverviewWatchlistSyncKey(syncKey: string): string[] {
  // SAFETY: syncKey is produced only by JSON.stringify(string[]) in this module.
  return JSON.parse(syncKey) as string[];
}

function parseViewMode(value: string): "watched" | "all" {
  return value === "watched" ? "watched" : "all";
}

function formatEvolutionAction(action: string): string {
  switch (action) {
    case "created":
      return "Proposal created";
    case "validated":
      return "Validated";
    case "deployed":
      return "Deployed";
    case "rolled_back":
      return "Rolled back";
    case "watch":
      return "Watching";
    case "rejected":
      return "Rejected";
    default:
      return action.replace(/_/g, " ");
  }
}

function deriveDefaultWatchlist(rows: OverviewComparisonRow[], limit = 10): string[] {
  return rows
    .toSorted((a, b) => {
      const aRank = BUCKET_ORDER.indexOf(a.bucket);
      const bRank = BUCKET_ORDER.indexOf(b.bucket);
      if (aRank !== bRank) return aRank - bRank;
      return (b.sortTimestamp ?? "").localeCompare(a.sortTimestamp ?? "");
    })
    .slice(0, limit)
    .map((row) => row.skillName);
}

export function OverviewComparisonSurface({
  rows,
  renderSkillLink,
  libraryAction,
  watchlist,
}: OverviewComparisonSurfaceProps) {
  const overviewModule = useOptionalOverviewModule();
  const interactive = Boolean(watchlist);
  const watchlistInitialSkills = watchlist?.initialSkills ?? [];
  const watchlistSyncKey = getOverviewWatchlistSyncKey(watchlistInitialSkills);
  const [viewMode, setViewMode] = useState<"watched" | "all">(interactive ? "watched" : "all");
  const [watchedSkills, setWatchedSkills] = useState<string[]>(() =>
    parseOverviewWatchlistSyncKey(watchlistSyncKey),
  );
  const watchlistRequestSeq = useRef(0);
  const watchlistLoadSeq = useRef(0);
  const loadWatchlist = resolveOverviewWatchlistLoad(overviewModule);
  const onWatchlistChange = resolveOverviewWatchlistChange(watchlist, overviewModule);

  useEffect(() => {
    if (!interactive) return;
    setWatchedSkills(parseOverviewWatchlistSyncKey(watchlistSyncKey));
  }, [interactive, watchlistSyncKey]);

  useEffect(() => {
    if (!interactive || !loadWatchlist || watchlistInitialSkills.length > 0) return;

    const requestSeq = watchlistLoadSeq.current + 1;
    watchlistLoadSeq.current = requestSeq;
    let cancelled = false;

    Promise.resolve(loadWatchlist())
      .then((result) => {
        if (cancelled || watchlistLoadSeq.current !== requestSeq) return;
        setWatchedSkills(result);
        return undefined;
      })
      .catch(() => {
        /* keep default watchlist fallback */
      });

    return () => {
      cancelled = true;
    };
  }, [interactive, loadWatchlist, watchlistInitialSkills.length]);

  const orderedRows = useMemo(() => {
    return rows.toSorted((a, b) => {
      const aRank = BUCKET_ORDER.indexOf(a.bucket);
      const bRank = BUCKET_ORDER.indexOf(b.bucket);
      if (aRank !== bRank) return aRank - bRank;
      return (b.sortTimestamp ?? "").localeCompare(a.sortTimestamp ?? "");
    });
  }, [rows]);

  const effectiveWatchlist = useMemo(() => {
    if (!watchlist) return [];
    const available = new Set(rows.map((row) => row.skillName));
    const cleaned = watchedSkills.filter((skill) => available.has(skill));
    if (cleaned.length > 0) return cleaned;
    return deriveDefaultWatchlist(rows);
  }, [rows, watchedSkills, watchlist]);

  const visibleRows = useMemo(() => {
    if (!watchlist || viewMode === "all") return orderedRows;
    const watched = new Set(effectiveWatchlist);
    return orderedRows.filter((row) => watched.has(row.skillName));
  }, [effectiveWatchlist, orderedRows, viewMode, watchlist]);

  const toggleWatched = async (skillName: string) => {
    if (!watchlist) return;

    const next = effectiveWatchlist.includes(skillName)
      ? effectiveWatchlist.filter((name) => name !== skillName)
      : [...effectiveWatchlist, skillName];

    if (!onWatchlistChange) {
      setWatchedSkills(next);
      return;
    }

    const previous = effectiveWatchlist;
    const requestSeq = watchlistRequestSeq.current + 1;
    watchlistRequestSeq.current = requestSeq;
    setWatchedSkills(next);

    try {
      const result = await onWatchlistChange(next);
      if (watchlistRequestSeq.current === requestSeq && result) {
        setWatchedSkills(result);
      }
    } catch {
      if (watchlistRequestSeq.current === requestSeq) {
        setWatchedSkills(previous);
      }
    }
  };

  return (
    <Card className="col-span-12 border-none bg-muted shadow-none py-0">
      <CardHeader className="px-5 pt-5 pb-0">
        <div>
          <p className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Skill Comparison
          </p>
          <CardDescription className="mt-1 text-[13px]">
            Compare skill performance before drilling into the details.
          </CardDescription>
        </div>
        {(interactive || libraryAction) && (
          <CardAction>
            <div className="flex items-center gap-3">
              {interactive ? (
                <Tabs value={viewMode} onValueChange={(value) => setViewMode(parseViewMode(value))}>
                  <TabsList variant="line" className="h-auto gap-2">
                    <TabsTrigger
                      value="watched"
                      className="font-headline text-[10px] uppercase tracking-[0.18em]"
                    >
                      Watched
                      <span className="ml-1.5 text-muted-foreground">
                        {effectiveWatchlist.length}
                      </span>
                    </TabsTrigger>
                    <TabsTrigger
                      value="all"
                      className="font-headline text-[10px] uppercase tracking-[0.18em]"
                    >
                      All Skills
                      <span className="ml-1.5 text-muted-foreground">{rows.length}</span>
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              ) : null}
              {libraryAction}
            </div>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="themed-scroll overflow-x-auto px-5 py-5">
        <div
          data-parity-root="overview-comparison-grid"
          className={interactive ? "min-w-[780px]" : "min-w-[680px]"}
        >
          {interactive ? (
            <div className="mb-3 rounded-xl bg-background/35 px-3 py-2 text-xs text-muted-foreground">
              {viewMode === "watched"
                ? "Your watched skills stay pinned here. Add or remove them directly from the grid."
                : "All installed skills, sorted by current trust priority."}
            </div>
          ) : null}

          <div
            className={`grid gap-3 px-3 pb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground ${
              interactive
                ? "grid-cols-[minmax(220px,2.3fr)_0.95fr_1.1fr_0.9fr_1.3fr_1fr_0.9fr]"
                : "grid-cols-[minmax(220px,2.3fr)_0.95fr_1.1fr_0.9fr_1.3fr_1fr]"
            }`}
          >
            <span>Skill</span>
            <span>Trigger Rate</span>
            <span>Routing Conf.</span>
            <span>Sessions</span>
            <span>Last Evolution</span>
            <span>Status</span>
            {interactive ? <span className="text-right">Watch</span> : null}
          </div>

          <div className="space-y-1.5">
            {visibleRows.map((row) => {
              const bucketCfg = BUCKET_CFG[row.bucket];
              const isWatched = effectiveWatchlist.includes(row.skillName);

              return (
                <div
                  key={row.skillName}
                  className={`grid items-center gap-3 rounded-xl bg-background/35 px-3 py-3 text-sm transition-colors hover:bg-background/50 ${
                    interactive
                      ? "grid-cols-[minmax(220px,2.3fr)_0.95fr_1.1fr_0.9fr_1.3fr_1fr_0.9fr]"
                      : "grid-cols-[minmax(220px,2.3fr)_0.95fr_1.1fr_0.9fr_1.3fr_1fr]"
                  }`}
                >
                  <div className="min-w-0">
                    {renderSkillLink ? (
                      renderSkillLink(row.skillName)
                    ) : (
                      <p className="truncate font-medium">{row.skillName}</p>
                    )}
                    {row.subtext ? (
                      <p className="truncate text-xs text-muted-foreground">{row.subtext}</p>
                    ) : null}
                  </div>

                  <div className="font-medium">
                    {row.triggerRate != null ? `${Math.round(row.triggerRate * 100)}%` : "—"}
                  </div>

                  <div className="min-w-0">
                    {row.routingConfidence != null && row.confidenceCoverage >= 0.5 ? (
                      <>
                        <p className="text-sm font-medium">
                          {Math.round(row.routingConfidence * 100)}%
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {Math.round(row.confidenceCoverage * 100)}% coverage
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-medium">—</p>
                        <p className="truncate text-xs text-muted-foreground">Low coverage</p>
                      </>
                    )}
                  </div>

                  <div className="text-muted-foreground">{row.sessions}</div>

                  <div className="min-w-0">
                    {row.lastEvolution ? (
                      <>
                        <p className="truncate text-sm">
                          {formatEvolutionAction(row.lastEvolution.action)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {timeAgo(row.lastEvolution.timestamp)}
                        </p>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">No evolutions yet</span>
                    )}
                  </div>

                  <div>
                    <Badge
                      variant="outline"
                      className={`border-transparent ${bucketCfg.accent} bg-background/55`}
                    >
                      <span
                        className={`mr-1.5 inline-block size-1.5 rounded-full ${bucketCfg.dot}`}
                      />
                      {bucketCfg.label}
                    </Badge>
                  </div>

                  {interactive ? (
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant={isWatched ? "secondary" : "ghost"}
                        size="sm"
                        className="h-8 gap-1.5 px-2 text-xs"
                        onClick={() => void toggleWatched(row.skillName)}
                      >
                        <EyeIcon className="size-3.5" />
                        {isWatched ? "Watching" : "Watch"}
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}

            {visibleRows.length === 0 ? (
              <div className="rounded-xl bg-background/30 px-3 py-6 text-sm text-muted-foreground">
                {interactive
                  ? (watchlist?.emptyMessage ?? (
                      <>
                        No watched skills yet. Switch to{" "}
                        <span className="font-medium text-foreground">All Skills</span> and add the
                        ones you want to track closely.
                      </>
                    ))
                  : "No skills available."}
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
