import { useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { EvidenceEntry, EvolutionEntry } from "@/types"
import { formatRate, timeAgo } from "@/utils"
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  FileTextIcon,
  InfoIcon,
  RocketIcon,
  ShieldCheckIcon,
  ShieldAlertIcon,
  XCircleIcon,
  UndoIcon,
  ArrowRightIcon,
  TrendingUpIcon,
  TrendingDownIcon,
  ListChecksIcon,
} from "lucide-react"
import Markdown from "react-markdown"

const ACTION_ICON: Record<string, React.ReactNode> = {
  created: <CircleDotIcon className="size-3.5" />,
  validated: <ShieldCheckIcon className="size-3.5" />,
  deployed: <RocketIcon className="size-3.5" />,
  rejected: <XCircleIcon className="size-3.5" />,
  rolled_back: <UndoIcon className="size-3.5" />,
}

const ACTION_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  created: "outline",
  validated: "secondary",
  deployed: "default",
  rejected: "destructive",
  rolled_back: "destructive",
}

interface Props {
  proposalId: string
  evolution: EvolutionEntry[]
  evidence: EvidenceEntry[]
}

/** Parse YAML-ish frontmatter from text, returns { meta, body } */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: text }

  const meta: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":")
    if (idx > 0) {
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim()
      if (key && val) meta[key] = val
    }
  }
  return { meta, body: match[2] }
}

function FrontmatterTable({ meta }: { meta: Record<string, string> }) {
  const entries = Object.entries(meta)
  if (entries.length === 0) return null

  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {entries.map(([key, val]) => (
        <div key={key} className="contents">
          <span className="font-medium text-muted-foreground capitalize">{key}</span>
          <span className="text-foreground truncate">{val}</span>
        </div>
      ))}
    </div>
  )
}

function SkillContentBlock({ label, text, variant }: { label: string; text: string; variant: "original" | "proposed" }) {
  const { meta, body } = parseFrontmatter(text)
  const hasMeta = Object.keys(meta).length > 0

  return (
    <div className="flex-1 min-w-0 space-y-3">
      <div className="flex items-center gap-2">
        <FileTextIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
        {variant === "proposed" && (
          <Badge variant="secondary" className="text-[10px]">New</Badge>
        )}
      </div>

      {/* Frontmatter */}
      {hasMeta && (
        <div className="rounded-md border bg-muted/30 p-3">
          <FrontmatterTable meta={meta} />
        </div>
      )}

      {/* Rendered markdown body */}
      <div className="skill-markdown rounded-md border bg-card p-4">
        <Markdown>{body}</Markdown>
      </div>
    </div>
  )
}

/** Smart formatting for a single validation value */
function formatValidationValue(key: string, val: unknown): React.ReactNode {
  // Booleans
  if (typeof val === "boolean") {
    return val
      ? <CheckCircleIcon className="size-3.5 text-emerald-500 inline" />
      : <XCircleIcon className="size-3.5 text-red-500 inline" />
  }
  // Numbers that look like rates (0-1 range, or key contains "rate"/"change")
  if (typeof val === "number") {
    const isRate = key.includes("rate") || key.includes("change") || (val >= -1 && val <= 1 && key !== "count")
    if (isRate) {
      const pct = (val * 100).toFixed(1)
      const prefix = val > 0 && key.includes("change") ? "+" : ""
      return <span className="font-mono">{prefix}{pct}%</span>
    }
    return <span className="font-mono">{val}</span>
  }
  // null/undefined
  if (val === null || val === undefined) return <span className="text-muted-foreground">--</span>
  // Strings
  if (typeof val === "string") return <span>{val}</span>
  // Arrays — render as list of items
  if (Array.isArray(val)) {
    if (val.length === 0) return <span className="text-muted-foreground italic">none</span>
    return <span className="font-mono">{val.length} entries</span>
  }
  // Objects
  if (typeof val === "object") return <span className="font-mono">1 entry</span>
  return <span>{String(val)}</span>
}

