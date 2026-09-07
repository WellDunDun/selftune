import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSkillSet, listSkillSetReceipts } from "@selftune/library";
import type { SkillSetReceipt, StoredSkillSetManifest } from "../../packages/library/src/types.js";
import {
  decodeSkillSetReceipt,
  decodeStoredSkillSetManifest,
} from "../../packages/library/src/schemas.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const manifest = {
  schema_version: 1,
  set_id: "set",
  name: "Set",
  description: "Test",
  harnesses: ["codex"],
  skills: [],
  created_at: "2026-09-06T00:00:00Z",
  updated_at: "2026-09-06T00:00:00Z",
} satisfies Omit<StoredSkillSetManifest, "revision" | "revision_hash" | "parent_revision_hash">;
const receipt = {
  schema_version: 1,
  receipt_id: "receipt",
  set_id: "set",
  set_name: "Set",
  project_root: "/tmp/test-only",
  status: "unchanged",
  operations: [],
  applied_at: "2026-09-06T00:00:00Z",
  rolled_back_at: null,
} satisfies Omit<SkillSetReceipt, "set_revision_hash">;

test("decodes legacy defaults while keeping absent receipt metadata absent", () => {
  expect(decodeStoredSkillSetManifest(JSON.stringify(manifest))).toEqual({
    ...manifest,
    revision: 1,
    revision_hash: "",
    parent_revision_hash: null,
  });
  const decoded = decodeSkillSetReceipt(JSON.stringify(receipt));
  expect(decoded).toEqual({ ...receipt, set_revision_hash: "" });
  expect(decoded).not.toHaveProperty("temporary_task");
  expect(decoded).not.toHaveProperty("temporary_targets");
});

test.each([{ targets: [] }, { targets: ["/tmp/test-only/.agents/skills/marketing"] }])(
  "retains temporary receipt targets $targets",
  ({ targets }) => {
    const decoded = decodeSkillSetReceipt(
      JSON.stringify({ ...receipt, temporary_task: "task-a", temporary_targets: targets }),
    );
    expect(decoded.temporary_task).toBe("task-a");
    expect(decoded.temporary_targets).toEqual(targets);
  },
);

test.each([
  { bytes: "{" },
  { bytes: "null" },
  { bytes: "[]" },
  { bytes: JSON.stringify({ ...manifest, harnesses: ["invalid"] }) },
])("preserves malformed saved manifests: $bytes", ({ bytes }) => {
  const root = mkdtempSync(join(tmpdir(), "selftune-stored-manifest-"));
  roots.push(root);
  mkdirSync(join(root, "skill-sets"));
  const path = join(root, "skill-sets", "set.json");
  writeFileSync(path, bytes);
  expect(() => getSkillSet("set", { configRoot: root })).toThrow("invalid manifest");
  expect(readFileSync(path, "utf8")).toBe(bytes);
});

test.each([
  { bytes: "{" },
  { bytes: "null" },
  { bytes: JSON.stringify({ ...receipt, status: "invalid" }) },
  { bytes: JSON.stringify({ ...receipt, temporary_targets: [42] }) },
])("preserves malformed saved receipts: $bytes", ({ bytes }) => {
  const root = mkdtempSync(join(tmpdir(), "selftune-stored-receipt-"));
  roots.push(root);
  mkdirSync(join(root, "skill-set-receipts"));
  const path = join(root, "skill-set-receipts", "receipt.json");
  writeFileSync(path, bytes);
  expect(() => listSkillSetReceipts({ configRoot: root })).toThrow("invalid");
  expect(readFileSync(path, "utf8")).toBe(bytes);
});
