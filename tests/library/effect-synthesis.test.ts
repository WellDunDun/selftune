import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { CandidateStoreMemory, CatalogMemory } from "@selftune/control-plane";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { CreatePublishResult } from "../../packages/runtime/create/publish.js";
import {
  draftSynthesisCandidateEffect,
  evaluateSynthesisCandidateEffect,
  releaseSynthesisCandidateEffect,
  reviewSynthesisCandidateEffect,
  scanSynthesisCandidatesEffect,
} from "../../packages/runtime/library/effect-synthesis.js";
import { openDb } from "../../packages/runtime/localdb/db.js";
import { loadCandidateSnapshot } from "../../packages/runtime/synthesis.js";

function fixtureDb(): Database {
  const db = openDb(":memory:");
  for (let index = 1; index <= 3; index += 1) {
    db.run(
      `INSERT INTO session_telemetry (
        session_id, timestamp, cwd, skills_triggered_json, skills_invoked_json,
        assistant_turns, errors_encountered, last_user_query
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `effect-session-${index}`,
        `2026-07-${String(index).padStart(2, "0")}T00:00:00.000Z`,
        `/Users/private/Effect-${index}`,
        "[]",
        "[]",
        2,
        0,
        "Prepare a signed release package",
      ],
    );
  }
  return db;
}

function passingPublishResult(skillName: string, skillPath: string): CreatePublishResult {
  return {
    skill: skillName,
    skill_path: skillPath,
    published: true,
    watch_started: false,
    watch_gate_blocked: false,
    next_command: null,
    package_evaluation: {
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
        proposal_id: "effect-synthesis-release",
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
        measured_at: "2026-07-16T00:00:00.000Z",
      },
    },
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
  };
}

test("Effect synthesis owns candidate state through injected services", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "selftune-effect-synthesis-"));
  const db = fixtureDb();
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scanned = yield* scanSynthesisCandidatesEffect({ configRoot, db });
        const candidate = scanned.candidates[0];
        if (!candidate) return yield* Effect.die("Expected a synthesis candidate.");

        const reviewed = yield* reviewSynthesisCandidateEffect(
          {
            candidateId: candidate.candidateId,
            action: "accept",
            reason: "The evidence recurs across independent projects.",
          },
          { configRoot, now: new Date("2026-07-15T00:00:00.000Z") },
        );
        const reviewedStatus = loadCandidateSnapshot(configRoot).candidates[0]?.status;

        const drafted = yield* draftSynthesisCandidateEffect(candidate.candidateId, undefined, {
          configRoot,
        });
        const draftedStatus = loadCandidateSnapshot(configRoot).candidates[0]?.status;

        const gate = yield* evaluateSynthesisCandidateEffect(candidate.candidateId, {
          configRoot,
          now: new Date("2026-07-16T00:00:00.000Z"),
          runCreatePublish: () =>
            Promise.resolve(
              passingPublishResult(drafted.draft.skill_name, drafted.draft.skill_path),
            ),
        });
        const release = yield* releaseSynthesisCandidateEffect(candidate.candidateId, {
          configRoot,
          now: new Date("2026-07-17T00:00:00.000Z"),
        });

        return {
          candidateId: candidate.candidateId,
          reviewed,
          reviewedStatus,
          drafted,
          draftedStatus,
          gate,
          release,
          releasedStatus: loadCandidateSnapshot(configRoot).candidates[0]?.status,
        };
      }).pipe(Effect.provide(Layer.merge(CandidateStoreMemory, CatalogMemory))),
    );

    expect(result.reviewed.status).toBe("accepted");
    expect(result.reviewedStatus).toBe("accepted");
    expect(result.draftedStatus).toBe("drafted");
    expect(existsSync(result.drafted.draft.skill_path)).toBe(true);
    expect(result.gate.recommended).toBe(true);
    expect(result.release.candidate_id).toBe(result.candidateId);
    expect(existsSync(join(result.release.package_path, "SKILL.md"))).toBe(true);
    expect(result.releasedStatus).toBe("released");
  } finally {
    db.close();
    rmSync(configRoot, { recursive: true, force: true });
  }
});
