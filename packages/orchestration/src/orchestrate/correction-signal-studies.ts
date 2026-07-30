import { createHash } from "node:crypto";

import type { Database } from "bun:sqlite";
import {
  getCorrectionSignalCandidate,
  getCorrectionStudyDraft,
  getMeta,
  setMeta,
  upsertCorrectionSignalCandidate,
  upsertCorrectionStudyDraft,
} from "@selftune/local-store";
import {
  discoverExplicitCorrectionSignalPage,
  type CorrectionSignalDiscoveryOptions,
} from "@selftune/runtime/correction-study/signal-discovery";
import {
  discoverLegacyCorrectionSignalPage,
  LEGACY_CORRECTION_SIGNAL_CHECKPOINT_NAMESPACE,
} from "@selftune/runtime/correction-study/legacy-signal-discovery";
import { buildStudyDraft } from "@selftune/skill-intelligence/study-drafts";
import * as Effect from "effect/Effect";

const PAGE_SIZE = 20;
const MAX_PAGES = 3;
const MAX_SIGNALS = 40;
const CHECKPOINT_META_KEY = "orchestrate.correction-signal-history.v1";
const LEGACY_CHECKPOINT_META_KEY = `orchestrate.correction-signal-history.${LEGACY_CORRECTION_SIGNAL_CHECKPOINT_NAMESPACE}`;

type PersistableCorrectionSignal = {
  readonly candidate_id: string;
  readonly evidence_level: "E0" | "E0.5";
  readonly review_status: "review_required" | "deferred";
  readonly reason: string;
  readonly skill: {
    readonly name: string;
    readonly pre_revision: string | null;
    readonly post_revision: string | null;
  };
  readonly source: {
    readonly session_id: string;
    readonly prompt_id: string;
    readonly raw_source_ref_digest: string | null;
  };
  readonly raw_edit_digest: string | null;
  readonly deferred_skill_names: readonly string[] | null;
  readonly correction_intent: string;
};

type Checkpoint = {
  readonly version: 1;
  readonly state: "active" | "complete";
  readonly cursor: string | null;
};

export interface CorrectionSignalStudyStageSummary {
  readonly detected: number;
  readonly persisted: number;
  readonly drafted: number;
  readonly deferred: number;
  readonly errors: number;
}

