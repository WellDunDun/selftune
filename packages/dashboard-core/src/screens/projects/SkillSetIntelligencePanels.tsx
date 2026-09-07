"use client";

import { useState } from "react";
import {
  ChartNoAxesCombinedIcon,
  ChevronRightIcon,
  RefreshCwIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";

import type { DashboardProjectsActions, DashboardProjectsIntelligenceQueryState } from "../../host";
import type {
  ProjectCatalogSkillSetExpansionModel,
  ProjectSkillExecutionPatternModel,
  ProjectSkillTraceSignalModel,
  ProjectSkillSetOutcomeMetricId,
  ProjectSkillSetSuggestionModel,
  ProjectSkillSetSuggestionReviewReasonCode,
  ProjectTraceCandidateReviewModel,
} from "../../models";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
} from "@selftune/ui/primitives";

const PATTERN_LABELS = {
  workflow: "Ordered workflow",
  co_usage: "Used together",
  project: "Project pattern",
} satisfies Record<ProjectSkillSetSuggestionModel["pattern"], string>;

const EVIDENCE_LABELS = {
  exploratory: "Exploratory",
  supported: "Supported",
  validated: "Validated",
} satisfies Record<ProjectSkillSetSuggestionModel["evidenceState"], string>;

const DISMISSAL_LABELS = {
  not_relevant_now: "Not relevant right now",
  skills_should_remain_separate: "These skills should stay separate",
  not_a_real_pattern: "This isn't a real pattern",
  already_have_workflow: "I already have this workflow",
  other: "Other",
} satisfies Record<
  Exclude<
    ProjectSkillSetSuggestionReviewReasonCode,
    "accepted_as_suggested" | "edited_before_creation"
  >,
  string
>;

type DismissalReasonCode = keyof typeof DISMISSAL_LABELS;

function isDismissalReasonCode(value: string): value is DismissalReasonCode {
  return Object.hasOwn(DISMISSAL_LABELS, value);
}

const OUTCOME_METRICS: Array<{
  id: ProjectSkillSetOutcomeMetricId;
  label: string;
  percent: boolean;
}> = [
  { id: "completionQuality", label: "Completion", percent: true },
  { id: "errorRate", label: "Errors", percent: false },
  { id: "triggerCoverage", label: "Coverage", percent: true },
  { id: "tokenCost", label: "Tokens", percent: false },
  { id: "grading", label: "Grading", percent: true },
];

function metricValue(value: number | null, percent: boolean): string {
  if (value === null) return "—";
  return percent ? `${Math.round(value * 100)}%` : Math.round(value).toLocaleString();
}

function sourceLabel(sourceId: string): string {
  return sourceId
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "");
}

function coverageLabel(suggestion: ProjectSkillSetSuggestionModel): string | null {
  if (suggestion.pattern !== "co_usage") return null;
  const discovery = suggestion.discoveryEdgeCoverage;
  const heldOut = suggestion.heldOutEdgeCoverage;
  if (discovery === null) {
    if (heldOut === null) return "Relationship coverage is not available yet.";
    return `${Math.round(heldOut * 100)}% of member relationships held up in newer sessions.`;
  }
  if (heldOut === null) {
    return `${Math.round(discovery * 100)}% of member relationships appeared in older sessions; awaiting newer-session validation.`;
  }
  return `${Math.round(discovery * 100)}% of member relationships appeared in older sessions; ${Math.round(heldOut * 100)}% held up in newer sessions.`;
}

function SuggestionMembers({ suggestion }: { suggestion: ProjectSkillSetSuggestionModel }) {
  return (
    <ul className="mt-4 divide-y border-y" aria-label={`${suggestion.name} skill membership`}>
      {suggestion.skills.map((skill) => (
        <li
          key={skill.packagePath}
          className="grid gap-2 py-3 md:grid-cols-[minmax(9rem,0.8fr)_minmax(0,1.2fr)] md:items-center md:gap-4"
        >
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-sm font-medium">{skill.name}</p>
              <Badge variant="outline" className="shrink-0 font-normal tabular-nums">
                {Math.round(skill.membershipScore * 100)}%
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {skill.sourceId ? `Source: ${sourceLabel(skill.sourceId)}` : "Source not tracked"}
            </p>
          </div>
          <p className="text-sm text-muted-foreground">{skill.role}</p>
        </li>
      ))}
    </ul>
  );
}

