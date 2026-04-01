import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@selftune/ui/primitives";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  EyeIcon,
  RefreshCwIcon,
  RocketIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Skeleton } from "@/components/ui/skeleton";
import { useOrchestrateRuns } from "@/hooks/useOrchestrateRuns";
import type {
  AttentionItem,
  AutonomousDecision,
  AutonomyStatusLevel,
  DecisionKind,
  EvolutionEntry,
  OverviewResponse,
  SkillHealthStatus,
  SkillSummary,
  TrustBucket,
  TrustWatchlistEntry,
} from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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

const STATUS_DOT: Record<AutonomyStatusLevel, { color: string; glow: string }> = {
  healthy: {
    color: "bg-emerald-400",
    glow: "shadow-[0_0_12px_rgba(52,211,153,0.6)]",
  },
  watching: {
    color: "bg-primary",
    glow: "shadow-[0_0_12px_rgba(79,242,255,0.6)]",
  },
  needs_review: {
    color: "bg-amber-400",
    glow: "shadow-[0_0_12px_rgba(251,191,36,0.6)]",
  },
  blocked: {
    color: "bg-red-400",
    glow: "shadow-[0_0_12px_rgba(248,113,113,0.6)]",
  },
};

const STATUS_LABELS: Record<AutonomyStatusLevel, string> = {
  healthy: "Healthy",
  watching: "Watching",
  needs_review: "Needs Review",
  blocked: "Blocked",
};

const SEVERITY: Record<string, { dot: string; text: string; bg: string }> = {
  critical: {
    dot: "bg-red-400",
    text: "text-red-400",
    bg: "bg-red-500/10",
  },
  warning: {
    dot: "bg-amber-400",
    text: "text-amber-400",
    bg: "bg-amber-500/10",
  },
  info: {
    dot: "bg-primary",
    text: "text-primary",
    bg: "bg-primary/10",
  },
};

const DECISION_MARKERS: Record<DecisionKind, string> = {
  proposal_created: "bg-primary",
  validation_failed: "bg-amber-400",
  proposal_deployed: "bg-emerald-400",
  rollback_triggered: "bg-red-400",
  regression_found: "bg-amber-400",
};

