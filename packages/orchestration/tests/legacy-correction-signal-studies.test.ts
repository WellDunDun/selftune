import { afterEach, expect, test } from "bun:test";

import {
  getMeta,
  listCorrectionSignalCandidates,
  listCorrectionStudyDrafts,
  openDb,
} from "@selftune/local-store";
import * as Effect from "effect/Effect";

import { captureLegacyCorrectionSignalStudies } from "../src/orchestrate/correction-signal-studies.js";

const databases: Array<ReturnType<typeof openDb>> = [];

function seedSession(database: ReturnType<typeof openDb>, sessionId: string): void {
  database.query("INSERT INTO sessions (session_id) VALUES (?)").run(sessionId);
}

function seedInvocation(
  database: ReturnType<typeof openDb>,
  invocationId: string,
  sessionId: string,
  skillName: string,
): void {
  database
    .query(
      `INSERT INTO skill_invocations
        (skill_invocation_id, session_id, skill_name, triggered, skill_path)
       VALUES (?, ?, ?, 1, '/private/skills/SKILL.md')`,
    )
    .run(invocationId, sessionId, skillName);
}

function seedSignal(
  database: ReturnType<typeof openDb>,
  timestamp: string,
  sessionId: string,
  query: string,
  signalType: "correction" | "explicit_request",
  mentionedSkill: string | null,
): void {
  database
    .query(
      `INSERT INTO improvement_signals
        (timestamp, session_id, query, signal_type, mentioned_skill)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(timestamp, sessionId, query, signalType, mentionedSkill);
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

test("ingests only legacy correction phrasing as deferred, redacted E0 hypotheses", async () => {
  const database = openDb(":memory:");
  databases.push(database);
  seedSession(database, "session-single");
  seedSession(database, "session-ambiguous");
  seedInvocation(database, "invocation-single", "session-single", "DeploySkill");
  seedInvocation(database, "invocation-ambiguous-a", "session-ambiguous", "DeploySkill");
  seedInvocation(database, "invocation-ambiguous-b", "session-ambiguous", "DeploySkill");
  seedSignal(
    database,
    "2026-07-29T12:03:00.000Z",
    "session-single",
    "why didn't you use DeploySkill? token=raw-secret at /private/raw/transcript.json",
    "correction",
    "DeploySkill",
  );
  seedSignal(
    database,
    "2026-07-29T12:02:00.000Z",
    "session-single",
    "you should have used DeploySkill instead",
    "correction",
    "DeploySkill",
  );
  seedSignal(
    database,
    "2026-07-29T12:01:00.000Z",
    "session-single",
    "use DeploySkill",
    "explicit_request",
    "DeploySkill",
  );
  seedSignal(
    database,
    "2026-07-29T12:00:00.000Z",
    "session-ambiguous",
    "you should have used DeploySkill",
    "correction",
    "DeploySkill",
  );

  const first = await captureLegacyCorrectionSignalStudies({
    database,
    now: () => "2026-07-29T13:00:00.000Z",
  });
  const candidates = Effect.runSync(listCorrectionSignalCandidates(database, { limit: 10 }));
  const drafts = Effect.runSync(listCorrectionStudyDrafts(database, { limit: 10 }));

  expect(first).toEqual({ detected: 3, persisted: 3, drafted: 0, deferred: 3, errors: 0 });
  expect(candidates).toHaveLength(3);
  expect(drafts).toHaveLength(0);
  expect(candidates.every((candidate) => candidate.evidence_level === "E0")).toBe(true);
  expect(candidates.every((candidate) => candidate.lifecycle === "deferred")).toBe(true);
  for (const candidate of candidates) {
    expect(JSON.parse(candidate.signal_payload_json)).toMatchObject({
      skill: { pre_revision: null, post_revision: null },
    });
  }
  expect(
    candidates.some(
      (candidate) => candidate.reason === "legacy_correction_ambiguous_skill_attribution",
    ),
  ).toBe(true);
  expect(
    candidates.some((candidate) => candidate.signal_payload_json.includes("explicit_request")),
  ).toBe(false);
  const redacted = candidates.find((candidate) =>
    candidate.signal_payload_json.includes("why didn't"),
  );
  expect(redacted?.signal_payload_json).not.toContain("raw-secret");
  expect(redacted?.signal_payload_json).not.toContain("/private/raw/transcript.json");
  expect(redacted?.signal_payload_json).not.toContain("/private/skills/SKILL.md");
  expect(
    getMeta(database, "orchestrate.correction-signal-history.legacy-improvement-signals-v1"),
  ).toBe(JSON.stringify({ version: 1, state: "complete", cursor: null }));

  const second = await captureLegacyCorrectionSignalStudies({
    database,
    now: () => "2026-07-29T13:01:00.000Z",
  });
  const afterRepeat = Effect.runSync(listCorrectionSignalCandidates(database, { limit: 10 }));
  expect(second).toEqual({ detected: 3, persisted: 3, drafted: 0, deferred: 3, errors: 0 });
  expect(afterRepeat).toHaveLength(3);
  expect(
    afterRepeat.every((candidate) => candidate.created_at === "2026-07-29T13:00:00.000Z"),
  ).toBe(true);
});