export interface CorrectionSignalStudyStageOptions {
  readonly database: Database;
  readonly discoverPage?: typeof discoverExplicitCorrectionSignalPage;
  readonly discoveryOptions?: CorrectionSignalDiscoveryOptions;
  readonly now?: () => string;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function skillId(skillName: string): string {
  return `skill-${createHash("sha256").update(skillName).digest("hex").slice(0, 32)}`;
}

function exactRevision(value: string | null): value is string {
  return value !== null && /^[a-f0-9]{64}$/.test(value);
}

function revisionValid(signal: PersistableCorrectionSignal): boolean {
  return (
    signal.review_status === "review_required" &&
    exactRevision(signal.skill.pre_revision) &&
    exactRevision(signal.skill.post_revision) &&
    signal.skill.pre_revision !== signal.skill.post_revision
  );
}

function redactedText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
      "[redacted-private-key]",
    )
    .replace(
      /\b(?:api[_-]?key|token|secret|password|authorization|cookie|signature)\s*[:=]\s*[^\s,;]+/gi,
      "[redacted]",
    )
    .replace(/(?:^|([\s"'`]))(?:\/(?:[^\s"'`]+)|[a-zA-Z]:\\[^\s"'`]+)/g, "$1[local-path]");
}

function readCheckpoint(database: Database, key: string): string | null {
  const encoded = getMeta(database, key);
  if (!encoded) return null;
  try {
    const checkpoint: unknown = JSON.parse(encoded);
    if (
      typeof checkpoint === "object" &&
      checkpoint !== null &&
      "version" in checkpoint &&
      checkpoint.version === 1 &&
      "state" in checkpoint &&
      (checkpoint.state === "active" || checkpoint.state === "complete") &&
      "cursor" in checkpoint &&
      (typeof checkpoint.cursor === "string" || checkpoint.cursor === null)
    ) {
      return checkpoint.state === "active" ? checkpoint.cursor : null;
    }
  } catch {
    // A malformed or old checkpoint safely restarts from the live page.
  }
  return null;
}

function writeCheckpoint(database: Database, key: string, cursor: string | null): void {
  const checkpoint: Checkpoint = {
    version: 1,
    state: cursor === null ? "complete" : "active",
    cursor,
  };
  setMeta(database, key, JSON.stringify(checkpoint));
}

function candidatePayload(signal: PersistableCorrectionSignal): string {
  return JSON.stringify({
    candidate_id: signal.candidate_id,
    evidence_level: signal.evidence_level,
    reason: signal.reason,
    skill: {
      name: signal.skill.name,
      pre_revision: signal.skill.pre_revision,
      post_revision: signal.skill.post_revision,
    },
    source: signal.source,
    raw_edit_digest: signal.raw_edit_digest,
    deferred_skill_names: signal.deferred_skill_names,
    correction_intent: redactedText(signal.correction_intent),
  });
}

function persistSignal(
  database: Database,
  signal: PersistableCorrectionSignal,
  now: string,
): boolean {
  const existing = Effect.runSync(getCorrectionSignalCandidate(database, signal.candidate_id));
  const payload = candidatePayload(signal);
  const attributable = revisionValid(signal);
  Effect.runSync(
    upsertCorrectionSignalCandidate(database, {
      candidate_id: signal.candidate_id,
      idempotency_key: `correction-signal:${signal.candidate_id}`,
      skill_id: skillId(signal.skill.name),
      skill_name: signal.skill.name,
      source_session_id: signal.source.session_id,
      evidence_level: signal.evidence_level,
      lifecycle: attributable ? "review_ready" : "deferred",
      reason: signal.reason,
      manifest_digest: digest(
        JSON.stringify({
          candidate_id: signal.candidate_id,
          source: signal.source,
          reason: signal.reason,
        }),
      ),
      signal_payload_digest: digest(payload),
      signal_payload_json: payload,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    }),
  );
  return attributable;
}

function persistDraft(
  database: Database,
  signal: PersistableCorrectionSignal,
  now: string,
): boolean {
  if (!exactRevision(signal.skill.pre_revision) || !exactRevision(signal.skill.post_revision))
    return false;
  const correctionIntent = redactedText(signal.correction_intent);
  const draft = buildStudyDraft({
    hypothesis: {
      hypothesis_id: `hypothesis-${signal.candidate_id}`,
      kind: "explicit_correction",
      skill_ids: [skillId(signal.skill.name)],
      task: `Correct ${signal.skill.name} behavior for a user task.`,
      observed_failure: `The agent required an explicit correction (${signal.reason}).`,
      correction_intent: correctionIntent,
      pre_edit_revision: signal.skill.pre_revision,
      post_edit_revision: signal.skill.post_revision,
      current_revision: signal.skill.post_revision,
      mutation_surface: "body",
      ambiguous: false,
      privacy_disposition: "redacted",
    },
    calibration_evidence: [
      {
        evidence_id: `evidence-${signal.candidate_id}`,
        source_reference: `session:${signal.source.session_id}:prompt:${signal.source.prompt_id}`,
        summary: `Explicit correction detected for ${signal.skill.name}.`,
        excerpt: correctionIntent,
      },
    ],
    hidden_references: [],
  });
  if (draft.disposition !== "ready_for_verifier") return false;
  const existing = Effect.runSync(getCorrectionStudyDraft(database, draft.draft_id));
  const payload = JSON.stringify(draft);
  Effect.runSync(
    upsertCorrectionStudyDraft(database, {
      draft_id: draft.draft_id,
      idempotency_key: `study-draft:${signal.candidate_id}:${draft.manifest_id}`,
      candidate_id: signal.candidate_id,
      skill_id: skillId(signal.skill.name),
      skill_name: signal.skill.name,
      source_revision: signal.skill.post_revision,
      evidence_level: signal.evidence_level,
      lifecycle: "review_ready",
      reason: signal.reason,
      manifest_digest: digest(
        JSON.stringify({ manifest_id: draft.manifest_id, draft_id: draft.draft_id }),
      ),
      study_payload_digest: digest(payload),
      study_payload_json: payload,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    }),
  );
  return true;
}

function persistPage(
  database: Database,
  signals: readonly PersistableCorrectionSignal[],
  now: () => string,
  summary: {
    detected: number;
    persisted: number;
    drafted: number;
    deferred: number;
    errors: number;
  },
): boolean {
  let complete = true;
  for (const signal of signals) {
    if (summary.detected >= MAX_SIGNALS) break;
    summary.detected += 1;
    try {
      const attributable = persistSignal(database, signal, now());
      summary.persisted += 1;
      if (!attributable) {
        summary.deferred += 1;
        continue;
      }
      if (persistDraft(database, signal, now())) summary.drafted += 1;
      else {
        summary.errors += 1;
        complete = false;
      }
    } catch {
      summary.errors += 1;
      complete = false;
    }
  }
  return complete;
}

/**
 * Bounded, fail-soft capture for one cursor-paged source. It stores only
 * redacted hypotheses and review drafts; it does not schedule replay or mutate skills.
 */
async function capturePagedCorrectionSignals(
  database: Database,
  checkpointKey: string,
  discoverPage: (input: { cursor: string | null; limit: number }) => {
    readonly items: readonly PersistableCorrectionSignal[];
    readonly next_cursor: string | null;
  },
  now: () => string,
): Promise<CorrectionSignalStudyStageSummary> {
  const summary = { detected: 0, persisted: 0, drafted: 0, deferred: 0, errors: 0 };
  let livePage: ReturnType<typeof discoverPage>;
  try {
    livePage = discoverPage({ cursor: null, limit: Math.min(PAGE_SIZE, MAX_SIGNALS) });
  } catch {
    return { ...summary, errors: 1 };
  }
  if (!persistPage(database, livePage.items, now, summary)) return summary;

  let cursor = readCheckpoint(database, checkpointKey) ?? livePage.next_cursor;
  if (cursor === null) {
    writeCheckpoint(database, checkpointKey, null);
    return summary;
  }

  for (let page = 1; page < MAX_PAGES && summary.detected < MAX_SIGNALS; page += 1) {
    let result: ReturnType<typeof discoverPage>;
    try {
      result = discoverPage({ cursor, limit: Math.min(PAGE_SIZE, MAX_SIGNALS - summary.detected) });
    } catch {
      summary.errors += 1;
      break;
    }
    if (!persistPage(database, result.items, now, summary)) break;
    cursor = result.next_cursor;
    writeCheckpoint(database, checkpointKey, cursor);
    if (!cursor) return summary;
  }
  return summary;
}

function combinedSummary(
  left: CorrectionSignalStudyStageSummary,
  right: CorrectionSignalStudyStageSummary,
): CorrectionSignalStudyStageSummary {
  return {
    detected: left.detected + right.detected,
    persisted: left.persisted + right.persisted,
    drafted: left.drafted + right.drafted,
    deferred: left.deferred + right.deferred,
    errors: left.errors + right.errors,
  };
}

export async function captureLegacyCorrectionSignalStudies(
  options: Pick<CorrectionSignalStudyStageOptions, "database" | "now"> & {
    readonly discoverPage?: typeof discoverLegacyCorrectionSignalPage;
  },
): Promise<CorrectionSignalStudyStageSummary> {
  const discoverPage = options.discoverPage ?? discoverLegacyCorrectionSignalPage;
  return capturePagedCorrectionSignals(
    options.database,
    LEGACY_CHECKPOINT_META_KEY,
    (input) => discoverPage(options.database, input),
    options.now ?? (() => new Date().toISOString()),
  );
}

/**
 * Bounded, fail-soft post-sync capture from explicit transcript evidence and
 * pre-existing legacy correction signals. Neither source schedules replay or mutates skills.
 */
export async function captureCorrectionSignalStudies(
  options: CorrectionSignalStudyStageOptions,
): Promise<CorrectionSignalStudyStageSummary> {
  const discoverPage = options.discoverPage ?? discoverExplicitCorrectionSignalPage;
  const explicit = await capturePagedCorrectionSignals(
    options.database,
    CHECKPOINT_META_KEY,
    (input) => discoverPage(options.database, input, options.discoveryOptions),
    options.now ?? (() => new Date().toISOString()),
  );
  const legacy = await captureLegacyCorrectionSignalStudies({
    database: options.database,
    now: options.now,
  });
  return combinedSummary(explicit, legacy);
}
