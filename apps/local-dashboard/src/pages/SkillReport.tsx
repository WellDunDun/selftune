import { EvolutionTimeline } from "@selftune/ui/components";
import { EvidenceViewer } from "@selftune/ui/components";
import { InfoTip } from "@selftune/ui/components";
import { timeAgo } from "@selftune/ui/lib";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@selftune/ui/primitives";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  EyeIcon,
  RefreshCwIcon,
  ChevronRightIcon,
  ShieldCheckIcon,
  ShieldAlertIcon,
  ShieldIcon,
  ShieldQuestionIcon,
  SearchIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
  ArrowRightIcon,
  GitBranchIcon,
  FilterIcon,
  ChevronDownIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import {
  DataQualityPanel,
  observationBadge,
  PromptEvidencePanel,
  SkillReportTopRow,
  SkillTrustNarrativePanel,
  TrustSignalsGrid,
} from "@/components/skill-report-panels";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useSkillReport } from "@/hooks/useSkillReport";
import type { TrustState } from "@/types";

type ObservationKind =
  | "canonical"
  | "repaired_trigger"
  | "repaired_contextual_miss"
  | "legacy_materialized";

const SKILL_REPORT_ONBOARDING_KEY = "selftune.skill-report-onboarding-dismissed";

function SkillReportGuideSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
        <SheetHeader className="space-y-2 border-b border-border/10 pb-4">
          <SheetTitle>How to read this page</SheetTitle>
          <SheetDescription>
            selftune earns trust by showing what it observed, what it proposed, how it tested the
            change, and what happened next.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 p-4">
          <div className="space-y-3">
            <h3 className="font-headline text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              The improvement loop
            </h3>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                <strong className="text-foreground">1. Observe.</strong> selftune watches real
                sessions and notes when a skill triggered, missed, or looked noisy.
              </p>
              <p>
                <strong className="text-foreground">2. Propose.</strong> when the signal is strong
                enough, it suggests a wording change to the skill.
              </p>
              <p>
                <strong className="text-foreground">3. Validate.</strong> it checks whether the new
                wording improves routing without breaking important cases.
              </p>
              <p>
                <strong className="text-foreground">4. Decide.</strong> only validated winners
                should be deployed. Rejected or pending proposals do not change the live skill.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="font-headline text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              What each section means
            </h3>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                <strong className="text-foreground">Next Best Action</strong> tells you whether you
                should review, deploy, or simply keep observing.
              </p>
              <p>
                <strong className="text-foreground">How selftune is improving this skill</strong>{" "}
                explains the current state in plain language.
              </p>
              <p>
                <strong className="text-foreground">Trust Signals</strong> are the condensed metrics
                behind that story: coverage, evidence quality, routing quality, and evolution state.
              </p>
              <p>
                <strong className="text-foreground">Evidence</strong> shows what changed and why a
                proposal was accepted, rejected, or left pending.
              </p>
              <p>
                <strong className="text-foreground">Invocations</strong> shows real prompts where
                this skill triggered or likely should have triggered.
              </p>
              <p>
                <strong className="text-foreground">Data Quality</strong> tells you how trustworthy
                the underlying telemetry is.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="font-headline text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              FAQ
            </h3>
            <div className="space-y-4 text-sm text-muted-foreground">
              <div>
                <p className="font-medium text-foreground">What is a missed trigger?</p>
                <p>
                  A case where selftune believes the skill should have been used, but the agent did
                  not invoke it.
                </p>
              </div>
              <div>
                <p className="font-medium text-foreground">Why was a proposal rejected?</p>
                <p>
                  Usually because validation showed the new wording would regress existing behavior,
                  or because it violated a hard rule like dropping an important anchor phrase.
                </p>
              </div>
              <div>
                <p className="font-medium text-foreground">When should I trust a recommendation?</p>
                <p>
                  Trust it more when the page shows broad coverage, prompt-linked evidence, and a
                  validated result. Trust it less when the sample is tiny or the data is noisy.
                </p>
              </div>
              <div>
                <p className="font-medium text-foreground">Do I need to understand every metric?</p>
                <p>
                  No. Start with the plain-English summary and next best action. Use the deeper tabs
                  only when you want to inspect the evidence yourself.
                </p>
              </div>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ─── Trust badge config ──────────────────────────────── */

