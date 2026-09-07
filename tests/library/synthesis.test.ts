import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { GeneratedEvalCase, type SynthesisDecision } from "@selftune/control-plane";
import * as Schema from "effect/Schema";

import { openDb } from "../../packages/runtime/localdb/db.js";
import type { CreatePackageEvaluationSummary } from "../../packages/runtime/types.js";
import {
  collectSynthesisEvidence,
  draftSynthesisCandidate,
  evaluateSynthesisCandidate,
  loadCandidateSnapshot,
  listSynthesisReleases,
  materializeSynthesisRelease,
  releaseSynthesisCandidate,
  reviewSynthesisCandidate,
  scanSynthesisCandidates,
} from "../../packages/runtime/synthesis.js";
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixtureDb(): Database {
  const db = openDb(":memory:");
  for (let index = 1; index <= 3; index += 1) {
    db.run(
      `INSERT INTO session_telemetry (
        session_id, timestamp, cwd, skills_triggered_json, skills_invoked_json,
        assistant_turns, errors_encountered, last_user_query
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `session-${index}`,
        `2026-07-${String(index).padStart(2, "0")}T00:00:00.000Z`,
        `/Users/private/Acme-${index}`,
        "[]",
        "[]",
        2,
        0,
        "Prepare release notes for daniel@example.com using sk-abcdefghijklmnopqrstuv",
      ],
    );
  }
  return db;
}

function passingPackageEvaluation(
  skillName: string,
  skillPath: string,
): CreatePackageEvaluationSummary {
  return {
    skill_name: skillName,
    skill_path: skillPath,
    mode: "package",
    status: "passed",
    evaluation_passed: true,
    next_command: null,
    replay: {
      mode: "package",
      validation_mode: "host_replay",
      agent: "claude",
      proposal_id: "synthesis-release",
      fixture_id: "held-out-fixture",
      total: 2,
      passed: 2,
      failed: 0,
      pass_rate: 1,
    },
    baseline: {
      mode: "package",
      baseline_pass_rate: 0.5,
      with_skill_pass_rate: 1,
      lift: 0.5,
      adds_value: true,
      measured_at: "2026-07-15T00:00:00.000Z",
    },
  };
}

test("saved skill lists preserve valid names and canonical subagent provenance stays excluded", () => {
  const db = fixtureDb();
  try {
    db.run("UPDATE session_telemetry SET skills_invoked_json = ? WHERE session_id = ?", [
      JSON.stringify([null, "draft", 7, "review"]),
      "session-1",
    ]);
    db.run(
      "UPDATE session_telemetry SET skills_invoked_json = ?, skills_triggered_json = ? WHERE session_id = ?",
      ["null", JSON.stringify(["fallback"]), "session-2"],
    );
    for (const [id, source] of [
      ["session-1", JSON.stringify({ path: 7 })],
      ["session-2", "{invalid"],
      ["session-3", JSON.stringify({ path: "/project/subagents/worker.jsonl" })],
    ]) {
      db.run("INSERT INTO sessions (session_id, started_at, raw_source_ref) VALUES (?, ?, ?)", [
        id!,
        "2026-09-06T00:00:00.000Z",
        source!,
      ]);
    }
    const evidence = collectSynthesisEvidence(db);
    expect(evidence.map((session) => session.sessionId)).toEqual(["session-1", "session-2"]);
    expect(evidence[0]?.orderedSkills).toEqual(["draft", "review"]);
    expect(evidence[1]?.orderedSkills).toEqual(["fallback"]);
  } finally {
    db.close();
  }
});

test("canonical grading overrides the ungraded completion proxy", () => {
  const db = fixtureDb();
  try {
    db.run(
      `INSERT INTO grading_results (
        grading_id, session_id, skill_name, graded_at, pass_rate, mean_score
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      ["grade-1", "session-1", "release-notes", "2026-07-15T00:00:00.000Z", 0.2, 0.25],
    );
    const graded = collectSynthesisEvidence(db).find(
      (session) => session.sessionId === "session-1",
    );
    expect(graded?.successful).toBe(false);
    expect(graded?.outcomeScore).toBe(0.25);
  } finally {
    db.close();
  }
});