const BUCKET_CFG: Record<TrustBucket, { label: string; accent: string; dot: string }> = {
  at_risk: { label: "At Risk", accent: "text-red-400", dot: "bg-red-400" },
  improving: { label: "Improving", accent: "text-primary", dot: "bg-primary" },
  uncertain: { label: "Uncertain", accent: "text-amber-400", dot: "bg-amber-400" },
  stable: {
    label: "Stable",
    accent: "text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
};

// Ambient bar heights for hero background
const BARS = [35, 55, 40, 70, 45, 80, 30, 65, 50, 75, 38, 60, 42, 72];
const WATCHLIST_STORAGE_KEY = "selftune-overview-watchlist";

function loadStoredWatchlist(): string[] {
  try {
    const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function saveStoredWatchlist(skills: string[]): void {
  try {
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(skills));
  } catch {
    /* ignore */
  }
}

function deriveDefaultWatchlist(
  skills: SkillSummary[],
  trustWatchlist: TrustWatchlistEntry[],
  limit = 10,
): string[] {
  const bucketOrder: TrustBucket[] = ["at_risk", "improving", "uncertain", "stable"];
  const ranked = [...trustWatchlist].sort((a, b) => {
    const aRank = bucketOrder.indexOf(a.bucket);
    const bRank = bucketOrder.indexOf(b.bucket);
    if (aRank !== bRank) return aRank - bRank;
    return (b.last_seen ?? "").localeCompare(a.last_seen ?? "");
  });
  const picked = ranked.slice(0, limit).map((entry) => entry.skill_name);
  if (picked.length >= limit) return picked;

  const seen = new Set(picked);
  for (const skill of [...skills].sort((a, b) =>
    (b.last_seen ?? "").localeCompare(a.last_seen ?? ""),
  )) {
    if (seen.has(skill.skill_name)) continue;
    picked.push(skill.skill_name);
    seen.add(skill.skill_name);
    if (picked.length >= limit) break;
  }
  return picked;
}

// ---------------------------------------------------------------------------
// OnboardingBanner
// ---------------------------------------------------------------------------

function OnboardingBanner({ skillCount }: { skillCount: number }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem("selftune-onboarding-dismissed") === "true";
    } catch {
      return false;
    }
  });

  // Only show when no skills exist AND not dismissed
  if (skillCount > 0 || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem("selftune-onboarding-dismissed", "true");
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="col-span-12 rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 p-8">
      <div className="flex flex-col items-center text-center gap-4 max-w-md mx-auto">
        <div className="flex items-center justify-center size-12 rounded-full bg-primary/10">
          <RocketIcon className="size-6 text-primary" />
        </div>
        <h2 className="font-headline text-lg font-semibold">Welcome to selftune</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          No skills detected yet. Once you start using selftune in your project, skills will appear
          here automatically.
        </p>
        <div className="grid grid-cols-1 gap-3 w-full text-left sm:grid-cols-3">
          <div className="flex items-start gap-2.5 rounded-lg border bg-card p-3">
            <div className="flex items-center justify-center size-6 rounded-full bg-blue-500/10 text-blue-500 shrink-0 text-xs font-bold">
              1
            </div>
            <div>
              <p className="text-xs font-medium">Run selftune</p>
              <p className="text-[11px] text-muted-foreground">
                Enable selftune in your project to start tracking skills
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2.5 rounded-lg border bg-card p-3">
            <div className="flex items-center justify-center size-6 rounded-full bg-amber-500/10 text-amber-500 shrink-0 text-xs font-bold">
              2
            </div>
            <div>
              <p className="text-xs font-medium">Skills appear</p>
              <p className="text-[11px] text-muted-foreground">
                Skills are detected and monitored automatically
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2.5 rounded-lg border bg-card p-3">
            <div className="flex items-center justify-center size-6 rounded-full bg-emerald-500/10 text-emerald-500 shrink-0 text-xs font-bold">
              3
            </div>
            <div>
              <p className="text-xs font-medium">Watch evolution</p>
              <p className="text-[11px] text-muted-foreground">
                Proposals flow in with validated improvements
              </p>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surface 1: Autonomy Hero
// ---------------------------------------------------------------------------

function OverviewHero({
  status,
  lastRun,
}: {
  status: OverviewResponse["autonomy_status"];
  lastRun: string | null;
}) {
  const dot = STATUS_DOT[status.level];
  const primaryStat =
    status.attention_required > 0
      ? { value: status.attention_required, label: "Attention Required" }
      : { value: status.skills_observed, label: "Skills Observed" };

  return (
    <Card className="relative min-h-[332px] border-none bg-gradient-to-br from-muted via-muted to-primary/5 shadow-none py-0">
      {/* Ambient bars */}
      <div className="absolute inset-0 flex items-end justify-around px-8 pb-24 pt-20 opacity-[0.08] pointer-events-none">
        {BARS.map((h, i) => (
          <div
            key={i}
            className="flex-1 rounded-t-sm min-w-[12px]"
            style={{
              height: `${h}%`,
              backgroundColor: `rgba(79, 242, 255, ${0.15 + (h / 100) * 0.3})`,
            }}
          />
        ))}
      </div>

      {/* Top: status + primary stat */}
      <CardHeader className="relative z-10 px-8 pt-8 pb-0">
        <div className="flex items-start gap-3">
          <span
            className={`mt-2 size-3.5 shrink-0 rounded-full animate-pulse ${dot.color} ${dot.glow}`}
          />
          <div>
            <p className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Autonomy Status
            </p>
            <CardTitle className="font-headline text-2xl font-extrabold tracking-tight">
              {STATUS_LABELS[status.level]}
            </CardTitle>
            <CardDescription className="mt-1.5 max-w-xl text-[13px] leading-relaxed">
              {status.summary}
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <div className="text-right shrink-0">
            <p
              className="font-headline text-5xl font-extrabold text-primary leading-none"
              style={{ filter: "drop-shadow(0 0 8px rgba(79,242,255,0.3))" }}
            >
              {primaryStat.value}
            </p>
            <p className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground mt-1.5">
              {primaryStat.label}
            </p>
          </div>
        </CardAction>
      </CardHeader>

      {/* Spacer */}
      <div className="flex-1 min-h-6" />

      {/* Bottom: compact stat chips + CTAs */}
      <CardContent className="relative z-10 flex flex-col gap-5 px-8 pb-8 pt-0">
        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <div className="rounded-full border border-border/15 bg-black/15 px-3 py-1.5 backdrop-blur-sm text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
            <span className="font-headline text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
              Last Run
            </span>
            <span className="ml-2 font-medium text-foreground">
              {lastRun ? relativeTime(lastRun) : "Never"}
            </span>
          </div>
          <div className="rounded-full border border-border/15 bg-black/15 px-3 py-1.5 backdrop-blur-sm text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
            <span className="font-headline text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
              Skills
            </span>
            <span className="ml-2 font-medium text-foreground">{status.skills_observed}</span>
          </div>
          <div className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5 backdrop-blur-sm text-primary">
            <span className="font-headline text-[10px] uppercase tracking-[0.18em] text-primary/80">
              Pending
            </span>
            <span className="ml-2 font-semibold">{status.pending_reviews}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {status.attention_required > 0 ? (
            <Button size="sm" asChild>
              <a href="#supervision-feed">Review Attention Queue</a>
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">No action needed</span>
          )}
          <Button variant="outline" size="sm" asChild>
            <Link to="?action=evolve">Run Evolution</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Surface 2: Trust Rail
// ---------------------------------------------------------------------------

function TrustRail({ entries }: { entries: TrustWatchlistEntry[] }) {
  const buckets = useMemo(() => {
    const order: TrustBucket[] = ["at_risk", "improving", "uncertain", "stable"];
    const grouped: Record<TrustBucket, TrustWatchlistEntry[]> = {
      at_risk: [],
      improving: [],
      uncertain: [],
      stable: [],
    };
    for (const e of entries) grouped[e.bucket].push(e);
    return order
      .filter((b) => grouped[b].length > 0)
      .map((b) => ({ bucket: b, items: grouped[b] }));
  }, [entries]);

  return (
    <Card className="border-none bg-muted shadow-none py-0 max-h-[360px]">
      <CardHeader className="px-5 pt-5 pb-0">
        <div>
          <p className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Trust Watchlist
          </p>
          <CardDescription className="mt-1 text-[11px]">
            Highest-risk skills worth checking next.
          </CardDescription>
        </div>
        <CardAction>
          <span className="font-headline text-[10px] text-muted-foreground/60 shrink-0">
            {entries.length} skills
          </span>
        </CardAction>
      </CardHeader>

      {buckets.length === 0 ? (
        <CardContent className="flex flex-1 items-center justify-center px-5 py-4">
          <p className="text-xs text-muted-foreground">No skills tracked yet.</p>
        </CardContent>
      ) : (
        <CardContent className="themed-scroll space-y-3 overflow-y-auto min-h-0 flex-1 px-5 py-4">
          {buckets.map(({ bucket, items }) => (
            <RailBucket key={bucket} bucket={bucket} items={items} />
          ))}
        </CardContent>
      )}

      <CardContent className="mt-auto px-5 pb-5 pt-1 shrink-0">
        <Link to="/skills-library" className="text-xs text-primary hover:underline font-medium">
          View All Skills
        </Link>
      </CardContent>
    </Card>
  );
}

function RailBucket({ bucket, items }: { bucket: TrustBucket; items: TrustWatchlistEntry[] }) {
  const cfg = BUCKET_CFG[bucket];
  const [open, setOpen] = useState(false);
  const MAX = 5;
  const [showAll, setShowAll] = useState(false);
  const visible = open ? (showAll ? items : items.slice(0, MAX)) : [];

  return (
    <div className="rounded-xl bg-background/40 px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <span className={`size-1.5 shrink-0 rounded-full ${cfg.dot}`} />
        <ChevronDownIcon
          className={`size-3 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span className={`text-xs font-medium ${cfg.accent}`}>{cfg.label}</span>
        <span className="text-[10px] text-muted-foreground/60">({items.length})</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {visible.map((e) => (
            <div
              key={e.skill_name}
              className="rounded-lg px-2 py-1.5 transition-colors hover:bg-background/55"
            >
              <div className="flex items-baseline justify-between gap-2">
                <Link
                  to={`/skills/${encodeURIComponent(e.skill_name)}`}
                  className="text-[11px] font-medium hover:underline truncate"
                >
                  {e.skill_name}
                </Link>
                {e.pass_rate != null && (
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {Math.round(e.pass_rate * 100)}%
                  </span>
                )}
              </div>
              <p className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground/70">{e.reason}</p>
            </div>
          ))}
          {items.length > MAX && !showAll && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="pl-2 text-[10px] text-primary hover:underline"
            >
              +{items.length - MAX} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surface 3: Comparison Grid
// ---------------------------------------------------------------------------

function ComparisonGrid({
  skills,
  trustWatchlist,
  evolution,
}: {
  skills: SkillSummary[];
  trustWatchlist: TrustWatchlistEntry[];
  evolution: EvolutionEntry[];
}) {
  const trustBySkill = useMemo(
    () => new Map(trustWatchlist.map((entry) => [entry.skill_name, entry])),
    [trustWatchlist],
  );
  const [viewMode, setViewMode] = useState<"watched" | "all">("watched");
  const [watchlist, setWatchlist] = useState<string[]>(() => loadStoredWatchlist());
  const latestEvolutionBySkill = useMemo(() => {
    const map = new Map<string, EvolutionEntry>();
    for (const entry of evolution) {
      if (!entry.skill_name || map.has(entry.skill_name)) continue;
      map.set(entry.skill_name, entry);
    }
    return map;
  }, [evolution]);
  const effectiveWatchlist = useMemo(() => {
    const available = new Set(skills.map((skill) => skill.skill_name));
    const cleaned = watchlist.filter((skill) => available.has(skill));
    if (cleaned.length > 0) return cleaned;
    return deriveDefaultWatchlist(skills, trustWatchlist);
  }, [skills, trustWatchlist, watchlist]);

  const rows = useMemo(() => {
    const ordered = [...skills]
      .map((skill) => {
        const trust = trustBySkill.get(skill.skill_name);
        return {
          skill,
          trust,
          lastEvolution: latestEvolutionBySkill.get(skill.skill_name) ?? null,
        };
      })
      .sort((a, b) => {
        const aRank = a.trust
          ? ["at_risk", "improving", "uncertain", "stable"].indexOf(a.trust.bucket)
          : 4;
        const bRank = b.trust
          ? ["at_risk", "improving", "uncertain", "stable"].indexOf(b.trust.bucket)
          : 4;
        if (aRank !== bRank) return aRank - bRank;
        return (b.skill.last_seen ?? "").localeCompare(a.skill.last_seen ?? "");
      });
    if (viewMode === "all") return ordered;
    const watched = new Set(effectiveWatchlist);
    return ordered.filter((row) => watched.has(row.skill.skill_name));
  }, [effectiveWatchlist, latestEvolutionBySkill, skills, trustBySkill, viewMode]);

  const watchedCount = effectiveWatchlist.length;

  const toggleWatched = (skillName: string) => {
    setWatchlist((current) => {
      const next = current.includes(skillName)
        ? current.filter((name) => name !== skillName)
        : [...current, skillName];
      saveStoredWatchlist(next);
      return next;
    });
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
        <CardAction>
          <div className="flex items-center gap-3">
            <Tabs
              value={viewMode}
              onValueChange={(value) => setViewMode(value as "watched" | "all")}
            >
              <TabsList variant="line" className="h-auto gap-2">
                <TabsTrigger
                  value="watched"
                  className="font-headline text-[10px] uppercase tracking-[0.18em]"
                >
                  Watched
                  <span className="ml-1.5 text-muted-foreground">{watchedCount}</span>
                </TabsTrigger>
                <TabsTrigger
                  value="all"
                  className="font-headline text-[10px] uppercase tracking-[0.18em]"
                >
                  All Skills
                  <span className="ml-1.5 text-muted-foreground">{skills.length}</span>
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Link to="/skills-library" className="text-xs font-medium text-primary hover:underline">
              View library
            </Link>
          </div>
        </CardAction>
      </CardHeader>

      <CardContent className="themed-scroll overflow-x-auto px-5 py-5">
        <div className="min-w-[780px]">
          <div className="mb-3 rounded-xl bg-background/35 px-3 py-2 text-xs text-muted-foreground">
            {viewMode === "watched"
              ? "Your watched skills stay pinned here. Add or remove them directly from the grid."
              : "All installed skills, sorted by current trust priority."}
          </div>
          <div className="grid grid-cols-[minmax(220px,2.3fr)_0.95fr_1.1fr_0.9fr_1.3fr_1fr_0.9fr] gap-3 px-3 pb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <span>Skill</span>
            <span>Trigger Rate</span>
            <span>Routing Conf.</span>
            <span>Sessions</span>
            <span>Last Evolution</span>
            <span>Status</span>
            <span className="text-right">Watch</span>
          </div>
          <div className="space-y-1.5">
            {rows.map(({ skill, trust, lastEvolution }) => {
              const bucketCfg = trust ? BUCKET_CFG[trust.bucket] : BUCKET_CFG.uncertain;
              const triggerRate = trust?.pass_rate ?? skill.pass_rate;
              const isWatched = effectiveWatchlist.includes(skill.skill_name);
              return (
                <div
                  key={skill.skill_name}
                  className="grid grid-cols-[minmax(220px,2.3fr)_0.95fr_1.1fr_0.9fr_1.3fr_1fr_0.9fr] items-center gap-3 rounded-xl bg-background/35 px-3 py-3 text-sm transition-colors hover:bg-background/50"
                >
                  <Link
                    to={`/skills/${encodeURIComponent(skill.skill_name)}`}
                    className="contents focus-visible:outline-none"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{skill.skill_name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {(skill.skill_scope ?? "Unscoped") + ` · ${skill.total_checks} checks`}
                      </p>
                    </div>
                    <div className="font-medium">
                      {Number.isFinite(triggerRate)
                        ? `${Math.round((triggerRate ?? 0) * 100)}%`
                        : "—"}
                    </div>
                    <div className="min-w-0">
                      {skill.routing_confidence != null && skill.confidence_coverage >= 0.5 ? (
                        <>
                          <p className="text-sm font-medium">
                            {Math.round(skill.routing_confidence * 100)}%
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {Math.round(skill.confidence_coverage * 100)}% coverage
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm font-medium">—</p>
                          <p className="truncate text-xs text-muted-foreground">Low coverage</p>
                        </>
                      )}
                    </div>
                    <div className="text-muted-foreground">{skill.unique_sessions}</div>
                    <div className="min-w-0">
                      {lastEvolution ? (
                        <>
                          <p className="truncate text-sm">
                            {formatEvolutionAction(lastEvolution.action)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {relativeTime(lastEvolution.timestamp)}
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
                  </Link>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant={isWatched ? "secondary" : "ghost"}
                      size="sm"
                      className="h-8 gap-1.5 px-2 text-xs"
                      onClick={(event) => {
                        event.preventDefault();
                        toggleWatched(skill.skill_name);
                      }}
                    >
                      <EyeIcon className="size-3.5" />
                      {isWatched ? "Watching" : "Watch"}
                    </Button>
                  </div>
                </div>
              );
            })}
            {rows.length === 0 && (
              <div className="rounded-xl bg-background/30 px-3 py-6 text-sm text-muted-foreground">
                No watched skills yet. Switch to{" "}
                <span className="font-medium text-foreground">All Skills</span> and add the ones you
                want to track closely.
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Surface 4: Supervision Feed (merged attention + decisions)
// ---------------------------------------------------------------------------

function SupervisionFeed({
  attention,
  decisions,
}: {
  attention: AttentionItem[];
  decisions: AutonomousDecision[];
}) {
  return (
    <Card
      id="supervision-feed"
      className="relative overflow-hidden border-none bg-muted shadow-none py-0 scroll-mt-6"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-primary/5 via-transparent to-transparent" />
      <Tabs defaultValue="attention" className="gap-0">
        <CardHeader className="relative px-5 pt-4 pb-0">
          <div>
            <p className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Supervision Feed
            </p>
            <CardDescription className="mt-1 text-[13px]">
              What needs review and what selftune just decided.
            </CardDescription>
          </div>
          <TabsList variant="line" className="mt-3">
            <TabsTrigger
              value="attention"
              className="font-headline text-xs uppercase tracking-[0.15em]"
            >
              Attention Required
              {attention.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-[10px] py-0 px-1.5">
                  {attention.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="decisions"
              className="font-headline text-xs uppercase tracking-[0.15em]"
            >
              Recent Decisions
              {decisions.length > 0 && (
                <span className="ml-1.5 text-[10px] text-muted-foreground">{decisions.length}</span>
              )}
            </TabsTrigger>
          </TabsList>
        </CardHeader>

        <CardContent className="themed-scroll max-h-[440px] overflow-y-auto px-5 py-5">
          <TabsContent value="attention">
            <AttentionContent attention={attention} />
          </TabsContent>
          <TabsContent value="decisions">
            <DecisionsContent decisions={decisions} />
          </TabsContent>
        </CardContent>
      </Tabs>
    </Card>
  );
}

function AttentionContent({ attention }: { attention: AttentionItem[] }) {
  const [showAll, setShowAll] = useState(false);

  if (attention.length === 0) {
    return (
      <div className="flex items-center gap-3 py-4">
        <CheckCircleIcon className="size-5 text-emerald-400" />
        <p className="text-sm text-muted-foreground">Nothing needs your attention</p>
      </div>
    );
  }

  const flattened = attention.map((item) => ({ item, severity: item.severity }));
  const visible = showAll ? flattened : flattened.slice(0, 6);

  return (
    <div className="space-y-2">
      {visible.map(({ item, severity }) => {
        const sev = SEVERITY[severity];
        return (
          <Link
            key={`${item.skill_name}-${item.category}`}
            to={`/skills/${encodeURIComponent(item.skill_name)}`}
            className="flex items-start gap-3 rounded-xl bg-background/40 px-3 py-3 transition-colors hover:bg-background/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <span className={`mt-1.5 size-2 shrink-0 rounded-full ${sev.dot}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">{item.skill_name}</span>
                <Badge
                  variant="outline"
                  className={`text-[10px] font-normal ${sev.text} ${sev.bg} border-transparent`}
                >
                  {item.category.replace(/_/g, " ")}
                </Badge>
              </div>
              <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{item.reason}</p>
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground/60">
                {item.recommended_action}
              </p>
            </div>
            <span className="text-[10px] text-muted-foreground/50 shrink-0 mt-0.5">
              {item.timestamp ? relativeTime(item.timestamp) : ""}
            </span>
          </Link>
        );
      })}
      {flattened.length > 6 && !showAll && (
        <div className="pt-3">
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-xs text-primary hover:underline"
          >
            Show all {flattened.length} attention items
          </button>
        </div>
      )}
    </div>
  );
}

