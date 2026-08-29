import * as Schema from "effect/Schema";

export const RunReviewProducerSchema = Schema.Literals(["local_source_merge", "cloud_improve"]);
export type RunReviewProducer = typeof RunReviewProducerSchema.Type;
export const RunReviewStateSchema = Schema.Literals([
  "pending",
  "approved",
  "declined",
  "passed",
  "blocked",
  "applied",
  "rolled_back",
  "stale",
  "expired",
  "failed",
  "no_change",
]);
export type RunReviewState = typeof RunReviewStateSchema.Type;

const RunReviewEvidenceSchema = Schema.Struct({ label: Schema.String, value: Schema.String });
export type RunReviewEvidence = typeof RunReviewEvidenceSchema.Type;
const RunReviewSectionSchema = Schema.Struct({
  state: RunReviewStateSchema,
  summary: Schema.String,
});

export interface RunReviewView {
  readonly runId: string;
  readonly producer: RunReviewProducer;
  readonly intent: { readonly title: string; readonly summary: string };
  readonly evidence: readonly RunReviewEvidence[];
  readonly candidate: {
    readonly summary: string;
    readonly diffText: string | null;
    readonly artifact?: { readonly label: string; readonly href: string };
  };
  readonly decision: typeof RunReviewSectionSchema.Type;
  readonly validation: typeof RunReviewSectionSchema.Type;
  readonly outcome: typeof RunReviewSectionSchema.Type;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const RunPackageV1Schema = Schema.Struct({
  schema_version: Schema.Literal(1),
  run_id: Schema.String,
  producer: RunReviewProducerSchema,
  intent: Schema.Struct({ title: Schema.String, summary: Schema.String }),
  evidence: Schema.Array(RunReviewEvidenceSchema),
  candidate: Schema.Struct({ summary: Schema.String, diff_text: Schema.NullOr(Schema.String) }),
  decision: RunReviewSectionSchema,
  validation: RunReviewSectionSchema,
  outcome: RunReviewSectionSchema,
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type RunPackageV1 = typeof RunPackageV1Schema.Type;

export interface RunReviewAgentSummary {
  readonly run_id: string;
  readonly producer: RunReviewProducer;
  readonly intent: string;
  readonly decision: RunReviewState;
  readonly validation: RunReviewState;
  readonly outcome: RunReviewState;
  readonly summary: string;
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|signature)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(/\/(?:Users|home|tmp|private\/tmp|var\/folders)\/[^\s"'`]+/g, "[local-path]");
}

export function buildRunPackage(review: RunReviewView): RunPackageV1 {
  return RunPackageV1Schema.make({
    schema_version: 1,
    run_id: redactText(review.runId),
    producer: review.producer,
    intent: { title: redactText(review.intent.title), summary: redactText(review.intent.summary) },
    evidence: review.evidence.map((item) => ({
      label: redactText(item.label),
      value: redactText(item.value),
    })),
    candidate: {
      summary: redactText(review.candidate.summary),
      diff_text: review.candidate.diffText === null ? null : redactText(review.candidate.diffText),
    },
    decision: { state: review.decision.state, summary: redactText(review.decision.summary) },
    validation: { state: review.validation.state, summary: redactText(review.validation.summary) },
    outcome: { state: review.outcome.state, summary: redactText(review.outcome.summary) },
    created_at: review.createdAt,
    updated_at: review.updatedAt,
  });
}

export function parseRunPackage(value: typeof Schema.Unknown.Type): RunPackageV1 {
  try {
    return Schema.decodeUnknownSync(RunPackageV1Schema)(value, { onExcessProperty: "error" });
  } catch (cause) {
    const message = String(cause);
    if (message.includes('at ["schema_version"]')) {
      throw new TypeError(`Unsupported Run Package schema version: ${message}`, { cause });
    }
    throw cause;
  }
}

export function summarizeRunReview(review: RunReviewView): RunReviewAgentSummary {
  return {
    run_id: review.runId,
    producer: review.producer,
    intent: review.intent.title,
    decision: review.decision.state,
    validation: review.validation.state,
    outcome: review.outcome.state,
    summary: review.outcome.summary,
  };
}
