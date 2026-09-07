import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@selftune/control-plane";
import * as Schema from "effect/Schema";
import {
  encodePackageBundle,
  encodePackageBundleWithOptions,
  restorePackage,
} from "../../packages/runtime/remote-library/package-bundle.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(provenance: string) {
  const root = mkdtempSync(join(tmpdir(), "selftune-bundle-provenance-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "SKILL.md"), "# Local fixture\n");
  writeFileSync(join(source, "selftune.synthesis.json"), provenance);
  return { source, destination: join(root, "restored") };
}

test("backup pseudonymizes valid session IDs and preserves nested JSON and existing hashes", () => {
  const hash = "a".repeat(64);
  const provenance = JSON.stringify({
    supporting_session_ids: [null, "session-one", 42, hash],
    held_out_session_ids: false,
    nested: { evidence_snapshot_id: hash, values: [true, false, null, 7, "ordinary"] },
  });
  const { source, destination } = fixture(provenance);
  const bytes = encodePackageBundle(source, true);
  expect(restorePackage(bytes, destination)).toBeUndefined();
  const restored = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
    readFileSync(join(destination, "selftune.synthesis.json"), "utf8"),
  );
  expect(restored).toEqual({
    supporting_session_ids: [sha256(new TextEncoder().encode("session-one")), hash],
    held_out_session_ids: [],
    nested: { evidence_snapshot_id: hash, values: [true, false, null, 7, "ordinary"] },
  });
  expect(readFileSync(join(source, "selftune.synthesis.json"), "utf8")).toBe(provenance);
});

test.each(["null", "[]", "{invalid", '"not provenance"'])(
  "rejects invalid provenance before producing a backup: %s",
  (provenance) => {
    const { source } = fixture(provenance);
    expect(() => encodePackageBundle(source, true)).toThrow("Draft provenance cannot be prepared");
    expect(readFileSync(join(source, "selftune.synthesis.json"), "utf8")).toBe(provenance);
  },
);

test("a hash exemption does not exempt a neighboring credential from the secret scan", () => {
  const { source } = fixture(
    JSON.stringify({
      evidence_snapshot_id: "a".repeat(64),
      note: ["sk-", "EXAMPLECREDENTIALPLACEHOLDER123456"].join(""),
    }),
  );
  expect(() => encodePackageBundle(source, true)).toThrow("found a secret");
});

test.each([
  {
    stderr: '{"reason":"decoded_file_too_large","message":"bounded message","path":"SKILL.md"}',
    expected: "bounded message",
  },
  {
    stderr: '{"reason":"invalid_package","message":"wrong reason","path":"SKILL.md"}',
    expected: "invalid_package",
  },
  {
    stderr: '{"reason":"decoded_file_too_large","message":42,"path":"SKILL.md"}',
    expected: "process failed",
  },
  { stderr: "{invalid", expected: "process failed" },
])("validates collector diagnostics against the exit reason: $stderr", ({ stderr, expected }) => {
  const { source } = fixture("{}");
  expect(() =>
    encodePackageBundleWithOptions(source, {
      collector: {
        spawn: () => ({
          pid: 1,
          output: [null, Buffer.alloc(0), Buffer.from(stderr)],
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(stderr),
          status: 3,
          signal: null,
        }),
      },
    }),
  ).toThrow(expected);
});
