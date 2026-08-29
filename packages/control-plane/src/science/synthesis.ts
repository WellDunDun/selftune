import { createHash } from "node:crypto";

import {
  CandidateEvidenceExample,
  CandidateEvidence,
  CandidateSnapshot,
  SynthesisCandidate,
  type EvidenceSession,
  type SynthesisCandidate as SynthesisCandidateType,
} from "../domain";

export interface SynthesisThresholds {
  minSupport: number;
  minLift: number;
  minSequenceConsistency: number;
  minOutcomeQuality: number;
  minCompletionRate?: number;
}

export const defaultSynthesisThresholds: SynthesisThresholds = {
  minSupport: 3,
  minLift: 1.25,
  minSequenceConsistency: 0.65,
  minOutcomeQuality: 0.6,
  minCompletionRate: 0.6,
};

const round = (value: number, places = 4): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

const normalizeSkill = (value: string): string => value.trim().toLocaleLowerCase("en-US");

const normalizeSequence = (skills: ReadonlyArray<string>): string[] => {
  const sequence: string[] = [];
  for (const value of skills) {
    const skill = normalizeSkill(value);
    if (skill && sequence[sequence.length - 1] !== skill) sequence.push(skill);
  }
  return sequence;
};

const stableHash = (value: string): string => createHash("sha256").update(value).digest("hex");

function deduplicateSessions(sessions: ReadonlyArray<EvidenceSession>): EvidenceSession[] {
  const byId = new Map<string, EvidenceSession>();
  for (const session of sessions) {
    const current = byId.get(session.sessionId);
    if (!current || session.occurredAt < current.occurredAt) byId.set(session.sessionId, session);
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.sessionId.localeCompare(right.sessionId),
  );
}

function collapseCorrelatedSessions(
  sessions: ReadonlyArray<EvidenceSession>,
  identity: (session: EvidenceSession) => string,
): EvidenceSession[] {
  const fiveMinutes = 5 * 60 * 1000;
  const latestByIdentity = new Map<string, number>();
  return deduplicateSessions(sessions).filter((session) => {
    const timestamp = Date.parse(session.occurredAt);
    if (!Number.isFinite(timestamp)) return true;
    const key = `${session.projectId ?? "<unknown>"}:${identity(session)}`;
    const previous = latestByIdentity.get(key);
    latestByIdentity.set(key, timestamp);
    return previous === undefined || timestamp - previous > fiveMinutes;
  });
}

interface SessionSplit {
  readonly supporting: string[];
  readonly heldOut: string[];
}

function splitSessions(sessionIds: ReadonlyArray<string>): SessionSplit {
  const ranked = [...sessionIds].sort((left, right) =>
    stableHash(left).localeCompare(stableHash(right)),
  );
  if (ranked.length < 2) return { supporting: ranked, heldOut: [] };
  const heldOutCount = Math.max(1, Math.floor(ranked.length * 0.3));
  return {
    supporting: ranked.slice(heldOutCount).sort(),
    heldOut: ranked.slice(0, heldOutCount).sort(),
  };
}

interface EvidencePartition {
  readonly supportingSessionIds: string[];
  readonly heldOutSessionIds: string[];
  readonly supportingExamples: Array<typeof CandidateEvidenceExample.Type>;
  readonly heldOutExamples: Array<typeof CandidateEvidenceExample.Type>;
}

function partitionEvidence(sessions: ReadonlyArray<EvidenceSession>): EvidencePartition {
  const split = splitSessions(sessions.map((session) => session.sessionId));
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const examples = (sessionIds: ReadonlyArray<string>) =>
    sessionIds.flatMap((sessionId) => {
      const session = byId.get(sessionId);
      return session?.query
        ? [CandidateEvidenceExample.make({ sessionId, excerpt: session.query })]
        : [];
    });
  return {
    supportingSessionIds: split.supporting,
    heldOutSessionIds: split.heldOut,
    supportingExamples: examples(split.supporting),
    heldOutExamples: examples(split.heldOut),
  };
}