function CatalogExpansionMembers({
  expansion,
}: {
  expansion: ProjectCatalogSkillSetExpansionModel;
}) {
  return (
    <ul className="mt-4 divide-y border-y" aria-label={`${expansion.name} skill membership`}>
      {expansion.skills.map((skill) => (
        <li
          key={skill.catalogId ?? skill.packagePath ?? `${skill.capability}:${skill.name}`}
          className="grid gap-2 py-3 md:grid-cols-[minmax(9rem,0.8fr)_minmax(0,1.2fr)] md:items-center md:gap-4"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-sm font-medium">{skill.name}</p>
              <Badge variant={skill.provenance === "installed" ? "secondary" : "outline"}>
                {skill.provenance === "installed" ? "Installed" : "Catalog"}
              </Badge>
              <Badge variant="outline" className="font-normal">
                {skill.capability.replaceAll("_", " ")}
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {skill.provenance === "catalog"
                ? skill.installSpec
                : skill.source
                  ? `Source: ${sourceLabel(skill.source)}`
                  : skill.packagePath}
            </p>
          </div>
          <p className="text-sm text-muted-foreground">{skill.role}</p>
        </li>
      ))}
    </ul>
  );
}

function IntelligenceSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2" aria-label="Loading Skill Set suggestions">
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function TraceSignalsPanel({
  signals,
  patterns,
  prepareCandidate,
}: {
  signals: readonly ProjectSkillTraceSignalModel[];
  patterns: readonly ProjectSkillExecutionPatternModel[];
  prepareCandidate?: DashboardProjectsActions["prepareTraceCandidate"];
}) {
  const [review, setReview] = useState<ProjectTraceCandidateReviewModel | null>(null);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"prepare" | null>(null);
  const patternsBySkillName = new Map(
    patterns.map((pattern) => [pattern.skillName.trim().toLowerCase(), pattern]),
  );

  async function prepare(patternId: string) {
    if (prepareCandidate?.access !== "available" || pendingAction) return;
    setPendingAction("prepare");
    setPreparationError(null);
    try {
      setReview(await prepareCandidate.execute(patternId));
    } catch (error) {
      setPreparationError(error instanceof Error ? error.message : "Could not prepare candidate.");
    } finally {
      setPendingAction(null);
    }
  }

  if (signals.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Trace signals</CardTitle>
          <CardDescription>No linked skill traces have been ingested yet.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trace signals</CardTitle>
        <CardDescription>
          Aggregated local execution evidence from linked traces. Correlation only — this does not
          show that the skill caused errors.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {signals.map((signal) => {
          const pattern = patternsBySkillName.get(signal.skillName.trim().toLowerCase());
          const errors = `${signal.errorTraceCount} of ${signal.traceCount} traced executions reported errors`;
          return (
            <section
              key={signal.skillName}
              className="rounded-lg border p-4"
              aria-label={signal.skillName}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">{signal.skillName}</h3>
                {pattern ? <Badge variant="secondary">Supported correlation</Badge> : null}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{errors}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {signal.invocationCount.toLocaleString()} invocations ·{" "}
                {signal.toolCallCount.toLocaleString()} tool calls ·{" "}
                {signal.errorCount.toLocaleString()} errors ·{" "}
                {Math.round(signal.durationMs).toLocaleString()} ms
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {signal.inputTokens.toLocaleString()} input tokens ·{" "}
                {signal.outputTokens.toLocaleString()} output tokens
              </p>
              {pattern ? <p className="mt-3 text-sm">{pattern.reason}</p> : null}
              {pattern && prepareCandidate?.access === "available" ? (
                <Button
                  className="mt-3"
                  size="sm"
                  disabled={prepareCandidate.isPending || pendingAction !== null}
                  onClick={() => void prepare(pattern.id)}
                >
                  Prepare candidate
                </Button>
              ) : null}
            </section>
          );
        })}
        {preparationError ? <p className="text-sm text-destructive">{preparationError}</p> : null}
        {review ? (
          <section aria-label="Candidate review" className="rounded-lg border p-4 text-sm">
            <p>Target revision: {review.targetRevision ?? "unavailable"}</p>
            <p>
              Evidence: {review.evidence.resolvedEntries}/{review.evidence.cohortEntries} resolved
            </p>
            {review.readiness === "review_ready" && review.candidate ? (
              <>
                <p className="mt-2">{review.candidate.rationale}</p>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">
                  {review.candidate.body}
                </pre>
                <p className="mt-2 text-xs text-muted-foreground">
                  {review.candidate.changedLines} changed lines · {review.candidate.targetSection}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  This candidate and its evaluation evidence stay on this device.
                </p>
              </>
            ) : (
              <p className="mt-2">{review.failureReason ?? "Candidate is not ready."}</p>
            )}
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RecommendationRow({
  name,
  meta,
  selected,
  onSelect,
}: {
  name: string;
  meta: string;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      className="w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/60 data-[selected=true]:bg-muted"
      data-selected={selected}
      onClick={onSelect}
    >
      <span className="block truncate font-medium">{name}</span>
      <span className="mt-1 block text-xs tabular-nums text-muted-foreground">{meta}</span>
    </button>
  );
}

export function SkillSetIntelligencePanels({
  intelligence,
  reviewAction,
  prepareCandidate,
  onReview,
  onReviewExpansion,
  view = "suggestions",
  selectedRecommendationKey: controlledRecommendationKey,
  showList = true,
}: {
  intelligence: DashboardProjectsIntelligenceQueryState;
  reviewAction: DashboardProjectsActions["reviewSuggestion"];
  prepareCandidate?: DashboardProjectsActions["prepareTraceCandidate"];
  onReview(suggestion: ProjectSkillSetSuggestionModel): void;
  onReviewExpansion(expansion: ProjectCatalogSkillSetExpansionModel): void;
  view?: "suggestions" | "outcomes" | "trace-signals";
  selectedRecommendationKey?: string | null;
  showList?: boolean;
}) {
  const [dismissSuggestion, setDismissSuggestion] = useState<ProjectSkillSetSuggestionModel | null>(
    null,
  );
  const [dismissReasonCode, setDismissReasonCode] =
    useState<DismissalReasonCode>("not_relevant_now");
  const [dismissReason, setDismissReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedRecommendationKey, setSelectedRecommendationKey] = useState<string | null>(null);

  if (intelligence.access === "unavailable") return null;
  const availableIntelligence = intelligence;
  if (availableIntelligence.isLoading) return <IntelligenceSkeleton />;

  const report = availableIntelligence.data;
  const reviewPending = reviewAction.access === "available" && reviewAction.isPending === true;
  const fallbackRecommendationKey = report?.catalogExpansions[0]
    ? `catalog:${report.catalogExpansions[0].id}`
    : report?.suggestions[0]
      ? `observed:${report.suggestions[0].id}`
      : null;
  const activeRecommendationKey =
    controlledRecommendationKey ?? selectedRecommendationKey ?? fallbackRecommendationKey;
  const selectedExpansion = report?.catalogExpansions.find(
    (expansion) => `catalog:${expansion.id}` === activeRecommendationKey,
  );
  const selectedSuggestion = report?.suggestions.find(
    (suggestion) => `observed:${suggestion.id}` === activeRecommendationKey,
  );

  async function confirmDismiss() {
    if (!dismissSuggestion || reviewAction.access !== "available") return;
    setError(null);
    try {
      await reviewAction.execute({
        suggestionId: dismissSuggestion.id,
        evidenceFingerprint: dismissSuggestion.evidenceFingerprint,
        decision: "dismissed",
        reasonCode: dismissReasonCode,
        reason: dismissReason.trim() || null,
      });
      setDismissSuggestion(null);
      setDismissReason("");
      setDismissReasonCode("not_relevant_now");
      await availableIntelligence.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The suggestion could not be dismissed.");
    }
  }

  return (
    <>
      {view === "trace-signals" ? (
        availableIntelligence.error ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-destructive">{availableIntelligence.error}</p>
            </CardContent>
          </Card>
        ) : report ? (
          <TraceSignalsPanel
            signals={report.traceSignals}
            patterns={report.executionPatterns}
            prepareCandidate={prepareCandidate}
          />
        ) : null
      ) : view === "suggestions" ? (
        availableIntelligence.error ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-destructive">{availableIntelligence.error}</p>
            </CardContent>
          </Card>
        ) : report && (report.catalogExpansions.length > 0 || report.suggestions.length > 0) ? (
          <div
            className={
              showList ? "grid min-w-0 gap-6 lg:grid-cols-[280px_minmax(0,1fr)]" : undefined
            }
          >
            {showList ? (
              <Card className="min-w-0">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="flex items-center gap-2">
                        <SparklesIcon /> Suggested Skill Sets
                      </CardTitle>
                      <CardDescription>
                        Evidence-backed combinations discovered across trusted sessions.
                      </CardDescription>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      aria-label="Refresh suggestions"
                      onClick={() => void availableIntelligence.refresh()}
                    >
                      <RefreshCwIcon />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-1 p-2">
                  {report.catalogExpansions.length > 0 ? (
                    <section>
                      <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                        Context-Backed Skill Sets
                      </p>
                      <div>
                        {report.catalogExpansions.map((expansion) => (
                          <RecommendationRow
                            key={expansion.id}
                            name={expansion.name}
                            meta={`${expansion.skills.length} skills · Context-backed`}
                            selected={activeRecommendationKey === `catalog:${expansion.id}`}
                            onSelect={() => {
                              const key = `catalog:${expansion.id}`;
                              setSelectedRecommendationKey(key);
                            }}
                          />
                        ))}
                      </div>
                    </section>
                  ) : null}
                  {report.suggestions.length > 0 ? (
                    <section>
                      <p className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">
                        Observed patterns
                      </p>
                      <div>
                        {report.suggestions.map((suggestion) => (
                          <RecommendationRow
                            key={`${suggestion.id}:${suggestion.evidenceFingerprint}`}
                            name={suggestion.name}
                            meta={`${suggestion.skills.length} skills · ${EVIDENCE_LABELS[suggestion.evidenceState]}`}
                            selected={activeRecommendationKey === `observed:${suggestion.id}`}
                            onSelect={() => {
                              const key = `observed:${suggestion.id}`;
                              setSelectedRecommendationKey(key);
                            }}
                          />
                        ))}
                      </div>
                    </section>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            <Card className="min-w-0">
              <CardContent className="min-w-0 p-5 lg:p-6">
                <aside aria-label="Selected suggestion details">
                  {selectedExpansion ? (
                    <>
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-base font-semibold">{selectedExpansion.name}</h3>
                            <Badge variant="secondary">Context-backed</Badge>
                            <Badge variant="outline">Exploratory</Badge>
                          </div>
                          <p className="mt-2 text-sm text-muted-foreground">
                            {selectedExpansion.description}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          aria-label={`Review and create ${selectedExpansion.name}`}
                          onClick={() => onReviewExpansion(selectedExpansion)}
                        >
                          Review &amp; Create <ChevronRightIcon data-icon="inline-end" />
                        </Button>
                      </div>
                      <CatalogExpansionMembers expansion={selectedExpansion} />
                      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                        {selectedExpansion.reason}
                      </p>
                    </>
                  ) : selectedSuggestion ? (
                    <>
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-base font-semibold">{selectedSuggestion.name}</h3>
                            <Badge variant="secondary">
                              {PATTERN_LABELS[selectedSuggestion.pattern]}
                            </Badge>
                            <Badge variant="outline">
                              {EVIDENCE_LABELS[selectedSuggestion.evidenceState]}
                            </Badge>
                          </div>
                          <p className="mt-2 text-sm text-muted-foreground">
                            {selectedSuggestion.description}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Dismiss ${selectedSuggestion.name}`}
                            disabled={reviewAction.access !== "available"}
                            onClick={() => {
                              setDismissSuggestion(selectedSuggestion);
                              setDismissReason("");
                              setDismissReasonCode("not_relevant_now");
                            }}
                          >
                            <XIcon data-icon="inline-start" /> Dismiss
                          </Button>
                          <Button
                            size="sm"
                            aria-label={`Review ${selectedSuggestion.name}`}
                            onClick={() => onReview(selectedSuggestion)}
                          >
                            Review <ChevronRightIcon data-icon="inline-end" />
                          </Button>
                        </div>
                      </div>
                      <div className="mt-4 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                        <p>
                          <span className="font-medium text-foreground">
                            {Math.round(selectedSuggestion.confidence * 100)}% evidence score
                          </span>{" "}
                          from {selectedSuggestion.discoveryOccurrenceCount} older and{" "}
                          {selectedSuggestion.heldOutOccurrenceCount} newer occurrences.
                        </p>
                        {selectedSuggestion.pattern === "co_usage" ? (
                          <p>{coverageLabel(selectedSuggestion)}</p>
                        ) : null}
                      </div>
                      <SuggestionMembers suggestion={selectedSuggestion} />
                      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                        {selectedSuggestion.reason}
                      </p>
                    </>
                  ) : null}
                </aside>
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">
                No repeated skill patterns meet the current evidence thresholds.
              </p>
            </CardContent>
          </Card>
        )
      ) : null}
      {view === "outcomes" ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ChartNoAxesCombinedIcon /> Measured Outcomes
            </CardTitle>
            <CardDescription>
              Before-and-after evidence for accepted Skill Set activations.
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            {report && report.outcomes.length > 0 ? (
              report.outcomes.map((outcome) => (
                <section key={outcome.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{outcome.skillSetId}</p>
                    <Badge variant={outcome.status === "regressed" ? "destructive" : "secondary"}>
                      {outcome.status === "improved"
                        ? "Improved"
                        : outcome.status === "regressed"
                          ? "Regressed"
                          : "Inconclusive"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {outcome.beforeSessionCount} before · {outcome.afterSessionCount} after
                    </span>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {OUTCOME_METRICS.map(({ id, label, percent }) => (
                      <div key={id} className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-medium">
                          {metricValue(outcome.metrics[id].before, percent)} →{" "}
                          {metricValue(outcome.metrics[id].after, percent)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">{outcome.reason}</p>
                </section>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No accepted activation has a measured window yet.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {view === "suggestions" ? (
        <Dialog
          open={dismissSuggestion !== null}
          onOpenChange={(open) => {
            if (!open) setDismissSuggestion(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Dismiss suggested Skill Set?</DialogTitle>
              <DialogDescription>
                Your feedback calibrates future evidence thresholds. Temporary dismissals can return
                when the evidence changes.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <Select
                value={dismissReasonCode}
                onValueChange={(value) => {
                  if (value && isDismissalReasonCode(value)) {
                    setDismissReasonCode(value);
                  }
                }}
              >
                <SelectTrigger className="w-full" aria-label="Dismissal reason">
                  <SelectValue>{DISMISSAL_LABELS[dismissReasonCode]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {Object.entries(DISMISSAL_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {dismissReasonCode === "other" ? (
                <Textarea
                  value={dismissReason}
                  onChange={(event) => setDismissReason(event.target.value)}
                  placeholder="Tell selftune why this pattern is not useful"
                />
              ) : null}
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDismissSuggestion(null)}>
                Cancel
              </Button>
              <Button
                disabled={reviewAction.access !== "available" || reviewPending}
                onClick={() => void confirmDismiss()}
              >
                {reviewPending ? "Dismissing…" : "Dismiss suggestion"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
