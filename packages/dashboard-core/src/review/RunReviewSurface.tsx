import { UnifiedDiffViewer } from "@selftune/ui/components";

import type { RunReviewState, RunReviewView } from "./run-package";

function stateLabel(state: RunReviewState): string {
  return state.replaceAll("_", " ");
}

export function RunReviewSurface({ review }: { readonly review: RunReviewView }) {
  return (
    <section className="space-y-4" aria-label={`${review.intent.title} review`}>
      <header>
        <h2 className="text-base font-semibold text-foreground">{review.intent.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{review.intent.summary}</p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ReviewState
          label="Decision"
          state={review.decision.state}
          summary={review.decision.summary}
        />
        <ReviewState
          label="Validation"
          state={review.validation.state}
          summary={review.validation.summary}
        />
        <ReviewState
          label="Outcome"
          state={review.outcome.state}
          summary={review.outcome.summary}
        />
        <div className="rounded-lg border border-border/60 p-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Evidence
          </h3>
          <dl className="mt-2 space-y-1 text-xs">
            {review.evidence.map((item) => (
              <div key={item.label} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{item.label}</dt>
                <dd className="text-right text-foreground">{item.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Candidate diff</h3>
            <p className="text-xs text-muted-foreground">{review.candidate.summary}</p>
          </div>
          {review.candidate.artifact ? (
            <a
              href={review.candidate.artifact.href}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary underline underline-offset-2"
            >
              {review.candidate.artifact.label}
            </a>
          ) : null}
        </div>
        {review.candidate.diffText ? (
          <UnifiedDiffViewer title="Candidate diff" diffText={review.candidate.diffText} />
        ) : (
          <p className="rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
            No candidate diff is available.
          </p>
        )}
      </div>
    </section>
  );
}

function ReviewState({
  label,
  state,
  summary,
}: {
  readonly label: string;
  readonly state: RunReviewState;
  readonly summary: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </h3>
        <span className="text-xs capitalize text-foreground">{stateLabel(state)}</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{summary}</p>
    </div>
  );
}