/** Render a per_entry_result row — handles both flat EvalEntry and nested { entry, before_pass, after_pass } */
function PerEntryResult({ entry }: { entry: Record<string, unknown> }) {
  // Handle nested shape: { entry: { query, should_trigger }, before_pass, after_pass }
  const nested = entry.entry as Record<string, unknown> | undefined
  const query = nested?.query ?? entry.query ?? entry.prompt ?? entry.input ?? entry.text
  const shouldTrigger = nested?.should_trigger ?? entry.should_trigger
  const invocationType = nested?.invocation_type ?? entry.invocation_type
  const beforePass = entry.before_pass ?? entry.before ?? entry.original_triggered ?? entry.baseline
  const afterPass = entry.after_pass ?? entry.after ?? entry.triggered ?? entry.result
  const passed = entry.passed ?? entry.matched

  // Determine icon: use after_pass for per_entry_results, passed for others
  const isPass = typeof afterPass === "boolean" ? afterPass : typeof passed === "boolean" ? passed : null

  return (
    <div className="flex items-start gap-2 text-xs py-1.5 border-b border-border/50 last:border-0">
      {isPass !== null ? (
        isPass
          ? <CheckCircleIcon className="size-3.5 text-emerald-500 shrink-0 mt-0.5" />
          : <XCircleIcon className="size-3.5 text-red-500 shrink-0 mt-0.5" />
      ) : (
        <CircleDotIcon className="size-3.5 text-muted-foreground shrink-0 mt-0.5" />
      )}
      <span className="flex-1 min-w-0 line-clamp-2">
        {query ? String(query) : JSON.stringify(entry)}
      </span>
      <div className="flex items-center gap-1.5 shrink-0">
        {typeof beforePass === "boolean" && typeof afterPass === "boolean" && (
          <span className="text-[10px] text-muted-foreground font-mono">
            {beforePass ? "pass" : "fail"} → {afterPass ? "pass" : "fail"}
          </span>
        )}
        {shouldTrigger !== undefined && (
          <Badge variant="secondary" className="text-[9px]">
            expect: {String(shouldTrigger)}
          </Badge>
        )}
        {invocationType != null && (
          <Badge variant="secondary" className="text-[9px]">
            {String(invocationType)}
          </Badge>
        )}
      </div>
    </div>
  )
}

