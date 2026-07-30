import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { Database } from "bun:sqlite";
import {
  buildCandidateSnapshot,
  CandidateSnapshot,
  EvidenceSession,
  generateCandidateEvals,
  isCoverageIntentEligible,
  type LibrarySnapshot,
  type SynthesisCandidate,
} from "@selftune/control-plane";
import * as Schema from "effect/Schema";

import { SELFTUNE_CONFIG_DIR } from "./constants.js";
import { createControlPlaneRuntime, type ControlPlaneRuntime } from "./control-plane-runtime.js";
import { writeCreateSkillDraft } from "./create/init.js";
import { buildCreateSkillDraft, type CreateSkillDraft } from "./create/templates.js";
import { runCreatePublish, type CreatePublishResult } from "./create/publish.js";
import { sanitizeConservative } from "./contribute/sanitize.js";
import { getDb } from "./localdb/db.js";
import { loadLibraryCatalog } from "./library/catalog.js";
import { extractActionableQueryText } from "./utils/query-filter.js";
import { CLIError } from "./utils/cli-error.js";
import { computeSkillVersionHash } from "./utils/skill-discovery.js";

export interface SynthesisOptions {
  configRoot?: string;
  runtime?: ControlPlaneRuntime;
  db?: Database;
  now?: Date;
  runCreatePublish?: typeof runCreatePublish;
}

export interface SynthesisReleaseGate {
  schema_version: 1;
  candidate_id: string;
  evidence_snapshot_id: string;
  candidate_revision_hash: string;
  skill_name: string;
  draft_path: string;
  revision_hash: string;
  evaluated_at: string;
  replay_exit_code: number;
  baseline_exit_code: number;
  held_out_eval_ids: string[];
  recommended: boolean;
  blockers: string[];
  evaluation: CreatePublishResult["package_evaluation"];
}

export interface SynthesisRelease {
  schema_version: 1;
  candidate_id: string;
  evidence_snapshot_id: string;
  candidate_revision_hash: string;
  skill_name: string;
  revision_hash: string;
  package_path: string;
  gate_path: string;
  released_at: string;
}

interface SessionRow {
  session_id: string;
  timestamp: string;
  cwd: string | null;
  skills_triggered_json: string | null;
  skills_invoked_json: string | null;
  errors_encountered: number | null;
  assistant_turns: number | null;
  last_user_query: string | null;
  canonical_source_ref: string | null;
}

interface QueryRow {
  session_id: string;
  query: string;
}

interface PromptRow {
  session_id: string;
  prompt_text: string;
}

interface SessionGradeRow {
  session_id: string;
  outcome_score: number | null;
}

const ReleaseEvalEntry = Schema.Struct({
  query: Schema.String,
  should_trigger: Schema.Boolean,
  source: Schema.Literals(["log", "synthetic"]),
  selftune_provenance: Schema.Struct({
    eval_id: Schema.String,
    kind: Schema.Literals(["positive", "negative", "boundary", "execution"]),
    source_session_ids: Schema.Array(Schema.String),
    evidence_snapshot_id: Schema.String,
    held_out: Schema.Boolean,
  }),
});

function snapshotPath(configRoot = SELFTUNE_CONFIG_DIR): string {
  return join(resolve(configRoot), "synthesis", "candidates.json");
}

function gatePath(candidateId: string, configRoot = SELFTUNE_CONFIG_DIR): string {
  return join(resolve(configRoot), "library", "release-gates", `${candidateId}.json`);
}

function releasePath(candidateId: string, configRoot = SELFTUNE_CONFIG_DIR): string {
  return join(resolve(configRoot), "library", "releases", `${candidateId}.json`);
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function candidateRevisionHash(candidate: SynthesisCandidate): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        candidate_id: candidate.candidateId,
        kind: candidate.kind,
        title: candidate.title,
        summary: candidate.summary,
        skill_names: candidate.skillNames,
        evidence: candidate.evidence,
        supporting_session_ids: candidate.supportingSessionIds,
        held_out_session_ids: candidate.heldOutSessionIds,
        supporting_examples: candidate.supportingExamples ?? [],
        held_out_examples: candidate.heldOutExamples ?? [],
        generated_at: candidate.generatedAt,
        decision: candidate.decision,
        decision_history: candidate.decisionHistory,
      }),
    )
    .digest("hex");
}