const TRUST_BADGE: Record<
  TrustState,
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
    icon: React.ReactNode;
  }
> = {
  low_sample: {
    label: "Low Sample",
    variant: "secondary",
    icon: <ShieldQuestionIcon className="size-3" />,
  },
  observed: {
    label: "Observed",
    variant: "outline",
    icon: <EyeIcon className="size-3" />,
  },
  watch: {
    label: "Watch",
    variant: "secondary",
    icon: <ShieldAlertIcon className="size-3" />,
  },
  validated: {
    label: "Validated",
    variant: "default",
    icon: <ShieldCheckIcon className="size-3" />,
  },
  deployed: {
    label: "Deployed",
    variant: "default",
    icon: <ShieldCheckIcon className="size-3" />,
  },
  rolled_back: {
    label: "Rolled Back",
    variant: "destructive",
    icon: <ShieldIcon className="size-3" />,
  },
};

/* ─── Session group (kept from V1) ────────────────────── */

function SessionGroup({
  sessionId,
  meta,
  invocations,
  defaultExpanded,
}: {
  sessionId: string;
  meta?:
    | {
        started_at?: string | null;
        model?: string | null;
        workspace_path?: string | null;
        platform?: string | null;
        agent_cli?: string | null;
      }
    | undefined;
  invocations: Array<{
    timestamp: string | null;
    session_id: string | null;
    triggered: boolean;
    query: string;
    invocation_mode: string | null;
    confidence: number | null;
    tool_name: string | null;
    agent_type: string | null;
    observation_kind?: ObservationKind | null;
  }>;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const ts = meta?.started_at ?? invocations[0]?.timestamp;
  const modeBreakdown = invocations.reduce(
    (acc, inv) => {
      const mode = inv.invocation_mode ?? "unknown";
      acc[mode] = (acc[mode] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const formatInvoker = (inv: (typeof invocations)[number]): { label: string; hint: string } => {
    const cli = meta?.agent_cli?.replace(/_/g, " ");
    const platform = meta?.platform?.replace(/_/g, " ");

    if (inv.agent_type && inv.agent_type !== "main") {
      return {
        label: inv.agent_type,
        hint: cli ? `${cli} subagent` : "subagent invocation",
      };
    }

    if (cli) {
      return {
        label: cli,
        hint:
          inv.agent_type === "main"
            ? "main agent invocation"
            : "session agent that invoked the skill",
      };
    }

    if (platform) {
      return {
        label: platform,
        hint: inv.agent_type === "main" ? "main agent invocation" : "session platform",
      };
    }

    if (inv.agent_type) {
      return {
        label: inv.agent_type,
        hint: "recorded subagent type",
      };
    }

    return {
      label: "No data",
      hint: "invoker was not captured in this record",
    };
  };

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden transition-colors">
      {/* Session header -- always visible */}
      <button
        type="button"
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 active:bg-muted/60 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRightIcon
          className={`size-3.5 text-muted-foreground shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              {invocations.length} invocation{invocations.length !== 1 ? "s" : ""}
            </span>
            <span className="text-xs text-muted-foreground">{ts ? timeAgo(ts) : ""}</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {meta?.model && (
              <Badge variant="secondary" className="text-[10px] font-normal">
                {meta.model}
              </Badge>
            )}
            {meta?.workspace_path && (
              <span
                className="text-[11px] text-muted-foreground font-mono"
                title={meta.workspace_path}
              >
                {meta.workspace_path.split("/").slice(-2).join("/")}
              </span>
            )}
          </div>
        </div>
        {/* Compact mode summary when collapsed */}
        {!expanded && (
          <div className="flex items-center gap-1 shrink-0">
            {Object.entries(modeBreakdown).map(([mode, count]) => (
              <Badge key={mode} variant="outline" className="text-[10px] font-normal gap-1">
                {mode} <span className="text-muted-foreground">{count}</span>
              </Badge>
            ))}
          </div>
        )}
        <span className="text-[10px] text-muted-foreground/40 font-mono shrink-0">
          {sessionId.substring(0, 8)}
        </span>
      </button>

      {/* Invocation table -- expanded */}
      {expanded && (
        <div className="border-t border-border/40 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent bg-muted/40">
                <TableHead className="font-headline text-[10px] uppercase tracking-[0.15em] h-8">
                  Prompt <InfoTip text="The user prompt that led to this skill being invoked" />
                </TableHead>
                <TableHead className="font-headline text-[10px] uppercase tracking-[0.15em] h-8 w-[90px]">
                  Mode{" "}
                  <InfoTip text="explicit = user typed /skillname; implicit = user mentioned skill by name; inferred = agent chose skill autonomously" />
                </TableHead>
                <TableHead className="font-headline text-[10px] uppercase tracking-[0.15em] h-8 w-[70px]">
                  Confidence{" "}
                  <InfoTip text="Model's confidence score (0-100%) when routing this prompt to the skill" />
                </TableHead>
                <TableHead className="font-headline text-[10px] uppercase tracking-[0.15em] h-8 w-[110px]">
                  Invoker{" "}
                  <InfoTip text="Who invoked the skill. Prefers subagent type when present, otherwise falls back to the session agent or platform." />
                </TableHead>
                <TableHead className="font-headline text-[10px] uppercase tracking-[0.15em] h-8 w-[120px]">
                  Evidence
                </TableHead>
                <TableHead className="font-headline text-[10px] uppercase tracking-[0.15em] h-8 w-[70px] text-right">
                  Time
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invocations.map((inv, i) => (
                <TableRow key={i} className={!inv.triggered ? "bg-destructive/5" : ""}>
                  <TableCell
                    className="max-w-[500px] truncate text-sm py-2"
                    title={inv.query || undefined}
                  >
                    {inv.query || (
                      <span className="text-muted-foreground/40 italic">No prompt recorded</span>
                    )}
                    {!inv.triggered && (
                      <Badge variant="destructive" className="text-[10px] font-normal ml-2">
                        missed
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="py-2">
                    {inv.invocation_mode ? (
                      <Badge variant="secondary" className="text-[10px] font-normal">
                        {inv.invocation_mode}
                      </Badge>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">Unknown mode</span>
                    )}
                  </TableCell>
                  <TableCell className="py-2 font-mono text-xs text-muted-foreground tabular-nums">
                    {inv.confidence !== null
                      ? `${Math.round(inv.confidence * 100)}%`
                      : "Not recorded"}
                  </TableCell>
                  <TableCell className="py-2">
                    {(() => {
                      const invoker = formatInvoker(inv);
                      return invoker.label === "No data" ? (
                        <span className="text-[11px] text-muted-foreground" title={invoker.hint}>
                          {invoker.label}
                        </span>
                      ) : (
                        <Badge
                          variant={
                            inv.agent_type && inv.agent_type !== "main" ? "outline" : "secondary"
                          }
                          className="text-[10px] font-normal capitalize"
                          title={invoker.hint}
                        >
                          {invoker.label}
                        </Badge>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="py-2">
                    {(() => {
                      const observation = observationBadge(inv.observation_kind);
                      return observation ? (
                        <Badge variant={observation.variant} className="text-[10px] font-normal">
                          {observation.label}
                        </Badge>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">canonical</span>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="py-2 font-mono text-[11px] text-muted-foreground text-right whitespace-nowrap">
                    {inv.timestamp ? timeAgo(inv.timestamp) : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/* ─── Invocation filter type ──────────────────────────── */

type InvocationFilter = "all" | "misses" | "low_confidence" | "system_meta";

/* ─── Next best action logic ──────────────────────────── */

function deriveNextAction(
  trustState: TrustState,
  missRate: number | null | undefined,
  systemLikeRate: number | null | undefined,
  hasPendingProposals: boolean,
  _hasEvolution: boolean,
): {
  icon: React.ReactNode;
  text: string;
  actionLabel: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  if (trustState === "low_sample") {
    return {
      icon: <EyeIcon className="size-5" />,
      text: "Keep observing. This skill needs more sessions before trust can be assessed.",
      actionLabel: "Keep observing",
      variant: "secondary",
    };
  }
  if (trustState === "rolled_back") {
    return {
      icon: <AlertTriangleIcon className="size-5 text-destructive" />,
      text: "Inspect rollback evidence before re-deploying.",
      actionLabel: "Inspect rollback",
      variant: "destructive",
    };
  }
  if (trustState === "watch" && (systemLikeRate ?? 0) > 0.05) {
    return {
      icon: <AlertTriangleIcon className="size-5 text-amber-500" />,
      text: "Clean source-truth data or routing data before trusting this report.",
      actionLabel: "Clean data",
      variant: "secondary",
    };
  }
  if (trustState === "watch" && (missRate ?? 0) > 0) {
    return {
      icon: <SearchIcon className="size-5 text-amber-500" />,
      text: "Generate evals to investigate missed triggers.",
      actionLabel: "Generate evals",
      variant: "secondary",
    };
  }
  if (trustState === "watch") {
    return {
      icon: <EyeIcon className="size-5 text-amber-500" />,
      text: "This skill is under active observation. Review recent invocations to verify routing accuracy.",
      actionLabel: "Review invocations",
      variant: "secondary",
    };
  }
  if (hasPendingProposals) {
    return {
      icon: <GitBranchIcon className="size-5 text-primary" />,
      text: "Review pending proposal.",
      actionLabel: "Review proposal",
      variant: "default",
    };
  }
  if (trustState === "validated") {
    return {
      icon: <ArrowRightIcon className="size-5 text-primary" />,
      text: "Deploy the validated candidate.",
      actionLabel: "Deploy candidate",
      variant: "default",
    };
  }
  if (trustState === "observed" || trustState === "deployed") {
    return {
      icon: <CheckCircleIcon className="size-5 text-green-500" />,
      text: "No action needed. Skill is healthy and being monitored.",
      actionLabel: "Healthy",
      variant: "outline",
    };
  }
  return {
    icon: <EyeIcon className="size-5" />,
    text: "Continue monitoring this skill.",
    actionLabel: "Monitor",
    variant: "outline",
  };
}

/* ─── Collapsible timeline sidebar ────────────────────── */

function TimelineSidebar({
  evolution,
  activeProposal,
  onSelect,
}: {
  evolution: Array<{ proposal_id: string; action: string; timestamp: string }>;
  activeProposal: string | null;
  onSelect: (proposalId: string) => void;
}) {
  const collapsedProposalCount = 6;
  const proposalCount = new Set(evolution.map((entry) => entry.proposal_id)).size;
  const shouldCollapse = proposalCount > collapsedProposalCount;
  const [expanded, setExpanded] = useState(!shouldCollapse);

  const visibleEntries = useMemo(() => {
    if (expanded) return evolution;

    const allowed = new Set<string>();
    const collapsed: typeof evolution = [];
    for (const entry of evolution) {
      if (!allowed.has(entry.proposal_id)) {
        if (allowed.size >= collapsedProposalCount) continue;
        allowed.add(entry.proposal_id);
      }
      collapsed.push(entry);
    }
    return collapsed;
  }, [collapsedProposalCount, evolution, expanded]);

  return (
    <aside className="w-full px-4 py-4 @5xl/main:w-[252px] @5xl/main:self-start @5xl/main:pr-0">
      <div className="@5xl/main:sticky @5xl/main:top-16">
        <div
          className={`rounded-xl border border-border/10 bg-muted/20 px-3 py-3 text-xs ${expanded ? "themed-scroll max-h-[26rem] overflow-y-auto @5xl/main:max-h-[calc(100svh-6rem)]" : "overflow-visible"}`}
        >
          <EvolutionTimeline
            entries={visibleEntries}
            selectedProposalId={activeProposal}
            onSelect={onSelect}
          />
          {shouldCollapse && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="mt-2 flex w-full items-center justify-center gap-1.5 py-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDownIcon
                className={`size-3 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
              />
              {expanded ? "Collapse timeline" : `Show full timeline (${proposalCount} proposals)`}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/* ═══════════════════════════════════════════════════════════
   SkillReport — trust-first skill report page
   ═══════════════════════════════════════════════════════════ */

export function SkillReport() {
  const { name } = useParams<{ name: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, isPending, isError, error, refetch } = useSkillReport(name);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(true);

  // Invocation filter state
  const [invocationFilter, setInvocationFilter] = useState<InvocationFilter>("all");

  // Derive proposal state from data (safe to compute even when data is null)
  const evolution = data?.evolution ?? [];
  const proposalIds = new Set(evolution.map((entry) => entry.proposal_id));
  const requestedProposal = searchParams.get("proposal");
  const activeProposal =
    requestedProposal && proposalIds.has(requestedProposal)
      ? requestedProposal
      : evolution.length > 0
        ? evolution[0].proposal_id
        : null;

  // All hooks must be called unconditionally -- before any early returns
  useEffect(() => {
    const current = searchParams.get("proposal");
    if (activeProposal && current !== activeProposal) {
      const next = new URLSearchParams(searchParams);
      next.set("proposal", activeProposal);
      setSearchParams(next, { replace: true });
      return;
    }
    if (!activeProposal && current) {
      const next = new URLSearchParams(searchParams);
      next.delete("proposal");
      setSearchParams(next, { replace: true });
    }
  }, [activeProposal, searchParams, setSearchParams]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const dismissed = window.localStorage.getItem(SKILL_REPORT_ONBOARDING_KEY) === "1";
    if (dismissed) setShowOnboarding(false);
  }, []);

  const handleSelectProposal = (proposalId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("proposal", proposalId);
    setSearchParams(next, { replace: true });
  };

  const dismissOnboarding = () => {
    setShowOnboarding(false);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SKILL_REPORT_ONBOARDING_KEY, "1");
    }
  };

  // Trust fields from extended SkillReportResponse
  const trust = data?.trust;
  const coverage = data?.coverage;
  const evidenceQuality = data?.evidence_quality;
  const routingQuality = data?.routing_quality;
  const evolutionState = data?.evolution_state;
  const dataHygiene = data?.data_hygiene;
  const examples = data?.examples;

  // Filtered invocations for the invocations tab
  const mergedInvocations = useMemo(() => {
    const invs = (data?.canonical_invocations ?? []).map((ci) => ({
      timestamp: ci.timestamp || ci.occurred_at || null,
      session_id: ci.session_id,
      triggered: ci.triggered,
      query: ci.query ?? "",
      source: ci.source ?? "",
      invocation_mode: ci.invocation_mode ?? null,
      confidence: ci.confidence ?? null,
      tool_name: ci.tool_name ?? null,
      agent_type: ci.agent_type ?? null,
      observation_kind: ci.observation_kind ?? "canonical",
    }));
    invs.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
    return invs;
  }, [data?.canonical_invocations]);

  const filteredInvocations = useMemo(() => {
    switch (invocationFilter) {
      case "misses":
        return mergedInvocations.filter((i) => !i.triggered);
      case "low_confidence":
        return mergedInvocations.filter((i) => i.confidence !== null && i.confidence < 0.5);
      case "system_meta":
        return mergedInvocations.filter(
          (i) => i.invocation_mode === "system" || i.invocation_mode === "meta",
        );
      default:
        return mergedInvocations;
    }
  }, [mergedInvocations, invocationFilter]);

  const sessionMetaMap = useMemo(
    () => new Map((data?.session_metadata ?? []).map((s) => [s.session_id, s])),
    [data?.session_metadata],
  );

  const groupedSessions = useMemo(() => {
    const sessionMap = new Map<string, typeof filteredInvocations>();
    for (const inv of filteredInvocations) {
      const sid = inv.session_id ?? "unknown";
      const arr = sessionMap.get(sid);
      if (arr) arr.push(inv);
      else sessionMap.set(sid, [inv]);
    }
    return [...sessionMap.entries()].sort(([, a], [, b]) =>
      (b[0]?.timestamp ?? "").localeCompare(a[0]?.timestamp ?? ""),
    );
  }, [filteredInvocations]);

  /* ─── Early returns ─────────────────────────────────── */

  if (!name) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <p className="text-sm text-destructive">No skill name provided</p>
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="@container/main flex flex-1 flex-col gap-6 p-4 lg:p-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-20 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
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
      <div className="flex flex-1 items-center justify-center py-16">
        <p className="text-sm text-muted-foreground">No data yet</p>
      </div>
    );
  }

  const isNotFound =
    (coverage?.checks ?? data.usage.total_checks) === 0 &&
    data.evidence.length === 0 &&
    data.evolution.length === 0 &&
    (data.canonical_invocations?.length ?? 0) === 0;

  if (isNotFound) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
        <p className="text-sm text-muted-foreground">No data found for skill "{name}".</p>
        <Button variant="outline" size="sm" render={<Link to="/" />}>
          <ArrowLeftIcon className="mr-2 size-3.5" />
          Back to Overview
        </Button>
      </div>
    );
  }

  const trustState = trust?.state ?? "low_sample";
  const trustBadge = TRUST_BADGE[trustState];
  const hasEvolutionData = (evolutionState?.evolution_rows ?? evolution.length) > 0;

  const defaultTab = hasEvolutionData ? "evidence" : "invocations";

  const nextAction = deriveNextAction(
    trustState,
    routingQuality?.miss_rate,
    evidenceQuality?.system_like_rate,
    evolutionState?.has_pending_proposals ?? data.pending_proposals.length > 0,
    hasEvolutionData,
  );

  return (
    <Tabs defaultValue={defaultTab}>
      <SkillReportGuideSheet open={isGuideOpen} onOpenChange={setIsGuideOpen} />
      <div className="@container/main flex flex-1 flex-col gap-5 p-4 lg:px-6 lg:pb-6 lg:pt-0">
        {/* ─── 1. Trust Header (sticky) ───────────────── */}
        <div className="sticky top-0 z-30 space-y-2 border-b border-border/15 bg-background/95 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" render={<Link to="/" />} className="shrink-0">
              <ArrowLeftIcon className="size-3.5" />
            </Button>
            <h1 className="text-base font-semibold tracking-tight lg:text-lg font-headline shrink-0">
              {data.skill_name}
            </h1>
            <Badge variant={trustBadge.variant} className="gap-1 shrink-0 text-[10px]">
              {trustBadge.icon}
              {trustBadge.label}
            </Badge>
            <div className="ml-auto flex items-center gap-4 shrink-0">
              <Button variant="outline" size="sm" onClick={() => setIsGuideOpen(true)}>
                How this works
              </Button>
              <div className="hidden @xl/main:flex items-center gap-3 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  <strong className="text-foreground">
                    {coverage?.checks ?? data.usage.total_checks}
                  </strong>{" "}
                  checks
                </span>
                <span className="text-border">|</span>
                <span className="tabular-nums">
                  <strong className="text-foreground">
                    {coverage?.sessions ?? data.sessions_with_skill}
                  </strong>{" "}
                  sessions
                </span>
                <span className="text-border">|</span>
                <span className="tabular-nums">
                  <strong className="text-foreground">{coverage?.workspaces ?? "No data"}</strong>{" "}
                  workspaces
                </span>
              </div>
              {(coverage?.first_seen || coverage?.last_seen) && (
                <div className="hidden @3xl/main:flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
                  {coverage.first_seen && (
                    <span title="First seen">{timeAgo(coverage.first_seen)}</span>
                  )}
                  {coverage.first_seen && coverage.last_seen && <span>-</span>}
                  {coverage.last_seen && (
                    <span title="Last seen">{timeAgo(coverage.last_seen)}</span>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* Trust summary -- full-width line */}
          {trust?.summary && (
            <div className="flex items-center gap-3 text-sm leading-relaxed text-muted-foreground">
              <span>{trust.summary}</span>
              {evolutionState?.latest_action && evolutionState?.latest_timestamp && (
                <span className="text-[11px] text-muted-foreground/70 font-mono">
                  Latest: {evolutionState.latest_action} ({timeAgo(evolutionState.latest_timestamp)}
                  )
                </span>
              )}
            </div>
          )}
        </div>

        {showOnboarding && (
          <Card className="rounded-xl border border-primary/15 bg-primary/5">
            <CardHeader className="gap-2 px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="text-base">New to selftune?</CardTitle>
                  <CardDescription>
                    This page tells a simple story: what selftune observed, what it proposed, how it
                    tested the change, and whether anything is safe to deploy.
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setIsGuideOpen(true)}>
                    Open guide
                  </Button>
                  <Button variant="ghost" size="sm" onClick={dismissOnboarding}>
                    Hide
                  </Button>
                </div>
              </div>
            </CardHeader>
          </Card>
        )}

        <div className="space-y-4">
          <SkillReportTopRow
            nextAction={nextAction}
            latestDecision={
              hasEvolutionData && evolutionState?.latest_action
                ? {
                    action: evolutionState.latest_action,
                    timestamp: evolutionState.latest_timestamp,
                    evolutionCount: evolutionState.evolution_rows ?? evolution.length,
                  }
                : undefined
            }
          />

          <SkillTrustNarrativePanel
            trustState={trustState}
            coverage={coverage}
            evidenceQuality={evidenceQuality}
            routingQuality={routingQuality}
            evolutionState={evolutionState}
            fallbackChecks={data.usage.total_checks}
            fallbackSessions={data.sessions_with_skill}
            nextActionText={nextAction.text}
            onOpenGuide={() => setIsGuideOpen(true)}
          />

          <TrustSignalsGrid
            coverage={coverage}
            evidenceQuality={evidenceQuality}
            routingQuality={routingQuality}
            evolutionState={evolutionState}
            fallbackChecks={data.usage.total_checks}
            fallbackSessions={data.sessions_with_skill}
            fallbackEvidenceRows={data.evidence.length}
            fallbackEvolutionRows={evolution.length}
            fallbackLatestAction={evolution[0]?.action}
          />
        </div>
        <div className="space-y-4 border-t border-border/10 pt-4">
          <TabsList
            variant="line"
            className="rounded-xl border border-border/10 bg-muted/20 px-1.5 py-1"
          >
            {hasEvolutionData && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <TabsTrigger
                      value="evidence"
                      className="rounded-lg px-3 font-headline text-xs uppercase tracking-wider data-active:bg-background/70 data-active:text-foreground"
                    />
                  }
                >
                  Evidence
                </TooltipTrigger>
                <TooltipContent>Change history and validation results</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <TabsTrigger
                    value="invocations"
                    className="rounded-lg px-3 font-headline text-xs uppercase tracking-wider data-active:bg-background/70 data-active:text-foreground"
                  />
                }
              >
                Invocations
                <Badge variant="secondary" className="ml-1.5 text-[10px]">
                  {mergedInvocations.length}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Recent skill triggers and their outcomes</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <TabsTrigger
                    value="data-quality"
                    className="rounded-lg px-3 font-headline text-xs uppercase tracking-wider data-active:bg-background/70 data-active:text-foreground"
                  />
                }
              >
                Data Quality
              </TooltipTrigger>
              <TooltipContent>Evidence quality metrics and data hygiene</TooltipContent>
            </Tooltip>
          </TabsList>

          {/* ─── Evidence Tab ─────────────────────────── */}
          {hasEvolutionData && (
            <TabsContent value="evidence" className="space-y-6">
              <PromptEvidencePanel examples={examples} />

              <div className="overflow-hidden rounded-2xl border border-border/15 bg-card">
                <div className="flex flex-col @5xl/main:grid @5xl/main:grid-cols-[252px_minmax(0,1fr)] @5xl/main:items-start">
                  {evolution.length > 0 && (
                    <TimelineSidebar
                      evolution={evolution}
                      activeProposal={activeProposal}
                      onSelect={handleSelectProposal}
                    />
                  )}

                  <div className="min-w-0 p-4 @xl/main:p-5">
                    {activeProposal ? (
                      <EvidenceViewer
                        proposalId={activeProposal}
                        evolution={evolution}
                        evidence={data.evidence}
                        showContextBanner={false}
                      />
                    ) : (
                      <Card className="rounded-2xl">
                        <CardContent className="py-12">
                          <div className="flex flex-col items-center justify-center gap-3 text-center">
                            <EyeIcon className="size-8 text-muted-foreground/40" />
                            <p className="text-sm text-muted-foreground">
                              This skill is being observed but has no reviewable evolution evidence
                              yet.
                            </p>
                          </div>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                </div>
              </div>
            </TabsContent>
          )}

          {/* ─── Invocations Tab ─────────────────────── */}
          <TabsContent value="invocations">
            {mergedInvocations.length === 0 ? (
              <Card className="rounded-2xl">
                <CardContent className="py-12">
                  <p className="text-sm text-muted-foreground text-center">
                    No invocation records yet.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                {/* Filters */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <FilterIcon className="size-3.5 text-muted-foreground" />
                    {(
                      [
                        ["all", "All"],
                        ["misses", "Misses"],
                        ["low_confidence", "Low confidence"],
                        ["system_meta", "System/meta"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setInvocationFilter(key)}
                        className="inline-block"
                      >
                        <Badge
                          variant={invocationFilter === key ? "default" : "outline"}
                          className="text-[10px] cursor-pointer"
                        >
                          {label}
                        </Badge>
                      </button>
                    ))}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {filteredInvocations.length} invocations across {groupedSessions.length}{" "}
                    sessions
                  </span>
                </div>

                {/* Legend */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-muted-foreground/70" />
                    explicit = user typed /skill
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-muted-foreground/70" />
                    implicit = mentioned by name
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-muted-foreground/70" />
                    inferred = agent chose autonomously
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-destructive/70" />
                    repaired miss = transcript showed skill read without invocation
                  </span>
                </div>

                {groupedSessions.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                    No invocations match this filter.
                  </div>
                ) : (
                  groupedSessions.map(([sessionId, invocations], idx) => {
                    const meta = sessionMetaMap.get(sessionId);
                    return (
                      <SessionGroup
                        key={sessionId}
                        sessionId={sessionId}
                        meta={meta}
                        invocations={invocations}
                        defaultExpanded={idx < 3}
                      />
                    );
                  })
                )}
              </div>
            )}
          </TabsContent>

          {/* ─── Data Quality Tab ────────────────────── */}
          <TabsContent value="data-quality">
            <DataQualityPanel evidenceQuality={evidenceQuality} dataHygiene={dataHygiene} />
          </TabsContent>
        </div>
      </div>
    </Tabs>
  );
}
