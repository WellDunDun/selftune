import type { ReactNode } from "react";

/**
 * Plain-data contract for an existing-skill body-evolution review. Hosts resolve
 * evidence and bind durable lifecycle operations; this screen never owns DuckDB,
 * provider clients, or application of a candidate.
 */
export type EvidenceBodyEvolutionReviewState =
  | "loading"
  | "insufficient_evidence"
  | "provider_unavailable"
  | "malformed_output"
  | "candidate_ready"
  | "regression_blocked"
  | "stale_revision"
  | "accepted"
  | "rejected"
  | "deferred"
  | "rolled_back";

export type EvidenceBodyEvolutionReviewAction = "accept" | "edit" | "reject" | "defer";

export interface EvidenceBodyEvolutionReviewActionCapability {
  readonly access: "available" | "unavailable";
  readonly reason?: string;
}

export interface EvidenceBodyEvolutionTarget {
  readonly skillName: string;
  readonly skillPath: string;
  /** Exact installed revision that must still match when an explicit apply follows review. */
  readonly revision: string;
  readonly section: string | null;
  readonly scope: "section_local" | "skill_specific" | "task_family" | "general";
}

export interface EvidenceBodyEvolutionPattern {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly observedAt: string;
  readonly causalStatus: "non_causal" | "supported_after_evaluation";
}

export interface EvidenceBodyEvolutionExcerpt {
  readonly id: string;
  readonly partition: "calibration" | "heldout";
  readonly role: "failure" | "comparable_success" | "counterexample";
  readonly summary: string;
  /** A bounded, redacted excerpt only; never a full source transcript. */
  readonly excerpt: string | null;
  readonly sourceReference: string;
  readonly redaction: "none" | "redacted" | "unavailable";
}

export interface EvidenceBodyEvolutionCohort {
  readonly fingerprint: string;
  readonly selectorVersion: string;
  readonly failures: number;
  readonly comparableSuccesses: number;
  readonly counterexamples: number;
  readonly heldout: number;
  readonly excerpts: readonly EvidenceBodyEvolutionExcerpt[];
  /** Exact, bounded calibration-only payload that may cross a teacher boundary. */
  readonly payloadPreview: {
    readonly bytes: number;
    readonly limitBytes: number;
    readonly excerptIds: readonly string[];
    readonly content: string;
  };
}

export interface EvidenceBodyEvolutionCandidate {
  readonly operation: "add" | "refine" | "replace" | "remove";
  readonly principle: string;
  readonly applicability: string;
  readonly summary: string;
  /** Unified diff for the exact target SKILL.md body revision. */
  readonly diffText: string;
  readonly preservedConstraints: readonly string[];
}

export interface EvidenceBodyEvolutionEvaluationCondition {
  readonly condition: "no_skill" | "current_skill" | "candidate_skill" | "prior_version";
  readonly state: "passed" | "blocked" | "not_measured";
  readonly summary: string;
}

export interface EvidenceBodyEvolutionEvaluation {
  readonly calibration: {
    readonly state: "passed" | "blocked" | "not_measured";
    readonly summary: string;
    readonly conditions: readonly EvidenceBodyEvolutionEvaluationCondition[];
  };
  readonly holdout: {
    readonly state: "passed" | "blocked" | "not_measured";
    readonly summary: string;
    readonly conditions: readonly EvidenceBodyEvolutionEvaluationCondition[];
  };
  readonly regression: {
    readonly state: "passed" | "blocked" | "not_measured";
    readonly summary: string;
  };
}

export interface EvidenceBodyEvolutionProvenance {
  readonly generator: string;
  readonly generatorContractVersion: string;
  readonly evidenceFingerprint: string;
  readonly sourceReferences: readonly string[];
}

export interface EvidenceBodyEvolutionReview {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly state: EvidenceBodyEvolutionReviewState;
  readonly stateSummary?: string;
  readonly target?: EvidenceBodyEvolutionTarget;
  readonly pattern?: EvidenceBodyEvolutionPattern;
  readonly cohort?: EvidenceBodyEvolutionCohort;
  readonly candidate?: EvidenceBodyEvolutionCandidate;
  readonly evaluation?: EvidenceBodyEvolutionEvaluation;
  readonly uncertainty?: readonly string[];
  readonly provenance?: EvidenceBodyEvolutionProvenance;
  /** Actions record a human review decision only. Applying remains a separate, guarded lifecycle step. */
  readonly actions?: Partial<
    Record<EvidenceBodyEvolutionReviewAction, EvidenceBodyEvolutionReviewActionCapability>
  >;
}