describe("local synthesis lifecycle", () => {
  test("uses the original actionable session intent instead of a continuation message", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-synthesis-intent-"));
    roots.push(configRoot);
    const db = fixtureDb();
    try {
      for (let index = 1; index <= 3; index += 1) {
        db.run(`UPDATE session_telemetry SET last_user_query = '' WHERE session_id = ?`, [
          `session-${index}`,
        ]);
        db.run(`INSERT INTO queries (timestamp, session_id, query, source) VALUES (?, ?, ?, ?)`, [
          `2026-07-${String(index).padStart(2, "0")}T00:00:00.000Z`,
          `session-${index}`,
          "Prepare a release readiness report",
          "test",
        ]);
        db.run(`UPDATE session_telemetry SET last_user_query = ? WHERE session_id = ?`, [
          "proceed",
          `session-${index}`,
        ]);
      }

      const snapshot = await scanSynthesisCandidates({ configRoot, db });
      expect(snapshot.candidates).toHaveLength(1);
      expect(snapshot.candidates[0]?.title).toBe("prepare a release readiness report");
    } finally {
      db.close();
    }
  });

  test("prefers canonical task prompts and excludes later orchestration scaffolding", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-synthesis-canonical-"));
    roots.push(configRoot);
    const db = fixtureDb();
    try {
      for (let index = 1; index <= 3; index += 1) {
        db.run(`INSERT INTO sessions (session_id, started_at) VALUES (?, ?)`, [
          `session-${index}`,
          `2026-07-0${index}T00:00:00.000Z`,
        ]);
        db.run(
          `INSERT INTO prompts (
            prompt_id, session_id, occurred_at, prompt_kind, is_actionable, prompt_index, prompt_text
          ) VALUES (?, ?, ?, 'user', 1, ?, ?)`,
          [
            `prompt-${index}-task`,
            `session-${index}`,
            `2026-07-0${index}T00:00:00.000Z`,
            0,
            "Prepare a signed desktop release",
          ],
        );
        db.run(
          `INSERT INTO prompts (
            prompt_id, session_id, occurred_at, prompt_kind, is_actionable, prompt_index, prompt_text
          ) VALUES (?, ?, ?, 'user', 1, ?, ?)`,
          [
            `prompt-${index}-meta`,
            `session-${index}`,
            `2026-07-0${index}T00:01:00.000Z`,
            1,
            "You are an evaluation assistant. Grade this trace.",
          ],
        );
      }

      const snapshot = await scanSynthesisCandidates({ configRoot, db });
      expect(snapshot.candidates).toHaveLength(1);
      expect(snapshot.candidates[0]?.title).toBe("prepare a signed desktop release");
    } finally {
      db.close();
    }
  });

  test("redacts evidence, retains decisions, and creates a draft with held-out eval provenance", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-synthesis-config-"));
    const draftsRoot = mkdtempSync(join(tmpdir(), "selftune-synthesis-drafts-"));
    roots.push(configRoot, draftsRoot);
    const db = fixtureDb();
    try {
      const snapshot = await scanSynthesisCandidates({ configRoot, db });
      expect(snapshot.candidates).toHaveLength(1);
      const candidate = snapshot.candidates[0]!;
      expect(candidate.redactedExcerpts.join(" ")).not.toContain("daniel@example.com");
      expect(candidate.redactedExcerpts.join(" ")).not.toContain("sk-live");
      expect(candidate.redactedExcerpts.join(" ")).toContain("[EMAIL]");
      expect(candidate.heldOutSessionIds.length).toBeGreaterThan(0);

      await reviewSynthesisCandidate(
        {
          candidateId: candidate.candidateId,
          action: "accept",
          reason: "The pattern is reusable across these projects.",
        },
        { configRoot, now: new Date("2026-07-15T00:00:00.000Z") },
      );
      const result = await draftSynthesisCandidate(candidate.candidateId, draftsRoot, {
        configRoot,
      });
      const skillDir = result.draft.skill_dir;
      expect(existsSync(join(skillDir, "selftune.synthesis.json"))).toBe(true);
      expect(existsSync(join(skillDir, "evals", "generated.json"))).toBe(true);
      expect(existsSync(join(skillDir, "evals", "release.json"))).toBe(true);
      const evals = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Array(GeneratedEvalCase)),
      )(readFileSync(join(skillDir, "evals", "generated.json"), "utf8"));
      expect(
        evals
          .filter((item) => item.expectedSkillNames.length > 0)
          .every((item) => item.expectedSkillNames[0] === result.draft.skill_name),
      ).toBe(true);
      const releaseEvals = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Array(
            Schema.Struct({
              source: Schema.String,
              selftune_provenance: Schema.Struct({
                held_out: Schema.Boolean,
                source_session_ids: Schema.Array(Schema.String),
              }),
            }),
          ),
        ),
      )(readFileSync(join(skillDir, "evals", "release.json"), "utf8"));
      expect(releaseEvals.some((item) => item.selftune_provenance.held_out)).toBe(true);
      expect(
        releaseEvals
          .flatMap((item) => item.selftune_provenance.source_session_ids)
          .every((sessionId) => /^[a-f0-9]{64}$/i.test(sessionId)),
      ).toBe(true);
      expect(JSON.stringify(releaseEvals)).not.toContain("session-");
      expect(
        releaseEvals.every(
          (item) => item.selftune_provenance.held_out || item.source === "synthetic",
        ),
      ).toBe(true);
      const provenance = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            held_out_session_ids: Schema.Array(Schema.String),
            release_state: Schema.String,
          }),
        ),
      )(readFileSync(join(skillDir, "selftune.synthesis.json"), "utf8"));
      expect(provenance.held_out_session_ids.length).toBeGreaterThan(0);
      expect(provenance.release_state).toBe("validation_required");
      expect(loadCandidateSnapshot(configRoot).candidates[0]?.status).toBe("drafted");
    } finally {
      db.close();
    }
  });

  test("does not draft before explicit acceptance", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-synthesis-guard-"));
    const draftsRoot = mkdtempSync(join(tmpdir(), "selftune-synthesis-drafts-"));
    roots.push(configRoot, draftsRoot);
    const db = fixtureDb();
    try {
      const snapshot = await scanSynthesisCandidates({ configRoot, db });
      await expect(
        draftSynthesisCandidate(snapshot.candidates[0]!.candidateId, draftsRoot, { configRoot }),
      ).rejects.toMatchObject({ code: "GUARD_BLOCKED" });
    } finally {
      db.close();
    }
  });

  test("requires a passing immutable evaluation before release", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-synthesis-release-"));
    roots.push(configRoot);
    const db = fixtureDb();
    try {
      const snapshot = await scanSynthesisCandidates({ configRoot, db });
      const candidate = snapshot.candidates[0]!;
      await reviewSynthesisCandidate(
        { candidateId: candidate.candidateId, action: "accept", reason: "Reusable work." },
        { configRoot },
      );
      const drafted = await draftSynthesisCandidate(candidate.candidateId, undefined, {
        configRoot,
      });
      const publishResult = (published: boolean, includeEvaluation = published) => ({
        skill: drafted.draft.skill_name,
        skill_path: drafted.draft.skill_path,
        published,
        watch_started: false,
        watch_gate_blocked: false,
        next_command: published ? null : "fix the held-out regression",
        package_evaluation: includeEvaluation
          ? passingPackageEvaluation(drafted.draft.skill_name, drafted.draft.skill_path)
          : null,
        replay_exit_code: published ? 0 : 1,
        baseline_exit_code: published ? 0 : 1,
        watch_exit_code: null,
        watch_result: null,
        watch_stdout: "",
        watch_stderr: "",
        watch_gate_passed: null,
        watch_gate_warnings: [],
        watch_trust_score: null,
        watch_gate_bypassed: false,
      });

      const blocked = await evaluateSynthesisCandidate(candidate.candidateId, {
        configRoot,
        runCreatePublish: async () => publishResult(false),
      });
      expect(blocked.recommended).toBe(false);
      await expect(
        releaseSynthesisCandidate(candidate.candidateId, { configRoot }),
      ).rejects.toMatchObject({ code: "GUARD_BLOCKED" });

      const missingEvaluation = await evaluateSynthesisCandidate(candidate.candidateId, {
        configRoot,
        runCreatePublish: async () => publishResult(true, false),
      });
      expect(missingEvaluation.recommended).toBe(false);
      expect(missingEvaluation.blockers.join(" ")).toContain("persisted package replay");

      const passing = await evaluateSynthesisCandidate(candidate.candidateId, {
        configRoot,
        runCreatePublish: async (input) => {
          expect(input.evalSetPath).toBe(join(drafted.draft.skill_dir, "evals", "release.json"));
          return publishResult(true);
        },
      });
      expect(passing.recommended).toBe(true);
      const savedGate = join(
        configRoot,
        "library",
        "release-gates",
        `${candidate.candidateId}.json`,
      );
      const gateBytes = readFileSync(savedGate, "utf8");
      const invalidGates = [
        "{invalid",
        "null",
        JSON.stringify({ ...passing, schema_version: 2 }),
        JSON.stringify({ ...passing, recommended: "true" }),
        JSON.stringify({ ...passing, held_out_eval_ids: [null] }),
        JSON.stringify({ ...passing, blockers: null }),
        JSON.stringify({ ...passing, evaluation: {} }),
      ];
      for (const invalidGate of invalidGates) {
        writeFileSync(savedGate, invalidGate);
        expect(() => materializeSynthesisRelease(candidate.candidateId, { configRoot })).toThrow(
          "The saved release evaluation is invalid.",
        );
        expect(readFileSync(savedGate, "utf8")).toBe(invalidGate);
        expect(loadCandidateSnapshot(configRoot).candidates[0]?.status).toBe("drafted");
      }
      writeFileSync(savedGate, gateBytes);
      const release = await releaseSynthesisCandidate(candidate.candidateId, { configRoot });
      expect(existsSync(join(release.package_path, "SKILL.md"))).toBe(true);
      expect(loadCandidateSnapshot(configRoot).candidates[0]?.status).toBe("released");
      const releaseDirectory = join(configRoot, "library", "releases");
      writeFileSync(join(releaseDirectory, "malformed.json"), "{invalid");
      writeFileSync(
        join(releaseDirectory, "invalid-fields.json"),
        JSON.stringify({ ...release, package_path: null }),
      );
      expect(listSynthesisReleases(configRoot)).toEqual([release]);
      expect(readFileSync(join(releaseDirectory, "malformed.json"), "utf8")).toBe("{invalid");
      writeFileSync(savedGate, JSON.stringify({ ...passing, evaluation: {} }));
      expect(listSynthesisReleases(configRoot)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("ignores malformed remote decisions without losing a valid reviewed neighbor", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-synthesis-remote-decisions-"));
    roots.push(configRoot);
    const db = fixtureDb();
    try {
      const snapshot = await scanSynthesisCandidates({ configRoot, db });
      const candidate = snapshot.candidates[0]!;
      const history: SynthesisDecision[] = [
        {
          action: "reject",
          reason: "Not reusable",
          decidedAt: "2026-09-06T00:00:00.000Z",
          snoozedUntil: null,
        },
      ];
      const path = join(configRoot, "synthesis", "remote-decisions.json");
      mkdirSync(join(configRoot, "synthesis"), { recursive: true });
      const bytes = JSON.stringify({
        decisions: [
          null,
          { candidate_id: candidate.candidateId, status: "released", decision_history: [null] },
          { candidate_id: candidate.candidateId, status: "rejected", decision_history: history },
          { candidate_id: 42, decision_history: history },
        ],
      });
      writeFileSync(path, bytes);
      const refreshed = await scanSynthesisCandidates({ configRoot, db });
      expect(refreshed.candidates[0]?.status).toBe("rejected");
      expect(refreshed.candidates[0]?.decisionHistory).toEqual(history);
      expect(readFileSync(path, "utf8")).toBe(bytes);
    } finally {
      db.close();
    }
  });

  test("invalidates release authority when the reviewed candidate changes", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-synthesis-stale-gate-"));
    roots.push(configRoot);
    const db = fixtureDb();
    try {
      const snapshot = await scanSynthesisCandidates({ configRoot, db });
      const candidate = snapshot.candidates[0]!;
      await reviewSynthesisCandidate(
        { candidateId: candidate.candidateId, action: "accept", reason: "Reusable work." },
        { configRoot },
      );
      const drafted = await draftSynthesisCandidate(candidate.candidateId, undefined, {
        configRoot,
      });
      await evaluateSynthesisCandidate(candidate.candidateId, {
        configRoot,
        runCreatePublish: async () => ({
          skill: drafted.draft.skill_name,
          skill_path: drafted.draft.skill_path,
          published: true,
          watch_started: false,
          watch_gate_blocked: false,
          next_command: null,
          package_evaluation: passingPackageEvaluation(
            drafted.draft.skill_name,
            drafted.draft.skill_path,
          ),
          replay_exit_code: 0,
          baseline_exit_code: 0,
          watch_exit_code: null,
          watch_result: null,
          watch_stdout: "",
          watch_stderr: "",
          watch_gate_passed: null,
          watch_gate_warnings: [],
          watch_trust_score: null,
          watch_gate_bypassed: false,
        }),
      });

      await reviewSynthesisCandidate(
        {
          candidateId: candidate.candidateId,
          action: "edit",
          reason: "Narrow the reusable procedure before release.",
          title: "Narrow release-note procedure",
        },
        { configRoot },
      );

      await expect(
        releaseSynthesisCandidate(candidate.candidateId, { configRoot }),
      ).rejects.toMatchObject({ code: "GUARD_BLOCKED" });
    } finally {
      db.close();
    }
  });
});
