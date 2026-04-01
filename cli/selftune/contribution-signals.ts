import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { hostname } from "node:os";

import { readAlphaIdentity } from "./alpha-identity.js";
import { SELFTUNE_CONFIG_PATH } from "./constants.js";
import type { CreatorContributionConfig } from "./contribution-config.js";
import { queryGradingResults, queryTrustedSkillObservationRows } from "./localdb/queries.js";

export type ContributionSignal = "trigger" | "grade" | "miss_category";

export interface CreatorContributionRelayPayload {
  version: 1;
  signal_type: "skill_session";
  relay_destination: string;
  skill_hash: string;
  user_cohort: string;
  signals: {
    triggered?: boolean;
    invocation_type?: "explicit" | "implicit" | "contextual" | "missed";
    execution_grade?: "A" | "B" | "C" | "F";
    query_bucket?: string;
    miss_detected?: boolean;
  };
  timestamp_bucket: string;
  client_version: string;
}

export interface CreatorContributionSignalRecord {
  skill_name: string;
  creator_id: string;
  source_key: string;
  payload: CreatorContributionRelayPayload;
}

export interface ContributionSignalBuildOptions {
  now?: Date;
  clientVersion?: string;
  cohortSeed?: string;
}

function gradeBucket(value: number): "A" | "B" | "C" | "F" {
  if (value >= 0.9) return "A";
  if (value >= 0.75) return "B";
  if (value >= 0.5) return "C";
  return "F";
}

function bucketWeek(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function resolveContributionCohortSeed(explicitSeed?: string): string {
  if (explicitSeed?.trim()) return explicitSeed.trim();
  const alphaIdentity = readAlphaIdentity(SELFTUNE_CONFIG_PATH);
  return alphaIdentity?.cloud_user_id || alphaIdentity?.user_id || hostname() || "selftune-local";
}

export function buildContributionUserCohort(now: Date = new Date(), explicitSeed?: string): string {
  const monthBucket = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const basis = `${resolveContributionCohortSeed(explicitSeed)}:${monthBucket}`;
  return `uc_sha256_${createHash("sha256").update(basis).digest("hex").slice(0, 12)}`;
}

export function classifyContributionQueryBucket(query: string | null | undefined): string {
  const text = (query ?? "").toLowerCase();
  if (!text) return "other";

  const patterns: Array<[string, RegExp]> = [
    ["comparison", /\b(compare|comparison|versus|vs\b|trade[- ]?off|which is better)\b/],
    ["troubleshooting", /\b(debug|debugging|fix|broken|not working|issue|error|troubleshoot)\b/],
    ["migration", /\b(migrate|migration|upgrade|move from|switch to|convert)\b/],
    ["configuration", /\b(config|configure|configuration|setup|set up)\b/],
    ["analysis", /\b(analyze|analysis|evaluate|assess|review)\b/],
    ["search", /\b(search|find|lookup)\b/],
    ["generation", /\b(generate|create|write|draft)\b/],
    ["testing", /\b(test|testing|spec|assert|regression)\b/],
    ["refactoring", /\b(refactor|cleanup|clean up|restructure)\b/],
    ["documentation", /\b(doc|docs|documentation|readme)\b/],
  ];

  for (const [bucket, pattern] of patterns) {
    if (pattern.test(text)) return bucket;
  }
  return "other";
}

function invocationType(
  invocationMode: string | null,
  triggered: number,
): "explicit" | "implicit" | "contextual" | "missed" {
  if (triggered === 0) return "missed";
  if (invocationMode === "explicit") return "explicit";
  if (invocationMode === "implicit" || invocationMode === "inferred") return "implicit";
  return "contextual";
}

export function buildCreatorDirectedContributionSignals(
  db: Database,
  configs: CreatorContributionConfig[],
  options: ContributionSignalBuildOptions = {},
): CreatorContributionSignalRecord[] {
  const bySkill = new Map(configs.map((config) => [config.skill_name, config]));
  const gradingBySession = new Map<string, "A" | "B" | "C" | "F">();
  for (const row of queryGradingResults(db)) {
    const source = typeof row.mean_score === "number" ? row.mean_score : row.pass_rate;
    if (typeof source === "number" && !gradingBySession.has(row.session_id)) {
      gradingBySession.set(row.session_id, gradeBucket(source));
    }
  }

  const cohort = buildContributionUserCohort(options.now ?? new Date(), options.cohortSeed);
  const clientVersion = options.clientVersion ?? "local-preview";

  return queryTrustedSkillObservationRows(db)
    .filter((row) => bySkill.has(row.skill_name))
    .map((row) => {
      const config = bySkill.get(row.skill_name)!;
      const signals: CreatorContributionRelayPayload["signals"] = {};
      if (config.contribution.signals.includes("trigger")) {
        signals.triggered = row.triggered === 1;
        signals.invocation_type = invocationType(row.invocation_mode, row.triggered);
        signals.miss_detected = row.triggered === 0;
      }
      if (config.contribution.signals.includes("grade")) {
        const grade = gradingBySession.get(row.session_id);
        if (grade) signals.execution_grade = grade;
      }
      if (config.contribution.signals.includes("miss_category")) {
        signals.query_bucket = classifyContributionQueryBucket(row.query_text);
      }

      return {
        skill_name: row.skill_name,
        creator_id: config.creator_id,
        source_key: createHash("sha256")
          .update(
            [
              row.skill_name,
              row.session_id,
              row.occurred_at ?? "",
              row.query_text,
              String(row.triggered),
              row.invocation_mode ?? "",
            ].join("::"),
          )
          .digest("hex")
          .slice(0, 16),
        payload: {
          version: 1 as const,
          signal_type: "skill_session" as const,
          relay_destination: config.creator_id,
          skill_hash: `sk_sha256_${createHash("sha256").update(config.skill_path).digest("hex").slice(0, 12)}`,
          user_cohort: cohort,
          signals,
          timestamp_bucket: bucketWeek(
            row.occurred_at ? new Date(row.occurred_at) : (options.now ?? new Date()),
          ),
          client_version: clientVersion,
        },
      };
    });
}

export function buildContributionPreview(
  db: Database,
  config: CreatorContributionConfig,
  options: ContributionSignalBuildOptions = {},
): {
  observedCount: number;
  triggerRate: number | null;
  missRate: number | null;
  gradedSessions: number;
  samplePayload: CreatorContributionRelayPayload;
} {
  const payloads = buildCreatorDirectedContributionSignals(db, [config], options);
  const observedCount = payloads.length;
  const triggeredCount = payloads.filter(
    (record) => record.payload.signals.triggered === true,
  ).length;
  const missedCount = payloads.filter(
    (record) => record.payload.signals.miss_detected === true,
  ).length;
  const gradedSessions = queryGradingResults(db).filter(
    (row) => row.skill_name === config.skill_name,
  ).length;

  return {
    observedCount,
    triggerRate: observedCount > 0 ? Math.round((triggeredCount / observedCount) * 100) : null,
    missRate: observedCount > 0 ? Math.round((missedCount / observedCount) * 100) : null,
    gradedSessions,
    samplePayload: payloads[0]?.payload ?? {
      version: 1,
      signal_type: "skill_session",
      relay_destination: config.creator_id,
      skill_hash: `sk_sha256_${createHash("sha256").update(config.skill_path).digest("hex").slice(0, 12)}`,
      user_cohort: buildContributionUserCohort(options.now ?? new Date(), options.cohortSeed),
      signals: {
        query_bucket: "other",
      },
      timestamp_bucket: bucketWeek(options.now ?? new Date()),
      client_version: options.clientVersion ?? "local-preview",
    },
  };
}