export function invalidateSynthesisReleaseAuthority(
  candidateId: string,
  configRoot?: string,
): void {
  rmSync(gatePath(candidateId, configRoot), { force: true });
}

function hasPassingPackageEvaluation(
  evaluation: CreatePublishResult["package_evaluation"],
  expected: { skillName: string; skillPath: string },
): evaluation is NonNullable<CreatePublishResult["package_evaluation"]> {
  return (
    evaluation !== null &&
    evaluation.skill_name === expected.skillName &&
    resolve(evaluation.skill_path) === resolve(expected.skillPath) &&
    evaluation.status === "passed" &&
    evaluation.evaluation_passed &&
    evaluation.replay.validation_mode === "host_replay" &&
    evaluation.replay.failed === 0 &&
    evaluation.baseline.adds_value &&
    (evaluation.routing?.failed ?? 0) === 0
  );
}

function validateReleaseEvalSet(
  path: string,
  expectedEvals: ReturnType<typeof generateCandidateEvals>,
): void {
  try {
    const actual = Schema.decodeUnknownSync(Schema.Array(ReleaseEvalEntry))(
      JSON.parse(readFileSync(path, "utf8")),
    );
    const expected = expectedEvals.filter((item) => item.heldOut || item.kind === "negative");
    const expectedById = new Map(expected.map((item) => [item.evalId, item]));
    if (actual.length !== expected.length) {
      throw new CLIError("Held-out eval case count changed.", "GUARD_BLOCKED");
    }
    for (const item of actual) {
      const provenance = item.selftune_provenance;
      const source = expectedById.get(provenance.eval_id);
      if (
        !source ||
        item.query !== source.query ||
        item.should_trigger !== (source.kind !== "negative") ||
        provenance.kind !== source.kind ||
        provenance.evidence_snapshot_id !== source.evidenceSnapshotId ||
        provenance.held_out !== source.heldOut ||
        JSON.stringify(provenance.source_session_ids) !== JSON.stringify(source.sourceSessionIds)
      ) {
        throw new CLIError(
          `Held-out eval ${provenance.eval_id} no longer matches its evidence source.`,
          "GUARD_BLOCKED",
        );
      }
    }
  } catch (error) {
    throw new CLIError(
      `Held-out eval set is invalid: ${error instanceof Error ? error.message : String(error)}`,
      "GUARD_BLOCKED",
      "Create a fresh draft from the current reviewed candidate before evaluating it.",
    );
  }
}

function projectIdentity(cwd: string | null): string | null {
  if (!cwd) return null;
  return `project-${createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16)}`;
}

function pseudonymizeSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function generatePackageEvals(
  snapshotId: string,
  candidate: SynthesisCandidate,
  targetSkillName: string,
) {
  return generateCandidateEvals(snapshotId, candidate, targetSkillName).map((item) => ({
    ...item,
    sourceSessionIds: item.sourceSessionIds.map(pseudonymizeSessionId),
  }));
}

