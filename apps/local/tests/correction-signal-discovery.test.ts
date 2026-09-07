import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "@selftune/local-store";

import {
  discoverExplicitCorrectionSignalPage,
  discoverExplicitCorrectionSignals,
} from "@selftune/runtime/correction-study/signal-discovery";

const databases: ReturnType<typeof openDb>[] = [];
const temporaryRoots: string[] = [];
const before = "a".repeat(64);
const after = "b".repeat(64);

function database() {
  const sqlite = openDb(":memory:");
  databases.push(sqlite);
  return sqlite;
}

function insertCanonicalRows(
  sqlite: ReturnType<typeof openDb>,
  overrides: Partial<{ rawSourceRef: string; invocationRevision: string | null }> = {},
) {
  const rawSourceRef = overrides.rawSourceRef ?? JSON.stringify({ path: "/local/session.jsonl" });
  sqlite.run(`INSERT INTO sessions (session_id, platform, raw_source_ref) VALUES (?, ?, ?)`, [
    "session-1",
    "codex",
    rawSourceRef,
  ]);
  sqlite.run(
    `INSERT INTO prompts (prompt_id, session_id, occurred_at, prompt_text, raw_source_ref)
     VALUES (?, ?, ?, ?, ?)`,
    [
      "prompt-1",
      "session-1",
      "2026-07-29T10:05:00.000Z",
      "That is wrong; instead verify the portal status before saying an upload succeeded. token=hidden",
      rawSourceRef,
    ],
  );
  sqlite.run(
    `INSERT INTO skill_invocations
      (skill_invocation_id, session_id, occurred_at, skill_name, skill_path, skill_version_hash, triggered, raw_source_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "invocation-1",
      "session-1",
      "2026-07-29T10:00:00.000Z",
      "release-checklist",
      "/local/release-checklist/SKILL.md",
      overrides.invocationRevision === undefined ? before : overrides.invocationRevision,
      1,
      rawSourceRef,
    ],
  );
}

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("explicit correction signal discovery", () => {
  test("skips malformed captures without changing the retained artifact digest", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite, { invocationRevision: null });
    const artifact = {
      event_type: "skill_md_edit_capture",
      status: "captured",
      session_id: "session-1",
      target_digest: createHash("sha256").update("/local/release-checklist/SKILL.md").digest("hex"),
      pre_revision: before,
      post_revision: after,
      pre_captured_at: "2026-07-29T10:05:15.000Z",
      post_captured_at: "2026-07-29T10:05:30.000Z",
      source_extension: { harness_version: "future-compatible" },
    };
    const serialized = JSON.stringify(artifact);
    const signals = discoverExplicitCorrectionSignals(sqlite, {
      inspectSkill: () => ({ revision: null, modified_at: null }),
      readRawSource: () => null,
      readSkillEditCaptures: () =>
        [
          "null",
          "{broken",
          JSON.stringify({ ...artifact, pre_revision: 42 }),
          JSON.stringify({ ...artifact, post_captured_at: {} }),
          serialized,
        ].join("\n"),
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      reason: "captured_package_revisions",
      raw_edit_digest: createHash("sha256").update(serialized).digest("hex"),
      proves_causality: false,
      review_status: "review_required",
    });
  });

  test.each(
    [
      null,
      [],
      { prompt_at: "not-a-date", prompt_id: "prompt-1" },
      { prompt_at: "2026-09-05", prompt_id: 1 },
    ].map((value) => ({ value })),
  )("rejects malformed decoded cursor fields: %j", ({ value }) => {
    const cursor = Buffer.from(JSON.stringify(value)).toString("base64url");
    expect(() => discoverExplicitCorrectionSignalPage(database(), { cursor })).toThrow(
      "cursor is invalid",
    );
  });

  test("discovers a bounded, redacted hash-backed hypothesis without writing a study", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite);

    const signals = discoverExplicitCorrectionSignals(sqlite, {
      inspectSkill: () => ({ revision: after, modified_at: "2026-07-29T10:06:00.000Z" }),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "explicit_correction_hypothesis",
      review_status: "review_required",
      dry_run: true,
      evidence_level: "E0.5",
      reason: "invocation_hash_delta",
      skill: {
        path: "[local-path-redacted]",
        pre_revision: before,
        post_revision: after,
      },
      proves_causality: false,
    });
    expect(signals[0]?.correction_intent).toContain("[redacted]");
    expect(signals[0]?.correction_intent).not.toContain("hidden");
    expect(sqlite.query("SELECT COUNT(*) AS count FROM correction_episodes").get()).toEqual({
      count: 0,
    });
    expect(
      discoverExplicitCorrectionSignals(sqlite, {
        inspectSkill: () => ({ revision: after, modified_at: "2026-07-29T10:06:00.000Z" }),
      }),
    ).toEqual(signals);
  });

  test("reconstructs raw-reference-backed exact edit evidence when old hashes are absent", () => {
    const sqlite = database();
    const rawSourceRef = JSON.stringify({
      path: "/local/session.jsonl",
      event_type: "codex_rollout",
    });
    insertCanonicalRows(sqlite, { rawSourceRef, invocationRevision: null });

    const signals = discoverExplicitCorrectionSignals(sqlite, {
      inspectSkill: () => ({ revision: null, modified_at: null }),
      readRawSource: (reference) =>
        reference === rawSourceRef
          ? JSON.stringify({
              edits: [
                {
                  skill_path: "/local/release-checklist/SKILL.md",
                  before: "# checklist\nDo the thing",
                  after: "# checklist\nVerify portal status",
                },
              ],
            })
          : null,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      evidence_level: "E0.5",
      reason: "raw_exact_contents",
      skill: {
        pre_revision: null,
        post_revision: null,
      },
      raw_content_digests: {
        before: createHash("sha256").update("# checklist\nDo the thing").digest("hex"),
        after: createHash("sha256").update("# checklist\nVerify portal status").digest("hex"),
      },
      proves_causality: false,
    });
    expect(signals[0]?.source.raw_source_ref_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(signals[0]?.raw_edit_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("retains a review-only missing-revision hypothesis instead of silently skipping it", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite, { invocationRevision: null });

    const signals = discoverExplicitCorrectionSignals(sqlite, {
      inspectSkill: () => ({ revision: null, modified_at: "2026-07-29T10:06:00.000Z" }),
      readRawSource: () => null,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      evidence_level: "E0",
      reason: "missing_revision_evidence",
      review_status: "review_required",
      proves_causality: false,
    });
  });

  test("uses a matching hash-only hook artifact as exact package revision evidence", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite, { invocationRevision: null });
    const targetDigest = createHash("sha256")
      .update("/local/release-checklist/SKILL.md")
      .digest("hex");

    const signals = discoverExplicitCorrectionSignals(sqlite, {
      inspectSkill: () => ({ revision: null, modified_at: null }),
      readSkillEditCaptures: () =>
        JSON.stringify({
          event_type: "skill_md_edit_capture",
          status: "captured",
          session_id: "session-1",
          target_digest: targetDigest,
          pre_revision: before,
          post_revision: after,
          pre_captured_at: "2026-07-29T10:05:30.000Z",
          post_captured_at: "2026-07-29T10:06:00.000Z",
        }),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      evidence_level: "E0.5",
      reason: "captured_package_revisions",
      skill: { pre_revision: before, post_revision: after },
    });
  });

  test("reads a bounded recent JSONL tail after dropping a truncated first record", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite, { invocationRevision: null });
    const root = mkdtempSync(join(tmpdir(), "selftune-correction-capture-tail-"));
    temporaryRoots.push(root);
    const previousConfigDir = process.env.SELFTUNE_CONFIG_DIR;
    process.env.SELFTUNE_CONFIG_DIR = root;
    try {
      const targetDigest = createHash("sha256")
        .update("/local/release-checklist/SKILL.md")
        .digest("hex");
      const valid = JSON.stringify({
        event_type: "skill_md_edit_capture",
        status: "captured",
        session_id: "session-1",
        target_digest: targetDigest,
        pre_revision: before,
        post_revision: after,
        pre_captured_at: "2026-07-29T10:05:15.000Z",
        post_captured_at: "2026-07-29T10:05:30.000Z",
      });
      // This makes the bounded tail begin in an invalid record. The reader must
      // discard it at the next newline and still retain the recent valid record.
      writeFileSync(
        join(root, "skill-edit-captures.jsonl"),
        `${"x".repeat(256 * 1024)}\n${valid}\n`,
      );

      const signals = discoverExplicitCorrectionSignals(sqlite, {
        inspectSkill: () => ({ revision: null, modified_at: null }),
      });
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        reason: "captured_package_revisions",
        skill: { pre_revision: before, post_revision: after },
      });
    } finally {
      if (previousConfigDir === undefined) delete process.env.SELFTUNE_CONFIG_DIR;
      else process.env.SELFTUNE_CONFIG_DIR = previousConfigDir;
    }
  });

  test("rejects hook artifacts with a mismatched target or out-of-window timestamp", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite, { invocationRevision: null });
    const signals = discoverExplicitCorrectionSignals(sqlite, {
      inspectSkill: () => ({ revision: null, modified_at: null }),
      readSkillEditCaptures: () =>
        [
          {
            event_type: "skill_md_edit_capture",
            status: "captured",
            session_id: "session-1",
            target_digest: createHash("sha256").update("/local/other/SKILL.md").digest("hex"),
            pre_revision: before,
            post_revision: after,
            pre_captured_at: "2026-07-29T10:05:30.000Z",
            post_captured_at: "2026-07-29T10:06:00.000Z",
          },
          {
            event_type: "skill_md_edit_capture",
            status: "captured",
            session_id: "session-1",
            target_digest: createHash("sha256")
              .update("/local/release-checklist/SKILL.md")
              .digest("hex"),
            pre_revision: before,
            post_revision: after,
            pre_captured_at: "2026-07-31T10:05:30.000Z",
            post_captured_at: "2026-07-31T10:06:00.000Z",
          },
        ]
          .map((artifact) => JSON.stringify(artifact))
          .join("\n"),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      reason: "missing_revision_evidence",
      evidence_level: "E0",
    });
  });

  test("rejects pre-prompt or invalid-order artifacts and chooses the nearest valid capture", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite, { invocationRevision: null });
    const targetDigest = createHash("sha256")
      .update("/local/release-checklist/SKILL.md")
      .digest("hex");
    const alternate = "c".repeat(64);
    const signals = discoverExplicitCorrectionSignals(sqlite, {
      inspectSkill: () => ({ revision: null, modified_at: null }),
      readSkillEditCaptures: () =>
        [
          {
            event_type: "skill_md_edit_capture",
            status: "captured",
            session_id: "session-1",
            target_digest: targetDigest,
            pre_revision: before,
            post_revision: alternate,
            pre_captured_at: "2026-07-29T10:04:59.000Z",
            post_captured_at: "2026-07-29T10:05:10.000Z",
          },
          {
            event_type: "skill_md_edit_capture",
            status: "captured",
            session_id: "session-1",
            target_digest: targetDigest,
            pre_revision: before,
            post_revision: alternate,
            pre_captured_at: "2026-07-29T10:06:10.000Z",
            post_captured_at: "2026-07-29T10:06:00.000Z",
          },
          {
            event_type: "skill_md_edit_capture",
            status: "captured",
            session_id: "session-1",
            target_digest: targetDigest,
            pre_revision: before,
            post_revision: alternate,
            pre_captured_at: "2026-07-29T10:10:00.000Z",
            post_captured_at: "2026-07-29T10:11:00.000Z",
          },
          {
            event_type: "skill_md_edit_capture",
            status: "captured",
            session_id: "session-1",
            target_digest: targetDigest,
            pre_revision: before,
            post_revision: after,
            pre_captured_at: "2026-07-29T10:05:15.000Z",
            post_captured_at: "2026-07-29T10:05:30.000Z",
          },
        ]
          .map((artifact) => JSON.stringify(artifact))
          .join("\n"),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      reason: "captured_package_revisions",
      skill: { pre_revision: before, post_revision: after },
    });
  });

  test("reopens a bounded source-native file for an exact historical SKILL.md edit", () => {
    const sqlite = database();
    const root = mkdtempSync(join(tmpdir(), "selftune-correction-source-"));
    temporaryRoots.push(root);
    const skillPath = join(root, "SKILL.md");
    const sourcePath = join(root, "session.json");
    writeFileSync(
      sourcePath,
      JSON.stringify({
        edits: [{ skill_path: skillPath, before: "old instruction", after: "new instruction" }],
      }),
    );
    insertCanonicalRows(sqlite, {
      invocationRevision: null,
      rawSourceRef: JSON.stringify({ path: sourcePath }),
    });
    sqlite.run("UPDATE skill_invocations SET skill_path = ?", [skillPath]);

    const signals = discoverExplicitCorrectionSignals(sqlite, {
      inspectSkill: () => ({ revision: null, modified_at: null }),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      reason: "raw_exact_contents",
      evidence_level: "E0.5",
      raw_edit_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test("ignores non-correction prompts and does not read their raw source", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite);
    sqlite.run("UPDATE prompts SET prompt_text = ? WHERE prompt_id = ?", [
      "Implement a portal status check.",
      "prompt-1",
    ]);
    let rawReads = 0;

    const signals = discoverExplicitCorrectionSignals(sqlite, {
      inspectSkill: () => ({ revision: after, modified_at: "2026-07-29T10:06:00.000Z" }),
      readRawSource: () => {
        rawReads += 1;
        return null;
      },
    });

    expect(signals).toEqual([]);
    expect(rawReads).toBe(0);
  });

  test("excludes initial p0 task prompts with instruction language", () => {
    for (const promptId of ["project:p0", "project:p0:codex-rollout"]) {
      const sqlite = database();
      insertCanonicalRows(sqlite);
      sqlite.run("UPDATE prompts SET prompt_id = ?, prompt_text = ? WHERE prompt_id = ?", [
        promptId,
        "Read AGENTS.md. You must use the existing skill and do not change the architecture.",
        "prompt-1",
      ]);

      expect(
        discoverExplicitCorrectionSignals(sqlite, {
          inspectSkill: () => ({ revision: after, modified_at: "2026-07-29T10:06:00.000Z" }),
          readRawSource: () => {
            throw new Error("Initial task prompts must not reopen source content.");
          },
        }),
      ).toEqual([]);
    }
  });

  test("does not mistake later generic instruction language for correction feedback", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite);
    sqlite.run("UPDATE prompts SET prompt_id = ?, prompt_text = ? WHERE prompt_id = ?", [
      "project:p1:codex-rollout",
      "You should use the documented workflow, must preserve the contract, and do not edit generated files.",
      "prompt-1",
    ]);

    expect(
      discoverExplicitCorrectionSignals(sqlite, {
        inspectSkill: () => ({ revision: after, modified_at: "2026-07-29T10:06:00.000Z" }),
      }),
    ).toEqual([]);
  });

  test("discovers direct later correction feedback to edit the skill", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite, { invocationRevision: null });
    sqlite.run("UPDATE prompts SET prompt_id = ?, prompt_text = ? WHERE prompt_id = ?", [
      "project:p1:codex-rollout",
      "No, that's wrong—edit the skill directly instead.",
      "prompt-1",
    ]);

    const signals = discoverExplicitCorrectionSignals(sqlite, {
      inspectSkill: () => ({ revision: null, modified_at: null }),
      readRawSource: () => null,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      reason: "missing_revision_evidence",
      review_status: "review_required",
      source: { prompt_id: "project:p1:codex-rollout" },
    });
  });

  test("discovers direct forgotten-skill-update feedback", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite, { invocationRevision: null });
    sqlite.run("UPDATE prompts SET prompt_id = ?, prompt_text = ? WHERE prompt_id = ?", [
      "project:p1",
      "You forgot to update the skill.",
      "prompt-1",
    ]);

    const signals = discoverExplicitCorrectionSignals(sqlite, {
      inspectSkill: () => ({ revision: null, modified_at: null }),
      readRawSource: () => null,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      reason: "missing_revision_evidence",
      review_status: "review_required",
      source: { prompt_id: "project:p1" },
    });
  });

  test("defers one ambiguous prompt group instead of creating duplicate multi-skill signals", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite);
    for (const [id, skill] of [
      ["invocation-2", "implement"],
      ["invocation-3", "shadcn"],
      ["invocation-4", "agent-browser"],
    ]) {
      sqlite.run(
        `INSERT INTO skill_invocations
          (skill_invocation_id, session_id, occurred_at, skill_name, skill_path, triggered)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [id, "session-1", "2026-07-29T10:00:00.000Z", skill, `/local/${skill}/SKILL.md`],
      );
    }

    const signals = discoverExplicitCorrectionSignals(sqlite, {
      inspectSkill: () => ({ revision: null, modified_at: null }),
      readRawSource: () => {
        throw new Error("Ambiguous rows must not reopen source content.");
      },
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      reason: "ambiguous_multi_skill_correlation",
      evidence_level: "E0",
      review_status: "deferred",
      deferred_skill_names: ["agent-browser", "implement", "release-checklist", "shadcn"],
      proves_causality: false,
    });
    const page = discoverExplicitCorrectionSignalPage(
      sqlite,
      { limit: 1 },
      { inspectSkill: () => ({ revision: null, modified_at: null }) },
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      review_status: "deferred",
      reason: "ambiguous_multi_skill_correlation",
      deferred_skill_names: ["agent-browser", "implement", "release-checklist", "shadcn"],
    });
  });

  test("does not defer a correction because of an unrelated earlier session skill", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite, { invocationRevision: null });
    sqlite.run(
      `INSERT INTO skill_invocations
        (skill_invocation_id, session_id, occurred_at, skill_name, skill_path, triggered)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [
        "invocation-hours-earlier",
        "session-1",
        "2026-07-29T07:00:00.000Z",
        "unrelated-skill",
        "/local/unrelated-skill/SKILL.md",
      ],
    );

    const signals = discoverExplicitCorrectionSignals(sqlite, {
      inspectSkill: () => ({ revision: null, modified_at: null }),
      readRawSource: () => null,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      review_status: "review_required",
      reason: "missing_revision_evidence",
      deferred_skill_names: null,
      correlation_truncated: false,
    });
  });

  test("caps an oversized prompt group and defers its attribution", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite, { invocationRevision: null });
    for (let index = 2; index <= 33; index += 1) {
      sqlite.run(
        `INSERT INTO skill_invocations
          (skill_invocation_id, session_id, occurred_at, skill_name, skill_path, triggered)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [
          `invocation-${String(index).padStart(2, "0")}`,
          "session-1",
          "2026-07-29T10:00:00.000Z",
          "release-checklist",
          "/local/release-checklist/SKILL.md",
        ],
      );
    }

    const page = discoverExplicitCorrectionSignalPage(
      sqlite,
      { limit: 1 },
      { inspectSkill: () => ({ revision: null, modified_at: null }), readRawSource: () => null },
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      review_status: "deferred",
      reason: "ambiguous_multi_skill_correlation",
      correlation_truncated: true,
      proves_causality: false,
    });
  });

  test("uses a bounded cursor to continue historical discovery", () => {
    const sqlite = database();
    insertCanonicalRows(sqlite);
    sqlite.run(
      `INSERT INTO sessions (session_id, platform) VALUES (?, ?)
       ON CONFLICT(session_id) DO NOTHING`,
      ["session-2", "codex"],
    );
    sqlite.run(
      `INSERT INTO prompts (prompt_id, session_id, occurred_at, prompt_text)
       VALUES (?, ?, ?, ?)`,
      ["prompt-older", "session-2", "2026-07-28T10:05:00.000Z", "That is wrong; use the check."],
    );
    sqlite.run(
      `INSERT INTO skill_invocations
        (skill_invocation_id, session_id, occurred_at, skill_name, skill_path, triggered)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [
        "invocation-older",
        "session-2",
        "2026-07-28T10:00:00.000Z",
        "older",
        "/local/older/SKILL.md",
      ],
    );
    const options = {
      inspectSkill: () => ({ revision: null, modified_at: null }),
      readRawSource: () => null,
    };
    const first = discoverExplicitCorrectionSignalPage(sqlite, { limit: 1 }, options);
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = discoverExplicitCorrectionSignalPage(
      sqlite,
      { limit: 1, cursor: first.next_cursor },
      options,
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.source.session_id).toBe("session-2");
  });
});