function temporalSpanDays(sessions: ReadonlyArray<EvidenceSession>): number {
  const timestamps = sessions
    .map((session) => Date.parse(session.occurredAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (timestamps.length < 2) return 0;
  return round((timestamps[timestamps.length - 1]! - timestamps[0]!) / 86_400_000, 2);
}

function outcomeQuality(sessions: ReadonlyArray<EvidenceSession>): number {
  if (sessions.length === 0) return 0;
  return round(
    sessions.reduce(
      (total, session) => total + (session.outcomeScore ?? (session.successful ? 1 : 0)),
      0,
    ) / sessions.length,
  );
}

function evidence(input: {
  sessions: ReadonlyArray<EvidenceSession>;
  coUsageLift: number | null;
  sequenceConsistency: number | null;
  completionRate: number | null;
}): typeof CandidateEvidence.Type {
  const projectDiversity = new Set(
    input.sessions.map((session) => session.projectId).filter((project) => project !== null),
  ).size;
  const support = input.sessions.length;
  const quality = outcomeQuality(input.sessions);
  const recurrence = Math.min(1, temporalSpanDays(input.sessions) / 14);
  const diversity = Math.min(1, projectDiversity / 3);
  const weightedEvidence = [
    [Math.min(1, support / 6), 0.25],
    [diversity, 0.15],
    [recurrence, 0.1],
    [quality, 0.25],
    ...(input.sequenceConsistency === null ? [] : [[input.sequenceConsistency, 0.15]]),
    ...(input.coUsageLift === null
      ? []
      : [[Math.min(1, Math.max(0, (input.coUsageLift - 1) / 2)), 0.1]]),
  ] as const;
  const availableWeight = weightedEvidence.reduce((total, [, weight]) => total + weight, 0);
  const confidence = round(
    weightedEvidence.reduce((total, [value, weight]) => total + value * weight, 0) /
      availableWeight,
  );
  return CandidateEvidence.make({
    evidenceVersion: 1,
    supportSessions: support,
    projectDiversity,
    temporalSpanDays: temporalSpanDays(input.sessions),
    outcomeQuality: quality,
    coUsageLift: input.coUsageLift === null ? null : round(input.coUsageLift),
    sequenceConsistency:
      input.sequenceConsistency === null ? null : round(input.sequenceConsistency),
    completionRate: input.completionRate === null ? null : round(input.completionRate),
    confidence,
    uncertainty: round(1 / Math.sqrt(Math.max(1, support)) + (projectDiversity < 2 ? 0.15 : 0)),
    exploratory: projectDiversity < 2,
  });
}

export function buildWorkflowCandidates(
  inputSessions: ReadonlyArray<EvidenceSession>,
  thresholds: SynthesisThresholds = defaultSynthesisThresholds,
): SynthesisCandidateType[] {
  const sessions = collapseCorrelatedSessions(inputSessions, (session) =>
    JSON.stringify({
      skills: normalizeSequence(session.orderedSkills),
      query: normalizeIntent(session.query),
    }),
  );
  const total = sessions.length;
  if (total === 0) return [];

  const marginalCounts = new Map<string, number>();
  for (const session of sessions) {
    for (const skill of new Set(normalizeSequence(session.orderedSkills))) {
      marginalCounts.set(skill, (marginalCounts.get(skill) ?? 0) + 1);
    }
  }

  const sequenceGroups = new Map<string, { skills: string[]; sessions: EvidenceSession[] }>();
  const setCounts = new Map<string, number>();
  for (const session of sessions) {
    const skills = normalizeSequence(session.orderedSkills);
    if (skills.length < 2) continue;
    if (session.successful) {
      const sequenceKey = JSON.stringify(skills);
      const group = sequenceGroups.get(sequenceKey) ?? { skills, sessions: [] };
      group.sessions.push(session);
      sequenceGroups.set(sequenceKey, group);
    }
    const setKey = JSON.stringify([...skills].sort());
    setCounts.set(setKey, (setCounts.get(setKey) ?? 0) + 1);
  }

  const candidates: SynthesisCandidateType[] = [];
  for (const group of sequenceGroups.values()) {
    if (group.sessions.length < thresholds.minSupport) continue;
    const jointProbability = group.sessions.length / total;
    const marginalProduct = group.skills.reduce(
      (product, skill) => product * ((marginalCounts.get(skill) ?? 0) / total),
      1,
    );
    const coUsageLift = marginalProduct > 0 ? jointProbability / marginalProduct : 0;
    const setKey = JSON.stringify([...group.skills].sort());
    const sequenceConsistency =
      group.sessions.length / (setCounts.get(setKey) ?? group.sessions.length);
    const sessionsWithAny = sessions.filter((session) => {
      const present = new Set(normalizeSequence(session.orderedSkills));
      return group.skills.some((skill) => present.has(skill));
    }).length;
    const completionRate = sessionsWithAny > 0 ? group.sessions.length / sessionsWithAny : 0;
    const metrics = evidence({
      sessions: group.sessions,
      coUsageLift,
      sequenceConsistency,
      completionRate,
    });
    if (
      coUsageLift < thresholds.minLift ||
      sequenceConsistency < thresholds.minSequenceConsistency ||
      completionRate < (thresholds.minCompletionRate ?? 0.6) ||
      metrics.outcomeQuality < thresholds.minOutcomeQuality
    ) {
      continue;
    }
    const partition = partitionEvidence(group.sessions);
    const generatedAt = group.sessions
      .map((session) => session.occurredAt)
      .sort((left, right) => right.localeCompare(left))[0]!;
    const identity = JSON.stringify({
      skills: group.skills,
      sessions: group.sessions.map((s) => s.sessionId).sort(),
    });
    candidates.push(
      SynthesisCandidate.make({
        candidateId: `workflow-${stableHash(identity).slice(0, 20)}`,
        kind: "workflow_combination",
        title: group.skills.join(" -> "),
        summary: `${group.sessions.length} successful sessions repeatedly used this ordered workflow.`,
        skillNames: group.skills,
        evidence: metrics,
        supportingSessionIds: partition.supportingSessionIds,
        heldOutSessionIds: partition.heldOutSessionIds,
        supportingExamples: partition.supportingExamples,
        heldOutExamples: partition.heldOutExamples,
        redactedExcerpts: partition.supportingExamples
          .map((example) => example.excerpt)
          .slice(0, 3),
        generatedAt,
        status: "pending",
        decision: null,
        decisionHistory: [],
      }),
    );
  }
  return candidates.sort(
    (left, right) =>
      right.evidence.confidence - left.evidence.confidence ||
      left.candidateId.localeCompare(right.candidateId),
  );
}

const normalizeIntent = (query: string): string =>
  query
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const conversationalControlIntents = new Set([
  "commit",
  "completing task",
  "continue",
  "do it",
  "done",
  "go ahead",
  "hello",
  "hi",
  "keep going",
  "ok",
  "okay",
  "ping",
  "proceed",
  "reply with exactly local ok",
  "reply with exactly ok",
  "respond with exactly the word hello",
  "test",
  "thanks",
  "thank you",
  "who are you",
  "are they done",
  "yes",
  "yes please",
]);

const internalPromptPrefixes = [
  "suggestion mode",
  "full transcript available at path",
  "environment context cwd",
  "system instruction",
  "the user has attached these files read them before proceeding",
  "this session is being continued from a previous conversation",
  "your task is to create a detailed summary of the conversation",
  "you are a documentation writer for the selftune project",
  "you are a rigorous skill session evaluator",
  "you are a skill description optimizer for an ai agent routing system",
  "you are an evaluation assistant",
  "you are generating test queries for a coding agent skill",
  "you are a test engineer generating skill unit tests",
  "you are agent session",
] as const;

/**
 * Coverage gaps must represent user work, not turn-control messages or prompts
 * generated by SelfTune's own evaluation and orchestration machinery.
 */
export function isCoverageIntentEligible(query: string): boolean {
  const intent = normalizeIntent(query);
  if (!intent || conversationalControlIntents.has(intent)) return false;
  if (internalPromptPrefixes.some((prefix) => intent.startsWith(prefix))) return false;
  if (/^you are agent .+ continue your paperclip work$/.test(intent)) return false;

  const lexicalTokens = intent.split(" ").filter(Boolean);
  if (intent.length < 12 || lexicalTokens.length < 2) return false;

  const wrapperTokens = intent.match(/\b(command name|command message|command args|context)\b/g);
  return (wrapperTokens?.length ?? 0) < 3;
}

export function buildCoverageGapCandidates(
  inputSessions: ReadonlyArray<EvidenceSession>,
  thresholds: Pick<
    SynthesisThresholds,
    "minSupport" | "minOutcomeQuality"
  > = defaultSynthesisThresholds,
): SynthesisCandidateType[] {
  const sessions = collapseCorrelatedSessions(
    inputSessions.filter(
      (session) =>
        session.successful &&
        normalizeSequence(session.orderedSkills).length === 0 &&
        isCoverageIntentEligible(session.query),
    ),
    (session) => normalizeIntent(session.query),
  ).filter(
    (session) =>
      session.successful &&
      normalizeSequence(session.orderedSkills).length === 0 &&
      isCoverageIntentEligible(session.query),
  );
  const groups = new Map<string, EvidenceSession[]>();
  for (const session of sessions) {
    const intent = normalizeIntent(session.query);
    if (!intent) continue;
    const group = groups.get(intent) ?? [];
    group.push(session);
    groups.set(intent, group);
  }
  const candidates: SynthesisCandidateType[] = [];
  for (const [intent, group] of groups) {
    if (group.length < thresholds.minSupport) continue;
    const metrics = evidence({
      sessions: group,
      coUsageLift: null,
      sequenceConsistency: null,
      completionRate: null,
    });
    if (metrics.outcomeQuality < thresholds.minOutcomeQuality) continue;
    const partition = partitionEvidence(group);
    const generatedAt = group
      .map((session) => session.occurredAt)
      .sort((left, right) => right.localeCompare(left))[0]!;
    candidates.push(
      SynthesisCandidate.make({
        candidateId: `coverage-${stableHash(JSON.stringify({ intent, sessions: group.map((s) => s.sessionId).sort() })).slice(0, 20)}`,
        kind: "coverage_gap",
        title: intent.slice(0, 96),
        summary: `${group.length} successful sessions repeated this procedure without a skill.`,
        skillNames: [],
        evidence: metrics,
        supportingSessionIds: partition.supportingSessionIds,
        heldOutSessionIds: partition.heldOutSessionIds,
        supportingExamples: partition.supportingExamples,
        heldOutExamples: partition.heldOutExamples,
        redactedExcerpts: partition.supportingExamples
          .map((example) => example.excerpt)
          .slice(0, 3),
        generatedAt,
        status: "pending",
        decision: null,
        decisionHistory: [],
      }),
    );
  }
  return candidates.sort(
    (left, right) =>
      right.evidence.confidence - left.evidence.confidence ||
      left.candidateId.localeCompare(right.candidateId),
  );
}

export function buildCandidateSnapshot(
  sessions: ReadonlyArray<EvidenceSession>,
): typeof CandidateSnapshot.Type {
  const candidates = [
    ...buildCoverageGapCandidates(sessions),
    ...buildWorkflowCandidates(sessions),
  ].sort(
    (left, right) =>
      right.evidence.confidence - left.evidence.confidence ||
      left.candidateId.localeCompare(right.candidateId),
  );
  const generatedAt =
    deduplicateSessions(sessions)
      .map((session) => session.occurredAt)
      .sort((left, right) => right.localeCompare(left))[0] ?? "1970-01-01T00:00:00.000Z";
  const snapshotId = stableHash(JSON.stringify({ evidenceVersion: 1, candidates }));
  return CandidateSnapshot.make({ snapshotId, evidenceVersion: 1, generatedAt, candidates });
}