function DecisionsContent({ decisions }: { decisions: AutonomousDecision[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? decisions : decisions.slice(0, 10);

  if (decisions.length === 0) {
    return <p className="text-xs text-muted-foreground py-4">No autonomous decisions yet.</p>;
  }

  return (
    <div className="space-y-1">
      {visible.map((d, i) => {
        const marker = DECISION_MARKERS[d.kind];
        return (
          <Link
            key={`${d.timestamp}-${d.skill_name}-${i}`}
            to={`/skills/${encodeURIComponent(d.skill_name)}`}
            className="flex items-start gap-2.5 rounded-xl bg-background/30 px-3 py-2 transition-colors hover:bg-background/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <span className={`mt-1.5 size-2 shrink-0 rounded-full ${marker}`} />
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium truncate block">{d.skill_name}</span>
              <p className="line-clamp-2 text-xs text-muted-foreground">{d.summary}</p>
            </div>
            <span className="text-[10px] text-muted-foreground/50 shrink-0 mt-0.5">
              {relativeTime(d.timestamp)}
            </span>
          </Link>
        );
      })}
      {decisions.length > 10 && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-xs text-primary hover:underline mt-1 pl-2"
        >
          Show all ({decisions.length})
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Below-fold: Autonomy Loop Summary
// ---------------------------------------------------------------------------

function AutonomyLoopSummary({
  lastRun,
  deployed,
  evolved,
  watched,
  runCount,
}: {
  lastRun: string | null;
  deployed: number;
  evolved: number;
  watched: number;
  runCount: number;
}) {
  if (runCount === 0) return null;

  return (
    <div className="col-span-12 rounded-xl border border-border/10 bg-card/50 px-5 py-3 flex items-center gap-6 text-xs text-muted-foreground">
      <span className="font-headline text-[10px] uppercase tracking-[0.2em]">Last Cycle</span>
      <span>{lastRun ? relativeTime(lastRun) : "Never"}</span>
      <span className="text-muted-foreground/30">|</span>
      <span>{deployed} deployed</span>
      <span>{evolved} evolved</span>
      <span>{watched} watched</span>
      <span className="text-muted-foreground/30">|</span>
      <Link to="/analytics" className="text-primary hover:underline ml-auto">
        View full history
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview (main export)
// ---------------------------------------------------------------------------

export function Overview({
  search: _search,
  statusFilter: _statusFilter,
  onStatusFilterChange: _onStatusFilterChange,
  overviewQuery,
}: {
  search: string;
  statusFilter: SkillHealthStatus | "ALL";
  onStatusFilterChange: (v: SkillHealthStatus | "ALL") => void;
  overviewQuery: UseQueryResult<OverviewResponse>;
}) {
  const { data, isPending, isError, error, refetch } = overviewQuery;
  const orchestrateQuery = useOrchestrateRuns();

  if (isPending) {
    return (
      <div className="@container/main flex flex-1 flex-col gap-6 py-6 px-4 lg:px-6">
        <Skeleton className="h-[340px] rounded-xl" />
        <div className="grid grid-cols-12 gap-6">
          <Skeleton className="col-span-12 @4xl/main:col-span-8 h-64 rounded-xl" />
          <Skeleton className="col-span-12 @4xl/main:col-span-4 h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
        <AlertCircleIcon className="size-10 text-destructive" />
        <p className="text-sm font-medium text-destructive">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCwIcon className="mr-2 size-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16">
        <p className="text-sm text-muted-foreground">
          No telemetry data found. Run some sessions first.
        </p>
      </div>
    );
  }

  const { skills, autonomy_status, attention_queue, trust_watchlist, recent_decisions, overview } =
    data;

  // Orchestrate summary
  const orchRuns = orchestrateQuery.data?.runs ?? [];
  const latestRun = orchRuns[0];
  const totalDeployed = orchRuns.reduce((s, r) => s + r.deployed, 0);
  const totalEvolved = orchRuns.reduce((s, r) => s + r.evolved, 0);
  const totalWatched = orchRuns.reduce((s, r) => s + r.watched, 0);

  return (
    <div className="@container/main flex flex-1 flex-col py-6">
      <div className="grid grid-cols-12 gap-6 px-4 lg:px-6">
        <OnboardingBanner skillCount={skills.length} />

        {/* Row 1: Hero (8) + Trust Rail (4) — above the fold */}
        <div className="col-span-12 @4xl/main:col-span-8">
          <OverviewHero status={autonomy_status} lastRun={latestRun?.timestamp ?? null} />
        </div>
        <div className="col-span-12 @4xl/main:col-span-4 self-start">
          <TrustRail entries={trust_watchlist} />
        </div>

        {/* Row 2: Comparison grid */}
        <ComparisonGrid
          skills={skills}
          trustWatchlist={trust_watchlist}
          evolution={overview.evolution}
        />

        {/* Row 3: Supervision Feed (full width) — one merged surface */}
        <div className="col-span-12">
          <SupervisionFeed attention={attention_queue} decisions={recent_decisions} />
        </div>

        {/* Below fold: compact autonomy loop summary */}
        <AutonomyLoopSummary
          lastRun={latestRun?.timestamp ?? null}
          deployed={totalDeployed}
          evolved={totalEvolved}
          watched={totalWatched}
          runCount={orchRuns.length}
        />
      </div>
    </div>
  );
}
