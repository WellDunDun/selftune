import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Schema from "effect/Schema";
import { openDb, _setTestDb } from "../../packages/runtime/localdb/db.js";
import { queryEvolutionAudit } from "../../packages/runtime/localdb/queries.js";
import { readAuditTrail } from "../../packages/runtime/evolution/audit.js";

afterEach(() => _setTestDb(null));

test("typed audit readers keep valid historical neighbors without accepting unknown actions", () => {
  const db = openDb(":memory:");
  _setTestDb(db);
  try {
    db.run(
      "INSERT INTO evolution_audit (timestamp, proposal_id, action, details, eval_snapshot_json) VALUES (?, ?, ?, ?, ?)",
      [
        "2026-09-06",
        "valid",
        "created",
        "Research",
        '{"total":2,"passed":1,"failed":1,"pass_rate":0.5,"future_field":true}',
      ],
    );
    db.run(
      "INSERT INTO evolution_audit (timestamp, proposal_id, action, details) VALUES (?, ?, ?, ?)",
      ["2026-09-06", "unknown", "future_action", "Research"],
    );
    expect(queryEvolutionAudit(db)).toHaveLength(2);
    const entries = readAuditTrail("Research");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      proposal_id: "valid",
      eval_snapshot: { total: 2, passed: 1, failed: 1, pass_rate: 0.5, future_field: true },
    });
  } finally {
    _setTestDb(null);
    db.close();
  }
});

test("local canonical export decodes evidence while retaining nested extensions", () => {
  const root = mkdtempSync(join(tmpdir(), "selftune-export-evidence-"));
  const db = openDb(join(root, "selftune.db"));
  try {
    const insert = db.query(
      "INSERT INTO evolution_evidence (timestamp, proposal_id, skill_name, skill_path, target, stage, validation_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      "2026-09-06",
      "valid",
      "research",
      "/local/research",
      "description",
      "validated",
      '{"improved":true,"future_metadata":{"measured":false}}',
    );
    insert.run(
      "2026-09-06",
      "unknown",
      "research",
      "/local/research",
      "unsupported",
      "validated",
      "{}",
    );
  } finally {
    db.close();
  }
  try {
    const child = Bun.spawnSync(
      [
        process.execPath,
        fileURLToPath(
          new URL("../../packages/orchestration/src/canonical-export.ts", import.meta.url),
        ),
        "--platform",
        "codex",
        "--push-payload",
        "--log",
        join(root, "absent.jsonl"),
        "--projects-dir",
        join(root, "absent-projects"),
      ],
      { env: { ...process.env, SELFTUNE_CONFIG_DIR: root }, stdout: "pipe", stderr: "pipe" },
    );
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    const output = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          canonical: Schema.Struct({ evolution_evidence: Schema.Array(Schema.Json) }),
        }),
      ),
    )(new TextDecoder().decode(child.stdout));
    expect(output.canonical.evolution_evidence).toHaveLength(1);
    expect(output.canonical.evolution_evidence[0]).toMatchObject({
      proposal_id: "valid",
      validation_json: { improved: true, future_metadata: { measured: false } },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