export interface EvidenceBodyEvolutionReviewSurfaceProps {
  readonly review: EvidenceBodyEvolutionReview;
  /** Host adapter to existing durable decision operations. It is never invoked as an apply operation. */
  readonly onAction?: (action: EvidenceBodyEvolutionReviewAction) => void;
}

const stateLabels = {
  loading: "Preparing review",
  insufficient_evidence: "Insufficient evidence",
  provider_unavailable: "Provider unavailable",
  malformed_output: "Malformed provider output",
  candidate_ready: "Ready for review",
  regression_blocked: "Regression blocked",
  stale_revision: "Stale target revision",
  accepted: "Accepted",
  rejected: "Rejected",
  deferred: "Deferred",
  rolled_back: "Rolled back",
} satisfies Record<EvidenceBodyEvolutionReviewState, string>;

export function EvidenceBodyEvolutionReviewSurface({
  review,
  onAction,
}: EvidenceBodyEvolutionReviewSurfaceProps) {
  return (
    <section className="space-y-5" aria-label="Evidence body evolution review">
      <header className="rounded-lg border border-border/60 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Existing skill body mutation
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-foreground">
            {review.target ? `Review ${review.target.skillName}` : "Evidence body evolution review"}
          </h2>
          <span className="rounded-full border border-border/60 px-2 py-0.5 text-xs text-foreground">
            {stateLabels[review.state]}
          </span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {review.stateSummary ??
            "A human decision is required before any guarded application step can occur."}
        </p>
        {review.target ? (
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <Detail label="Target path" value={review.target.skillPath} />
            <Detail label="Exact revision" value={review.target.revision} />
            <Detail
              label="Target section"
              value={review.target.section ?? "Entire instructional body"}
            />
            <Detail label="Scope" value={review.target.scope.replaceAll("_", " ")} />
          </dl>
        ) : null}
      </header>

      {review.pattern ? (
        <Panel title="Observed pattern">
          <p className="text-sm text-foreground">{review.pattern.summary}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {review.pattern.kind} · observed {review.pattern.observedAt} ·{" "}
            {review.pattern.causalStatus.replaceAll("_", " ")}
          </p>
        </Panel>
      ) : null}

      {review.cohort ? <CohortPanel cohort={review.cohort} /> : null}
      {review.candidate ? <CandidatePanel candidate={review.candidate} /> : null}
      {review.evaluation ? <EvaluationPanel evaluation={review.evaluation} /> : null}

      {review.uncertainty?.length ? (
        <Panel title="Uncertainty and limitations">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {review.uncertainty.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {review.provenance ? (
        <Panel title="Provenance">
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            <Detail label="Generator" value={review.provenance.generator} />
            <Detail label="Generator contract" value={review.provenance.generatorContractVersion} />
            <Detail label="Evidence fingerprint" value={review.provenance.evidenceFingerprint} />
            <Detail
              label="Source references"
              value={String(review.provenance.sourceReferences.length)}
            />
          </dl>
        </Panel>
      ) : null}

      <ReviewActions actions={review.actions} onAction={onAction} />
    </section>
  );
}

function CohortPanel({ cohort }: { readonly cohort: EvidenceBodyEvolutionCohort }) {
  return (
    <Panel title="Cohort composition">
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <Detail label="Failures" value={String(cohort.failures)} />
        <Detail label="Comparable successes" value={String(cohort.comparableSuccesses)} />
        <Detail label="Counterexamples" value={String(cohort.counterexamples)} />
        <Detail label="Blind holdout" value={String(cohort.heldout)} />
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        Selector {cohort.selectorVersion} · fingerprint {cohort.fingerprint}
      </p>
      <h3 className="mt-4 text-sm font-medium text-foreground">Selected evidence</h3>
      <div className="mt-2 space-y-2">
        {cohort.excerpts.map((excerpt) => (
          <article key={excerpt.id} className="rounded border border-border/60 p-3 text-sm">
            <p className="font-medium text-foreground">
              {excerpt.partition === "heldout" ? "Blind holdout" : "Calibration"} ·{" "}
              {excerpt.role.replaceAll("_", " ")}
            </p>
            <p className="mt-1 text-muted-foreground">{excerpt.summary}</p>
            <p className="mt-2 whitespace-pre-wrap font-mono text-xs text-foreground">
              {excerpt.excerpt ?? "Excerpt unavailable after privacy bounds were applied."}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {excerpt.sourceReference} · {excerpt.redaction}
            </p>
          </article>
        ))}
      </div>
      <h3 className="mt-4 text-sm font-medium text-foreground">Payload preview</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Calibration-only preview: {cohort.payloadPreview.bytes} / {cohort.payloadPreview.limitBytes}{" "}
        bytes · {cohort.payloadPreview.excerptIds.length} selected excerpts
      </p>
      <pre className="mt-2 max-h-48 overflow-auto rounded border border-border/60 p-3 text-xs whitespace-pre-wrap text-foreground">
        {cohort.payloadPreview.content}
      </pre>
    </Panel>
  );
}

function CandidatePanel({ candidate }: { readonly candidate: EvidenceBodyEvolutionCandidate }) {
  return (
    <Panel title="Exact body diff">
      <p className="text-sm text-foreground">{candidate.summary}</p>
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <Detail label="Mutation" value={candidate.operation} />
        <Detail label="Applicability" value={candidate.applicability} />
      </dl>
      <p className="mt-3 text-sm text-foreground">{candidate.principle}</p>
      {candidate.preservedConstraints.length ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Preserves: {candidate.preservedConstraints.join(" · ")}
        </p>
      ) : null}
      <pre className="mt-3 max-h-96 overflow-auto rounded border border-border/60 p-3 text-xs whitespace-pre-wrap text-foreground">
        {candidate.diffText}
      </pre>
    </Panel>
  );
}

function EvaluationPanel({ evaluation }: { readonly evaluation: EvidenceBodyEvolutionEvaluation }) {
  return (
    <Panel title="Evaluation">
      <div className="grid gap-3 md:grid-cols-3">
        <EvaluationPartition label="Calibration" value={evaluation.calibration} />
        <EvaluationPartition label="Blind holdout" value={evaluation.holdout} />
        <EvaluationPartition label="Regression gate" value={evaluation.regression} />
      </div>
    </Panel>
  );
}

function EvaluationPartition({
  label,
  value,
}: {
  readonly label: string;
  readonly value:
    | EvidenceBodyEvolutionEvaluation["calibration"]
    | EvidenceBodyEvolutionEvaluation["holdout"]
    | EvidenceBodyEvolutionEvaluation["regression"];
}) {
  const conditions = "conditions" in value ? value.conditions : [];
  return (
    <div className="rounded border border-border/60 p-3">
      <p className="text-sm font-medium text-foreground">{label}</p>
      <p className="mt-1 text-xs text-muted-foreground">{value.state.replaceAll("_", " ")}</p>
      <p className="mt-2 text-sm text-muted-foreground">{value.summary}</p>
      {conditions.length ? (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {conditions.map((condition) => (
            <li key={condition.condition}>
              {condition.condition.replaceAll("_", " ")}: {condition.summary}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ReviewActions({
  actions,
  onAction,
}: {
  readonly actions: EvidenceBodyEvolutionReview["actions"];
  readonly onAction: EvidenceBodyEvolutionReviewSurfaceProps["onAction"];
}) {
  const choices = [
    ["accept", "Accept candidate"],
    ["edit", "Edit candidate"],
    ["reject", "Reject candidate"],
    ["defer", "Defer review"],
  ] satisfies Array<[EvidenceBodyEvolutionReviewAction, string]>;
  return (
    <Panel title="Review actions">
      <p className="text-sm text-muted-foreground">
        These actions record a human review decision. They do not apply, publish, distribute, or
        install this mutation.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {choices.map(([action, label]) => {
          const capability = actions?.[action];
          const enabled = capability?.access === "available" && onAction !== undefined;
          return (
            <button
              key={action}
              type="button"
              disabled={!enabled}
              title={capability?.reason}
              className="rounded-md border border-border/60 px-3 py-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => onAction?.(action)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

function Panel({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border/60 p-4">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-all text-foreground">{value}</dd>
    </div>
  );
}