function parseSkillNames(value: string | null): string[] {
  if (!value) return [];
  try {
    const decoded: unknown = JSON.parse(value);
    return Array.isArray(decoded)
      ? decoded.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function collectSynthesisEvidence(db: Database = getDb()): EvidenceSession[] {
  const sessionIntents = new Map<string, string>();
  const sessionsWithCanonicalPrompts = new Set<string>();
  const promptRows = db
    .query(
      `SELECT session_id, prompt_text
       FROM prompts
       WHERE prompt_kind = 'user' AND is_actionable = 1 AND COALESCE(prompt_text, '') <> ''
       ORDER BY COALESCE(prompt_index, 2147483647), occurred_at, prompt_id`,
    )
    .all() as PromptRow[];
  for (const row of promptRows) {
    sessionsWithCanonicalPrompts.add(row.session_id);
    if (sessionIntents.has(row.session_id)) continue;
    const actionable = extractActionableQueryText(row.prompt_text);
    if (actionable && isCoverageIntentEligible(actionable)) {
      sessionIntents.set(row.session_id, actionable);
    }
  }

  const queryRows = db
    .query(`SELECT session_id, query FROM queries ORDER BY timestamp, id`)
    .all() as QueryRow[];
  for (const row of queryRows) {
    if (sessionIntents.has(row.session_id) || sessionsWithCanonicalPrompts.has(row.session_id)) {
      continue;
    }
    const actionable = extractActionableQueryText(row.query);
    if (actionable && isCoverageIntentEligible(actionable)) {
      sessionIntents.set(row.session_id, actionable);
    }
  }

  const rows = db
    .query(
      `SELECT st.session_id, st.timestamp, st.cwd, st.skills_triggered_json,
              st.skills_invoked_json, st.errors_encountered, st.assistant_turns,
              st.last_user_query, s.raw_source_ref AS canonical_source_ref
       FROM session_telemetry st
       LEFT JOIN sessions s ON s.session_id = st.session_id
       ORDER BY st.timestamp, st.session_id`,
    )
    .all() as SessionRow[];
  const sessionGrades = new Map(
    (
      db
        .query(
          `SELECT session_id, AVG(COALESCE(mean_score, pass_rate)) AS outcome_score
           FROM grading_results
           WHERE mean_score IS NOT NULL OR pass_rate IS NOT NULL
           GROUP BY session_id`,
        )
        .all() as SessionGradeRow[]
    ).map((row) => [row.session_id, row.outcome_score]),
  );

  return rows.flatMap((row) => {
    if (row.canonical_source_ref) {
      try {
        const source = JSON.parse(row.canonical_source_ref) as { path?: unknown };
        if (typeof source.path === "string" && /[/\\]subagents[/\\]/i.test(source.path)) {
          return [];
        }
      } catch {
        // Invalid provenance is ignored here; the session still passes text eligibility below.
      }
    }
    const skills = parseSkillNames(row.skills_invoked_json);
    const orderedSkills = skills.length > 0 ? skills : parseSkillNames(row.skills_triggered_json);
    const gradedOutcome = sessionGrades.get(row.session_id);
    const fallbackSuccessful =
      (row.errors_encountered ?? 0) === 0 && (row.assistant_turns ?? 0) > 0;
    const successful =
      gradedOutcome === undefined
        ? fallbackSuccessful
        : gradedOutcome !== null && gradedOutcome >= 0.7;
    let query = sessionIntents.get(row.session_id) ?? "";
    if (!query && !sessionsWithCanonicalPrompts.has(row.session_id)) {
      const fallback = extractActionableQueryText(row.last_user_query ?? "");
      query = fallback && isCoverageIntentEligible(fallback) ? fallback : "";
    }
    return [
      EvidenceSession.make({
        sessionId: row.session_id,
        projectId: projectIdentity(row.cwd),
        occurredAt: row.timestamp,
        successful,
        outcomeScore: gradedOutcome ?? (fallbackSuccessful ? 1 : 0),
        orderedSkills,
        query: sanitizeConservative(query, row.cwd ? basename(row.cwd) : undefined),
      }),
    ];
  });
}

export function loadCandidateSnapshot(configRoot?: string): CandidateSnapshot {
  const path = snapshotPath(configRoot);
  if (!existsSync(path)) {
    return CandidateSnapshot.make({
      snapshotId: "empty",
      evidenceVersion: 1,
      generatedAt: "1970-01-01T00:00:00.000Z",
      candidates: [],
    });
  }
  try {
    return Schema.decodeUnknownSync(CandidateSnapshot)(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new CLIError(
      `Candidate store is invalid: ${error instanceof Error ? error.message : String(error)}`,
      "GUARD_BLOCKED",
      `Move ${path} aside and run selftune library synthesize scan.`,
    );
  }
}

export function saveCandidateSnapshot(snapshot: CandidateSnapshot, configRoot?: string): void {
  const path = snapshotPath(configRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

async function withRuntime<T>(
  options: SynthesisOptions,
  operation: (runtime: ControlPlaneRuntime) => Promise<T>,
): Promise<T> {
  const runtime = options.runtime ?? createControlPlaneRuntime();
  try {
    return await operation(runtime);
  } finally {
    if (!options.runtime) await runtime.dispose();
  }
}

export async function scanSynthesisCandidates(
  options: SynthesisOptions = {},
): Promise<CandidateSnapshot> {
  const generated = generateSynthesisCandidateSnapshot(options);
  return withRuntime(options, async (runtime) => {
    await runtime.mergeCandidates(loadCandidateSnapshot(options.configRoot));
    const merged = await runtime.mergeCandidates(generated);
    saveCandidateSnapshot(merged, options.configRoot);
    return merged;
  });
}

export function generateSynthesisCandidateSnapshot(
  options: Pick<SynthesisOptions, "configRoot" | "db"> = {},
): CandidateSnapshot {
  return applyRemoteDecisionHistory(
    buildCandidateSnapshot(collectSynthesisEvidence(options.db)),
    options.configRoot,
  );
}

function applyRemoteDecisionHistory(
  snapshot: CandidateSnapshot,
  configRoot?: string,
): CandidateSnapshot {
  const path = join(
    resolve(configRoot ?? SELFTUNE_CONFIG_DIR),
    "synthesis",
    "remote-decisions.json",
  );
  if (!existsSync(path)) return snapshot;
  try {
    const remote = JSON.parse(readFileSync(path, "utf8")) as {
      decisions?: Array<{
        candidate_id?: string;
        status?: SynthesisCandidate["status"];
        decision_history?: SynthesisCandidate["decisionHistory"];
      }>;
    };
    const decisions = new Map(
      (remote.decisions ?? [])
        .filter(
          (entry) =>
            typeof entry.candidate_id === "string" && Array.isArray(entry.decision_history),
        )
        .map((entry) => [entry.candidate_id!, entry]),
    );
    return CandidateSnapshot.make({
      ...snapshot,
      candidates: snapshot.candidates.map((candidate) => {
        const remoteDecision = decisions.get(candidate.candidateId);
        const history = remoteDecision?.decision_history ?? [];
        if (history.length === 0) return candidate;
        return {
          ...candidate,
          status: remoteDecision?.status ?? candidate.status,
          decision: history.at(-1) ?? null,
          decisionHistory: history,
        };
      }),
    });
  } catch {
    return snapshot;
  }
}

export async function reviewSynthesisCandidate(
  input: {
    candidateId: string;
    action: "accept" | "reject" | "snooze" | "edit";
    reason: string;
    snoozedUntil?: string | null;
    title?: string;
    summary?: string;
  },
  options: SynthesisOptions = {},
): Promise<SynthesisCandidate> {
  return withRuntime(options, async (runtime) => {
    await runtime.mergeCandidates(loadCandidateSnapshot(options.configRoot));
    const candidate = await runtime.decideCandidate({
      ...input,
      decidedAt: (options.now ?? new Date()).toISOString(),
    });
    saveCandidateSnapshot(await runtime.candidateSnapshot(), options.configRoot);
    invalidateSynthesisReleaseAuthority(input.candidateId, options.configRoot);
    return candidate;
  });
}

function synthesizedDraft(
  candidate: SynthesisCandidate,
  snapshot: CandidateSnapshot,
  outputDir?: string,
  sourceSkillRevisions: Array<{
    skill_id: string;
    skill_name: string;
    revision_hash: string;
  }> = [],
): CreateSkillDraft {
  const draft = buildCreateSkillDraft({
    name: candidate.title,
    description: candidate.summary,
    outputDir: outputDir ?? join(SELFTUNE_CONFIG_DIR, "library", "drafts"),
  });
  const evals = generatePackageEvals(snapshot.snapshotId, candidate, draft.skill_name);
  const releaseEvals = evals
    .filter((item) => item.heldOut || item.kind === "negative")
    .map((item) => ({
      query: item.query,
      should_trigger: item.kind !== "negative",
      source: item.sourceSessionIds.length > 0 ? "log" : "synthetic",
      selftune_provenance: {
        eval_id: item.evalId,
        kind: item.kind,
        source_session_ids: item.sourceSessionIds,
        evidence_snapshot_id: item.evidenceSnapshotId,
        held_out: item.heldOut,
      },
    }));
  const workflow =
    candidate.skillNames.length > 0
      ? [
          `# ${candidate.title} Workflow`,
          "",
          "## Evidence-backed sequence",
          "",
          ...candidate.skillNames.map((skill, index) => `${index + 1}. Run the ${skill} workflow.`),
          "",
          "Keep the source skills intact until held-out comparison recommends release.",
          "",
        ].join("\n")
      : draft.files.find((file) => file.relative_path === "workflows/default.md")!.content;
  const provenance = {
    schema_version: 1,
    generator_version: "selftune-synthesis-v1",
    candidate_id: candidate.candidateId,
    evidence_snapshot_id: snapshot.snapshotId,
    source_skill_revisions: sourceSkillRevisions,
    supporting_session_ids: candidate.supportingSessionIds.map(pseudonymizeSessionId),
    held_out_session_ids: candidate.heldOutSessionIds.map(pseudonymizeSessionId),
    eval_set_ids: evals.map((item) => item.evalId),
    release_eval_ids: evals
      .filter((item) => item.heldOut || item.kind === "negative")
      .map((item) => item.evalId),
    release_state: "validation_required",
  };
  return {
    ...draft,
    files: [
      ...draft.files.map((file) =>
        file.relative_path === "workflows/default.md" ? { ...file, content: workflow } : file,
      ),
      {
        relative_path: "selftune.synthesis.json",
        absolute_path: join(draft.skill_dir, "selftune.synthesis.json"),
        content: `${JSON.stringify(provenance, null, 2)}\n`,
      },
      {
        relative_path: "evals/generated.json",
        absolute_path: join(draft.skill_dir, "evals", "generated.json"),
        content: `${JSON.stringify(evals, null, 2)}\n`,
      },
      {
        relative_path: "evals/release.json",
        absolute_path: join(draft.skill_dir, "evals", "release.json"),
        content: `${JSON.stringify(releaseEvals, null, 2)}\n`,
      },
    ],
    directories: [...draft.directories, join(draft.skill_dir, "evals")],
  };
}

export function requireDraftableSynthesisCandidate(
  candidateId: string,
  snapshot: CandidateSnapshot,
): SynthesisCandidate {
  const candidate = snapshot.candidates.find((item) => item.candidateId === candidateId);
  if (!candidate) throw new CLIError(`Candidate ${candidateId} was not found.`, "FILE_NOT_FOUND");
  if (candidate.status !== "accepted") {
    throw new CLIError(
      "Only an explicitly accepted candidate can become a draft.",
      "GUARD_BLOCKED",
      `Run selftune library synthesize review --candidate-id ${candidateId} --action accept --reason <text>.`,
    );
  }
  return candidate;
}

export function materializeSynthesisDraft(
  candidate: SynthesisCandidate,
  snapshot: CandidateSnapshot,
  catalog: LibrarySnapshot | null,
  outputDir?: string,
  configRoot?: string,
) {
  const sourceSkillRevisions = candidate.skillNames.flatMap((skillName) => {
    const skill = catalog?.skills.find((item) => item.name === skillName);
    if (!skill) return [];
    return skill.revisions.map((revision) => ({
      skill_id: skill.skillId,
      skill_name: skillName,
      revision_hash: revision.contentHash,
    }));
  });
  const result = writeCreateSkillDraft(
    synthesizedDraft(
      candidate,
      snapshot,
      outputDir ?? join(resolve(configRoot ?? SELFTUNE_CONFIG_DIR), "library", "drafts"),
      sourceSkillRevisions,
    ),
  );
  return {
    candidate_id: candidate.candidateId,
    evidence_snapshot_id: snapshot.snapshotId,
    draft: result,
  };
}

export async function draftSynthesisCandidate(
  candidateId: string,
  outputDir?: string,
  options: SynthesisOptions = {},
) {
  const snapshot = loadCandidateSnapshot(options.configRoot);
  const candidate = requireDraftableSynthesisCandidate(candidateId, snapshot);
  const catalog =
    candidate.skillNames.length > 0
      ? await loadLibraryCatalog({ skillSetConfigRoot: options.configRoot })
      : null;
  const result = materializeSynthesisDraft(
    candidate,
    snapshot,
    catalog,
    outputDir,
    options.configRoot,
  );
  await withRuntime(options, async (runtime) => {
    await runtime.mergeCandidates(snapshot);
    await runtime.markCandidateDrafted(candidateId);
    saveCandidateSnapshot(await runtime.candidateSnapshot(), options.configRoot);
  });
  invalidateSynthesisReleaseAuthority(candidateId, options.configRoot);
  return result;
}

function candidateDraftPath(candidate: SynthesisCandidate, configRoot?: string): string {
  return buildCreateSkillDraft({
    name: candidate.title,
    description: candidate.summary,
    outputDir: join(resolve(configRoot ?? SELFTUNE_CONFIG_DIR), "library", "drafts"),
  }).skill_dir;
}

export async function evaluateSynthesisCandidate(
  candidateId: string,
  options: SynthesisOptions = {},
): Promise<SynthesisReleaseGate> {
  const snapshot = loadCandidateSnapshot(options.configRoot);
  const candidate = snapshot.candidates.find((item) => item.candidateId === candidateId);
  if (!candidate) throw new CLIError(`Candidate ${candidateId} was not found.`, "FILE_NOT_FOUND");
  if (candidate.status !== "drafted") {
    throw new CLIError(
      "Only a reviewed draft can enter release evaluation.",
      "GUARD_BLOCKED",
      `Accept and draft ${candidateId} before evaluating it.`,
    );
  }

  const draftPath = candidateDraftPath(candidate, options.configRoot);
  const skillPath = join(draftPath, "SKILL.md");
  const revisionHash = computeSkillVersionHash(skillPath);
  if (!revisionHash)
    throw new CLIError(`Draft package was not found: ${draftPath}`, "FILE_NOT_FOUND");
  const generatedEvals = generatePackageEvals(snapshot.snapshotId, candidate, basename(draftPath));
  const heldOutEvalIds = generatedEvals.filter((item) => item.heldOut).map((item) => item.evalId);
  if (heldOutEvalIds.length === 0) {
    throw new CLIError(
      "Release evaluation requires held-out session evidence.",
      "GUARD_BLOCKED",
      "Collect more independent successful sessions and rescan synthesis candidates.",
    );
  }
  const evalSetPath = join(draftPath, "evals", "release.json");
  if (!existsSync(evalSetPath)) {
    throw new CLIError(`Held-out eval set was not found: ${evalSetPath}`, "FILE_NOT_FOUND");
  }
  validateReleaseEvalSet(evalSetPath, generatedEvals);

  const result = await (options.runCreatePublish ?? runCreatePublish)({
    skillPath,
    watch: false,
    evalSetPath,
  });
  const expectedSkillName = basename(draftPath);
  const evaluatedPackageMatchesDraft =
    result.skill === expectedSkillName && resolve(result.skill_path) === resolve(skillPath);
  const evaluationPassed = hasPassingPackageEvaluation(result.package_evaluation, {
    skillName: expectedSkillName,
    skillPath,
  });
  const evaluationCommandsPassed = result.replay_exit_code === 0 && result.baseline_exit_code === 0;
  const blockers = [
    ...(result.published
      ? []
      : [result.package_evaluation?.status ?? result.next_command ?? "Package evaluation failed."]),
    ...(evaluatedPackageMatchesDraft && evaluationPassed && evaluationCommandsPassed
      ? []
      : ["A passing persisted package replay and no-skill baseline evaluation is required."]),
  ];
  const gate: SynthesisReleaseGate = {
    schema_version: 1,
    candidate_id: candidateId,
    evidence_snapshot_id: snapshot.snapshotId,
    candidate_revision_hash: candidateRevisionHash(candidate),
    skill_name: result.skill,
    draft_path: draftPath,
    revision_hash: revisionHash,
    evaluated_at: (options.now ?? new Date()).toISOString(),
    replay_exit_code: result.replay_exit_code ?? 1,
    baseline_exit_code: result.baseline_exit_code ?? 1,
    held_out_eval_ids: heldOutEvalIds,
    recommended:
      result.published &&
      evaluatedPackageMatchesDraft &&
      evaluationPassed &&
      evaluationCommandsPassed,
    blockers,
    evaluation: result.package_evaluation,
  };
  atomicWriteJson(gatePath(candidateId, options.configRoot), gate);
  return gate;
}

export function materializeSynthesisRelease(
  candidateId: string,
  options: Pick<SynthesisOptions, "configRoot" | "now"> = {},
): SynthesisRelease {
  const snapshot = loadCandidateSnapshot(options.configRoot);
  const candidate = snapshot.candidates.find((item) => item.candidateId === candidateId);
  if (!candidate) throw new CLIError(`Candidate ${candidateId} was not found.`, "FILE_NOT_FOUND");
  if (candidate.status !== "drafted") {
    throw new CLIError(
      "The candidate changed after release evaluation.",
      "GUARD_BLOCKED",
      "Review the candidate, create a fresh draft, and evaluate that revision.",
    );
  }
  const path = gatePath(candidateId, options.configRoot);
  if (!existsSync(path)) {
    throw new CLIError(
      "Release evaluation has not been run.",
      "GUARD_BLOCKED",
      `Run selftune library synthesize evaluate --candidate-id ${candidateId}.`,
    );
  }
  const gate = JSON.parse(readFileSync(path, "utf8")) as SynthesisReleaseGate;
  if (
    !gate.recommended ||
    gate.replay_exit_code !== 0 ||
    gate.baseline_exit_code !== 0 ||
    !Array.isArray(gate.held_out_eval_ids) ||
    gate.held_out_eval_ids.length === 0 ||
    !hasPassingPackageEvaluation(gate.evaluation, {
      skillName: gate.skill_name,
      skillPath: join(gate.draft_path, "SKILL.md"),
    })
  ) {
    throw new CLIError(
      "Release is blocked by the held-out package evaluation.",
      "GUARD_BLOCKED",
      gate.blockers[0] ?? "Resolve the evaluation blockers and run it again.",
    );
  }
  if (candidateRevisionHash(candidate) !== gate.candidate_revision_hash) {
    throw new CLIError(
      "The candidate changed after release evaluation.",
      "GUARD_BLOCKED",
      "Create and evaluate a fresh draft for the current reviewed candidate.",
    );
  }
  const currentHash = computeSkillVersionHash(join(gate.draft_path, "SKILL.md"));
  if (currentHash !== gate.revision_hash) {
    throw new CLIError(
      "The draft changed after evaluation.",
      "GUARD_BLOCKED",
      "Run release evaluation again for the current draft revision.",
    );
  }

  const packagePath = join(
    resolve(options.configRoot ?? SELFTUNE_CONFIG_DIR),
    "library",
    "packages",
    gate.revision_hash,
    gate.skill_name,
  );
  if (!existsSync(packagePath)) {
    mkdirSync(dirname(packagePath), { recursive: true });
    cpSync(gate.draft_path, packagePath, { recursive: true, errorOnExist: true, force: false });
  }
  if (computeSkillVersionHash(join(packagePath, "SKILL.md")) !== gate.revision_hash) {
    throw new CLIError("Released package failed content verification.", "GUARD_BLOCKED");
  }

  const release: SynthesisRelease = {
    schema_version: 1,
    candidate_id: candidateId,
    evidence_snapshot_id: gate.evidence_snapshot_id,
    candidate_revision_hash: gate.candidate_revision_hash,
    skill_name: gate.skill_name,
    revision_hash: gate.revision_hash,
    package_path: packagePath,
    gate_path: path,
    released_at: (options.now ?? new Date()).toISOString(),
  };
  atomicWriteJson(releasePath(candidateId, options.configRoot), release);
  return release;
}

export async function releaseSynthesisCandidate(
  candidateId: string,
  options: SynthesisOptions = {},
): Promise<SynthesisRelease> {
  const release = materializeSynthesisRelease(candidateId, options);
  await withRuntime(options, async (runtime) => {
    await runtime.mergeCandidates(loadCandidateSnapshot(options.configRoot));
    await runtime.markCandidateReleased(candidateId);
    saveCandidateSnapshot(await runtime.candidateSnapshot(), options.configRoot);
  });
  return release;
}

export function listSynthesisReleases(configRoot?: string): SynthesisRelease[] {
  const directory = join(resolve(configRoot ?? SELFTUNE_CONFIG_DIR), "library", "releases");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => JSON.parse(readFileSync(join(directory, entry), "utf8")) as SynthesisRelease)
    .filter((release) => {
      if (
        release.schema_version !== 1 ||
        !existsSync(release.package_path) ||
        !statSync(release.package_path).isDirectory() ||
        computeSkillVersionHash(join(release.package_path, "SKILL.md")) !== release.revision_hash ||
        !existsSync(release.gate_path)
      ) {
        return false;
      }
      try {
        const gate = JSON.parse(readFileSync(release.gate_path, "utf8")) as SynthesisReleaseGate;
        return (
          gate.recommended &&
          gate.replay_exit_code === 0 &&
          gate.baseline_exit_code === 0 &&
          Array.isArray(gate.held_out_eval_ids) &&
          gate.held_out_eval_ids.length > 0 &&
          hasPassingPackageEvaluation(gate.evaluation, {
            skillName: gate.skill_name,
            skillPath: join(gate.draft_path, "SKILL.md"),
          }) &&
          gate.revision_hash === release.revision_hash &&
          gate.candidate_revision_hash === release.candidate_revision_hash
        );
      } catch {
        return false;
      }
    });
}