function ValidationResults({ validation }: { validation: Record<string, unknown> }) {
  const { improved, before_pass_rate, after_pass_rate, net_change, regressions, new_passes, per_entry_results, ...rest } = validation

  const regressionsArr = Array.isArray(regressions) ? regressions : []
  const newPassesArr = Array.isArray(new_passes) ? new_passes : []
  const perEntryArr = Array.isArray(per_entry_results) ? per_entry_results : []

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-3">
      <p className="text-xs font-medium text-muted-foreground">
        Validation Results
        <span className="font-normal text-muted-foreground/60 ml-1.5">— Before/after comparison from eval tests</span>
      </p>

      {/* Summary bar */}
      <div className="flex items-center gap-3 flex-wrap">
        {improved !== undefined && (
          <Badge variant={improved ? "default" : "destructive"} className="text-[10px]">
            {improved ? "Improved" : "Regressed"}
          </Badge>
        )}
        {typeof before_pass_rate === "number" && typeof after_pass_rate === "number" && (
          <span className="text-xs font-mono text-muted-foreground">
            {(before_pass_rate * 100).toFixed(1)}% → {(after_pass_rate * 100).toFixed(1)}%
          </span>
        )}
        {typeof net_change === "number" && (
          <span className={`text-xs font-mono font-semibold ${net_change > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
            {net_change > 0 ? "+" : ""}{(net_change * 100).toFixed(1)}%
          </span>
        )}
      </div>

      {/* New passes */}
      {newPassesArr.length > 0 && (
        <div>
          <p className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 mb-1">
            New Passes ({newPassesArr.length})
          </p>
          <div className="rounded border bg-card p-2">
            {newPassesArr.map((entry, j) => (
              <PerEntryResult key={j} entry={typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : { value: entry }} />
            ))}
          </div>
        </div>
      )}

      {/* Regressions */}
      {regressionsArr.length > 0 && (
        <div>
          <p className="text-[11px] font-medium text-red-500 mb-1">
            Regressions ({regressionsArr.length})
          </p>
          <div className="rounded border border-red-200 dark:border-red-900/50 bg-card p-2">
            {regressionsArr.map((entry, j) => (
              <PerEntryResult key={j} entry={typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : { value: entry }} />
            ))}
          </div>
        </div>
      )}

      {/* Per-entry results (collapsible if many) */}
      {perEntryArr.length > 0 && (
        <PerEntryResultsSection entries={perEntryArr} />
      )}

      {/* Any remaining keys */}
      {Object.keys(rest).length > 0 && (
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {Object.entries(rest).map(([key, val]) => (
            <div key={key} className="contents">
              <span className="font-mono text-muted-foreground">{key}</span>
              <span className="text-foreground">{formatValidationValue(key, val)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PerEntryResultsSection({ entries }: { entries: unknown[] }) {
  const [expanded, setExpanded] = useState(false)
  const passCount = entries.filter((e) => {
    if (typeof e !== "object" || e === null) return false
    const obj = e as Record<string, unknown>
    return obj.passed === true || obj.matched === true || obj.triggered === true || obj.after === true || obj.result === true
  }).length

  const display = expanded ? entries : entries.slice(0, 5)

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[11px] font-medium text-muted-foreground">
          Individual Test Cases ({passCount}/{entries.length} passed)
        </p>
        {entries.length > 5 && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-primary hover:underline"
          >
            {expanded ? "Show less" : `Show all ${entries.length}`}
          </button>
        )}
      </div>
      {/* Pass rate bar */}
      <div className="h-1.5 rounded-full bg-muted overflow-hidden mb-2">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all"
          style={{ width: `${entries.length > 0 ? (passCount / entries.length) * 100 : 0}%` }}
        />
      </div>
      <div className="rounded border bg-card p-2 max-h-[300px] overflow-y-auto">
        {display.map((entry, j) => (
          <PerEntryResult
            key={j}
            entry={typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : { value: entry }}
          />
        ))}
      </div>
    </div>
  )
}

/** Extract after_pass_rate from an evidence entry's validation data */
function getAfterPassRate(entry: EvidenceEntry): number | null {
  if (!entry.validation) return null
  const rate = entry.validation.after_pass_rate
  return typeof rate === "number" ? rate : null
}

/** Render a delta badge between two pass rates, returns null if not computable */
function DeltaBadge({ prev, curr }: { prev: number | null; curr: number | null }) {
  if (prev === null || curr === null) return null
  const delta = curr - prev
  if (delta === 0) return null
  const pct = (delta * 100).toFixed(1)
  const positive = delta > 0
  return (
    <span className={`text-[10px] font-mono font-semibold ${positive ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
      {positive ? "+" : ""}{pct}% vs previous
    </span>
  )
}

function EvalSetSection({ evalSet }: { evalSet: Array<Record<string, unknown>> }) {
  const [expanded, setExpanded] = useState(false)
  const passCount = evalSet.filter((e) => {
    const passed = e.passed ?? e.result
    return passed === true
  }).length

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full text-left"
      >
        {expanded
          ? <ChevronDownIcon className="size-3.5 text-muted-foreground shrink-0" />
          : <ChevronRightIcon className="size-3.5 text-muted-foreground shrink-0" />}
        <ListChecksIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">
          Eval Set ({passCount}/{evalSet.length} passed)
        </span>
      </button>
      {expanded && (
        <div className="space-y-1">
          {evalSet.map((evalEntry, j) => {
            const query = evalEntry.query ?? evalEntry.prompt ?? evalEntry.input
            const expected = evalEntry.expected ?? evalEntry.should_trigger
            const passed = evalEntry.passed ?? evalEntry.result
            return (
              <div key={j} className="flex items-start gap-2 text-xs py-1 border-b border-border/50 last:border-0">
                {typeof passed === "boolean" ? (
                  passed
                    ? <CheckCircleIcon className="size-3.5 text-emerald-500 shrink-0 mt-0.5" />
                    : <XCircleIcon className="size-3.5 text-red-500 shrink-0 mt-0.5" />
                ) : (
                  <CircleDotIcon className="size-3.5 text-muted-foreground shrink-0 mt-0.5" />
                )}
                <span className="flex-1 min-w-0 line-clamp-2">{String(query ?? JSON.stringify(evalEntry))}</span>
                {expected !== undefined && (
                  <Badge variant="secondary" className="text-[9px] shrink-0">
                    expect: {String(expected)}
                  </Badge>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

type RoundStatus = "single" | "intermediate" | "final"

/** Render a single evidence card — used for both expanded and collapsed states */
function EvidenceCard({
  entry,
  roundLabel,
  roundStatus,
  prevPassRate,
  currPassRate,
}: {
  entry: EvidenceEntry
  roundLabel: string | null
  roundStatus: RoundStatus
  prevPassRate: number | null
  currPassRate: number | null
}) {
  const showRound = roundStatus !== "single"
  return (
    <Card className={roundStatus === "final" ? "border-primary/50 shadow-sm" : undefined}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldAlertIcon className="size-4 text-muted-foreground" />
            Evidence: {entry.target}
            {showRound && roundLabel && (
              <span className="text-[10px] font-mono text-muted-foreground">{roundLabel}</span>
            )}
            {roundStatus === "final" && (
              <Badge variant="default" className="text-[10px]">Final</Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {showRound && <DeltaBadge prev={prevPassRate} curr={currPassRate} />}
            <Badge variant="secondary" className="text-[10px]">{entry.stage}</Badge>
            {entry.confidence !== null && (
              <Badge
                variant={entry.confidence >= 0.8 ? "default" : entry.confidence >= 0.5 ? "secondary" : "destructive"}
                className="text-[10px] font-mono"
              >
                {formatRate(entry.confidence)} confidence
              </Badge>
            )}
            <span className="text-[10px] text-muted-foreground">{timeAgo(entry.timestamp)}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Rationale */}
        {entry.rationale && (
          <div className="rounded-md border-l-2 border-primary/40 bg-primary/5 px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground mb-1">Rationale</p>
            <p className="text-sm leading-relaxed">{entry.rationale}</p>
          </div>
        )}

        {/* Evidence details */}
        {entry.details && (
          <p className="text-xs text-muted-foreground leading-relaxed">{entry.details}</p>
        )}

        {/* Side-by-side content diff */}
        {(entry.original_text || entry.proposed_text) && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {entry.original_text && (
              <SkillContentBlock label="Original Snapshot" text={entry.original_text} variant="original" />
            )}
            {entry.proposed_text && (
              <SkillContentBlock label="Proposed Snapshot" text={entry.proposed_text} variant="proposed" />
            )}
          </div>
        )}

        {/* Eval set — test cases used for validation (collapsible) */}
        {entry.eval_set && entry.eval_set.length > 0 && (
          <EvalSetSection evalSet={entry.eval_set} />
        )}

        {/* Validation details */}
        {entry.validation && Object.keys(entry.validation).length > 0 && (
          <ValidationResults validation={entry.validation} />
        )}
      </CardContent>
    </Card>
  )
}

/** Collapsed summary for earlier iteration rounds */
function CollapsedEvidenceCard({
  entry,
  roundLabel,
  onExpand,
}: {
  entry: EvidenceEntry
  roundLabel: string
  onExpand: () => void
}) {
  const passRate = getAfterPassRate(entry)
  const improved = entry.validation?.improved

  return (
    <button
      type="button"
      onClick={onExpand}
      className="flex items-center gap-3 w-full rounded-lg border border-dashed px-4 py-3 text-left hover:bg-accent/50 transition-colors"
    >
      <ChevronRightIcon className="size-4 text-muted-foreground shrink-0" />
      <ShieldAlertIcon className="size-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs text-muted-foreground">{entry.target}</span>
      <span className="text-[10px] font-mono text-muted-foreground">{roundLabel}</span>
      <div className="flex items-center gap-2 ml-auto shrink-0">
        {passRate !== null && (
          <span className="text-[10px] font-mono text-muted-foreground">
            {(passRate * 100).toFixed(1)}% pass rate
          </span>
        )}
        {typeof improved === "boolean" && (
          <Badge variant={improved ? "default" : "destructive"} className="text-[9px]">
            {improved ? "Improved" : "Regressed"}
          </Badge>
        )}
        <Badge variant="secondary" className="text-[10px]">{entry.stage}</Badge>
        <span className="text-[10px] text-muted-foreground">{timeAgo(entry.timestamp)}</span>
      </div>
    </button>
  )
}

export function EvidenceViewer({ proposalId, evolution, evidence }: Props) {
  const steps = useMemo(
    () => evolution
      .filter((e) => e.proposal_id === proposalId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()),
    [evolution, proposalId],
  )

  const entries = useMemo(
    () => evidence
      .filter((e) => e.proposal_id === proposalId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()),
    [evidence, proposalId],
  )

  // Track which earlier rounds are manually expanded
  const [expandedRounds, setExpandedRounds] = useState<Set<string>>(new Set())

  const toggleRound = (key: string) => {
    setExpandedRounds((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const snapshot = useMemo(() => {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].eval_snapshot) return steps[i].eval_snapshot as Record<string, unknown>
    }
    return null
  }, [steps])

  // Separate proposal-stage entries from validation-stage entries, then group validations by target
  const { proposalEntries, validationsByTarget } = useMemo(() => {
    const proposals: EvidenceEntry[] = []
    const validationMap = new Map<string, EvidenceEntry[]>()
    for (const entry of entries) {
      if (entry.stage !== "validated") {
        proposals.push(entry)
      } else {
        const key = entry.target
        if (!validationMap.has(key)) validationMap.set(key, [])
        validationMap.get(key)!.push(entry)
      }
    }
    return { proposalEntries: proposals, validationsByTarget: validationMap }
  }, [entries])

  return (
    <div className="space-y-4">
      {/* Context banner */}
      <div className="flex items-start gap-2.5 rounded-lg border border-primary/20 bg-primary/5 px-3.5 py-2.5">
        <InfoIcon className="size-4 text-primary/60 shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          This view shows the historical evidence trail for a skill evolution proposal — what the skill looked like
          when the proposal was created, how it changed, the eval results before and after, and whether the change
          improved performance. Archived snapshots below may differ from the current `SKILL.md` and product docs.
        </p>
      </div>

      {/* Proposal journey */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <span>Proposal Journey</span>
            <span className="font-mono text-xs text-muted-foreground">#{proposalId.slice(0, 12)}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            {steps.map((step, i) => (
              <div key={`${step.action}-${i}`} className="contents">
                {i > 0 && <ArrowRightIcon className="size-3 text-muted-foreground/50 shrink-0" />}
                <div className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 bg-card">
                  {ACTION_ICON[step.action]}
                  <Badge variant={ACTION_VARIANT[step.action] ?? "secondary"} className="text-[10px] capitalize">
                    {step.action.replace("_", " ")}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">{timeAgo(step.timestamp)}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Eval snapshot — pass rate change */}
          {snapshot && (
            <div className="flex items-center gap-3 rounded-md border bg-muted/20 px-3 py-2">
              {typeof snapshot.net_change === "number" && (
                <div className="flex items-center gap-1">
                  {(snapshot.net_change as number) > 0
                    ? <TrendingUpIcon className="size-3.5 text-emerald-500" />
                    : <TrendingDownIcon className="size-3.5 text-red-500" />}
                  <span className={`text-sm font-semibold font-mono ${(snapshot.net_change as number) > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
                    {(snapshot.net_change as number) > 0 ? "+" : ""}{Math.round((snapshot.net_change as number) * 100)}%
                  </span>
                </div>
              )}
              {typeof snapshot.before_pass_rate === "number" && typeof snapshot.after_pass_rate === "number" && (
                <span className="text-xs text-muted-foreground font-mono">
                  {Math.round((snapshot.before_pass_rate as number) * 100)}% → {Math.round((snapshot.after_pass_rate as number) * 100)}%
                </span>
              )}
              {snapshot.improved !== undefined && (
                <Badge variant={snapshot.improved ? "default" : "destructive"} className="text-[10px]">
                  {snapshot.improved ? "Improved" : "Regressed"}
                </Badge>
              )}
            </div>
          )}

          {/* Details from last step */}
          {steps.length > 0 && steps[steps.length - 1].details && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              {steps[steps.length - 1].details}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Proposal-stage evidence — standalone cards showing original/proposed text */}
      {proposalEntries.map((entry) => (
        <EvidenceCard
          key={`proposal-${entry.target}-${entry.timestamp}`}
          entry={entry}
          roundLabel={null}
          roundStatus="single"
          prevPassRate={null}
          currPassRate={null}
        />
      ))}

      {/* Validation-stage evidence — grouped by target with iteration rounds */}
      {Array.from(validationsByTarget.entries()).map(([target, targetEntries]) => {
        const hasMultipleRounds = targetEntries.length > 1

        return (
          <div key={target} className="space-y-2">
            {targetEntries.map((entry, i) => {
              const isLast = i === targetEntries.length - 1
              const roundLabel = hasMultipleRounds ? `Round ${i + 1} of ${targetEntries.length}` : null
              const prevPassRate = i > 0 ? getAfterPassRate(targetEntries[i - 1]) : null
              const currPassRate = getAfterPassRate(entry)
              const roundKey = `${target}-${entry.timestamp}`
              const roundStatus: RoundStatus = !hasMultipleRounds ? "single" : isLast ? "final" : "intermediate"

              // Earlier rounds: collapsed by default
              if (roundStatus === "intermediate" && !expandedRounds.has(roundKey)) {
                return (
                  <CollapsedEvidenceCard
                    key={roundKey}
                    entry={entry}
                    roundLabel={roundLabel!}
                    onExpand={() => toggleRound(roundKey)}
                  />
                )
              }

              // Expanded earlier round — show with collapse toggle
              if (roundStatus === "intermediate" && expandedRounds.has(roundKey)) {
                return (
                  <div key={roundKey} className="space-y-1">
                    <button
                      type="button"
                      onClick={() => toggleRound(roundKey)}
                      className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1"
                    >
                      <ChevronDownIcon className="size-3" />
                      Collapse {roundLabel}
                    </button>
                    <EvidenceCard
                      entry={entry}
                      roundLabel={roundLabel}
                      roundStatus={roundStatus}
                      prevPassRate={prevPassRate}
                      currPassRate={currPassRate}
                    />
                  </div>
                )
              }

              // Final round (or single entry) — always expanded
              return (
                <EvidenceCard
                  key={roundKey}
                  entry={entry}
                  roundLabel={roundLabel}
                  roundStatus={roundStatus}
                  prevPassRate={prevPassRate}
                  currPassRate={currPassRate}
                />
              )
            })}
          </div>
        )
      })}

      {entries.length === 0 && (
        <div className="flex items-center justify-center rounded-lg border border-dashed py-8">
          <p className="text-sm text-muted-foreground">No evidence entries for this proposal</p>
        </div>
      )}
    </div>
  )
}
