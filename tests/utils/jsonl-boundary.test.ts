import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { createDashboardEventHub } from "../../apps/local/src/dashboard-events";
import { decodeDashboardActionLine } from "../../packages/runtime/dashboard-contract/action-events";
import {
  jsonlDecoder,
  loadMarker,
  readJsonl,
  readJsonlFrom,
} from "../../packages/runtime/utils/jsonl";
import {
  decodeEvolutionEvidenceLine,
  decodeSkillUsageLine,
} from "../../packages/runtime/utils/log-contracts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "selftune-jsonl-boundary-"));
  roots.push(root);
  return join(root, "records.jsonl");
}

const decodeMessage = jsonlDecoder(Schema.Struct({ message: Schema.String }));
const skillRecord = {
  timestamp: "2026-09-06T00:00:00Z",
  session_id: "session-1",
  skill_name: "research",
  skill_path: "/fixture/research/SKILL.md",
  query: "research a topic",
  triggered: true,
};

test("malformed rows do not discard neighboring records or undeclared local evidence", () => {
  const path = fixture();
  writeFileSync(
    path,
    [
      JSON.stringify({ ...skillRecord, skill_scope: 7, historical_context: { kind: "repaired" } }),
      "not json",
      "null",
      JSON.stringify({ ...skillRecord, query: null }),
      JSON.stringify({ ...skillRecord, session_id: "session-2", triggered: false }),
    ].join("\n"),
  );
  const records = readJsonl(path, decodeSkillUsageLine);
  expect(records).toHaveLength(2);
  expect(records[0]).not.toHaveProperty("skill_scope");
  expect(records[0]).toHaveProperty("historical_context", { kind: "repaired" });
  expect(records[1].triggered).toBe(false);
});

test("incremental reads keep a byte cursor across multibyte text and partial records", () => {
  const path = fixture();
  const first = JSON.stringify({ message: "مرحبا 🌍" }) + "\n";
  const second = JSON.stringify({ message: "second 🌍" }) + "\n";
  const bytes = Buffer.from(second);
  const split = bytes.indexOf(Buffer.from("🌍")) + 2;
  writeFileSync(path, Buffer.concat([Buffer.from(first), bytes.subarray(0, split)]));
  const initial = readJsonlFrom(path, 0, decodeMessage);
  expect(initial.records).toEqual([{ message: "مرحبا 🌍" }]);
  expect(initial.newOffset).toBe(Buffer.byteLength(first));
  expect(readJsonlFrom(path, initial.newOffset, decodeMessage)).toEqual({
    records: [],
    newOffset: initial.newOffset,
  });
  appendFileSync(path, bytes.subarray(split));
  const next = readJsonlFrom(path, initial.newOffset, decodeMessage);
  expect(next.records).toEqual([{ message: "second 🌍" }]);
  expect(next.newOffset).toBe(Buffer.byteLength(first + second));
  expect(readJsonlFrom(path, next.newOffset, decodeMessage)).toEqual({
    records: [],
    newOffset: next.newOffset,
  });
});

test("invalid complete records advance the cursor while an unfinished tail waits", () => {
  const path = fixture();
  const prefix = '{"message":5}\nnull\nnot-json\n';
  const tail = '{"message":"ready"}';
  writeFileSync(path, prefix + tail);
  const initial = readJsonlFrom(path, 0, decodeMessage);
  expect(initial).toEqual({ records: [], newOffset: Buffer.byteLength(prefix) });
  appendFileSync(path, "\n");
  expect(readJsonlFrom(path, initial.newOffset, decodeMessage).records).toEqual([
    { message: "ready" },
  ]);
});

test("missing and truncated files preserve incremental reset semantics", () => {
  const path = fixture();
  expect(readJsonlFrom(path, 20, decodeMessage)).toEqual({ records: [], newOffset: 0 });
  writeFileSync(path, "\n");
  expect(readJsonlFrom(path, 20, decodeMessage)).toEqual({ records: [], newOffset: 1 });
});

test("marker decoding retains valid string neighbors only", () => {
  const path = fixture();
  writeFileSync(path, '["session-1",null,42,{"id":"session-2"},"session-3"]');
  expect(loadMarker(path)).toEqual(new Set(["session-1", "session-3"]));
});

test("evolution evidence preserves validation extensions without trusting malformed optional fields", () => {
  const decoded = decodeEvolutionEvidenceLine(
    JSON.stringify({
      timestamp: skillRecord.timestamp,
      proposal_id: "proposal-1",
      skill_name: "research",
      skill_path: skillRecord.skill_path,
      target: "body",
      stage: "validated",
      validation: {
        improved: true,
        before_pass_rate: "bad",
        after_pass_rate: 0.9,
        future_receipt: "receipt-1",
      },
      future_evidence: { score: 0.8 },
    }),
  );
  expect(decoded.validation?.improved).toBe(true);
  expect(decoded.validation?.before_pass_rate).toBeUndefined();
  expect(decoded.validation?.after_pass_rate).toBe(0.9);
  expect(decoded.validation).toHaveProperty("future_receipt", "receipt-1");
  expect(decoded).toHaveProperty("future_evidence", { score: 0.8 });
});

test("the live action stream ignores malformed rows and delivers the next valid event", async () => {
  const path = fixture();
  writeFileSync(path, "");
  const hub = createDashboardEventHub({ databasePath: path + ".db", actionStreamPath: path });
  const reader = hub.response().body?.getReader();
  if (!reader) throw new Error("Missing event response body");
  try {
    await reader.read();
    appendFileSync(
      path,
      [
        "not-json",
        JSON.stringify({ event_id: "invalid", action: "watch" }),
        JSON.stringify({
          event_id: "valid",
          action: "watch",
          stage: "finished",
          skill_name: null,
          skill_path: null,
          ts: 1,
          success: true,
          metrics: 5,
        }),
        "",
      ].join("\n"),
    );
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toStartWith("event: action\n");
    const payload = chunk
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    if (!payload) throw new Error("Missing action payload");
    const event = decodeDashboardActionLine(payload);
    expect(event.event_id).toBe("valid");
    expect(event.success).toBe(true);
    expect(event.metrics).toBeUndefined();
  } finally {
    await reader.cancel();
    hub.stop();
  }
});
