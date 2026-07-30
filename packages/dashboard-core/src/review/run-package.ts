export type RunReviewProducer = "local_source_merge" | "cloud_improve";
export type RunReviewState =
  | "pending"
  | "approved"
  | "declined"
  | "passed"
  | "blocked"
  | "applied"
  | "rolled_back"
  | "stale"
  | "expired"
  | "failed"
  | "no_change";

export interface RunReviewEvidence {
  readonly label: string;
  readonly value: string;
}

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
  readonly decision: { readonly state: RunReviewState; readonly summary: string };
  readonly validation: { readonly state: RunReviewState; readonly summary: string };
  readonly outcome: { readonly state: RunReviewState; readonly summary: string };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunPackageV1 {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly producer: RunReviewProducer;
  readonly intent: { readonly title: string; readonly summary: string };
  readonly evidence: readonly RunReviewEvidence[];
  readonly candidate: { readonly summary: string; readonly diff_text: string | null };
  readonly decision: { readonly state: RunReviewState; readonly summary: string };
  readonly validation: { readonly state: RunReviewState; readonly summary: string };
  readonly outcome: { readonly state: RunReviewState; readonly summary: string };
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RunReviewAgentSummary {
  readonly run_id: string;
  readonly producer: RunReviewProducer;
  readonly intent: string;
  readonly decision: RunReviewState;
  readonly validation: RunReviewState;
  readonly outcome: RunReviewState;
  readonly summary: string;
}

const states = new Set<string>([
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isState(value: unknown): value is RunReviewState {
  return typeof value === "string" && states.has(value);
}

function readText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new TypeError(`Run Package ${key} must be a string.`);
  return value;
}

function readSection(value: unknown, label: string): { state: RunReviewState; summary: string } {
  if (!isRecord(value) || !isState(value.state) || typeof value.summary !== "string") {
    throw new TypeError(`Run Package ${label} is invalid.`);
  }
  return { state: value.state, summary: value.summary };
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|signature)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(/\/(?:Users|home|tmp|private\/tmp|var\/folders)\/[^\s"'`]+/g, "[local-path]");
}

export function buildRunPackage(review: RunReviewView): RunPackageV1 {
  return {
    schema_version: 1,
    run_id: redactText(review.runId),
    producer: review.producer,
    intent: {
      title: redactText(review.intent.title),
      summary: redactText(review.intent.summary),
    },
    evidence: review.evidence.map((item) => ({
      label: redactText(item.label),
      value: redactText(item.value),
    })),
    candidate: {
      summary: redactText(review.candidate.summary),
      diff_text: review.candidate.diffText === null ? null : redactText(review.candidate.diffText),
    },
    decision: {
      state: review.decision.state,
      summary: redactText(review.decision.summary),
    },
    validation: {
      state: review.validation.state,
      summary: redactText(review.validation.summary),
    },
    outcome: { state: review.outcome.state, summary: redactText(review.outcome.summary) },
    created_at: review.createdAt,
    updated_at: review.updatedAt,
  };
}

export function parseRunPackage(value: unknown): RunPackageV1 {
  if (!isRecord(value)) throw new TypeError("Run Package must be an object.");
  if (value.schema_version !== 1) {
    throw new TypeError(`Unsupported Run Package schema version: ${String(value.schema_version)}`);
  }
  if (value.producer !== "local_source_merge" && value.producer !== "cloud_improve") {
    throw new TypeError("Run Package producer is invalid.");
  }
  if (!isRecord(value.intent)) throw new TypeError("Run Package intent is invalid.");
  if (!Array.isArray(value.evidence)) throw new TypeError("Run Package evidence is invalid.");
  const evidence = value.evidence.map((entry) => {
    if (!isRecord(entry)) throw new TypeError("Run Package evidence entry is invalid.");
    return { label: readText(entry, "label"), value: readText(entry, "value") };
  });
  if (!isRecord(value.candidate)) throw new TypeError("Run Package candidate is invalid.");
  const diffText = value.candidate.diff_text;
  if (diffText !== null && typeof diffText !== "string") {
    throw new TypeError("Run Package candidate diff is invalid.");
  }
  return {
    schema_version: 1,
    run_id: readText(value, "run_id"),
    producer: value.producer,
    intent: {
      title: readText(value.intent, "title"),
      summary: readText(value.intent, "summary"),
    },
    evidence,
    candidate: { summary: readText(value.candidate, "summary"), diff_text: diffText },
    decision: readSection(value.decision, "decision"),
    validation: readSection(value.validation, "validation"),
    outcome: readSection(value.outcome, "outcome"),
    created_at: readText(value, "created_at"),
    updated_at: readText(value, "updated_at"),
  };
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
