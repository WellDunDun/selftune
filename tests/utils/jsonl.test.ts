import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendJsonl, loadMarker, readJsonl, saveMarker } from "../../cli/selftune/utils/jsonl.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("readJsonl", () => {
  test("returns empty array for missing file", () => {
    expect(readJsonl(join(tmpDir, "nope.jsonl"))).toEqual([]);
  });

  test("parses valid JSONL lines", () => {
    const path = join(tmpDir, "test.jsonl");
    writeFileSync(path, '{"a":1}\n{"b":2}\n');
    const records = readJsonl(path);
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("skips blank lines and malformed JSON", () => {
    const path = join(tmpDir, "mixed.jsonl");
    writeFileSync(path, '{"ok":true}\n\nnot-json\n{"also":true}\n');
    const records = readJsonl(path);
    expect(records).toEqual([{ ok: true }, { also: true }]);
  });
});

describe("appendJsonl", () => {
  test("creates parent directories and appends", () => {
    const path = join(tmpDir, "nested", "deep", "log.jsonl");
    appendJsonl(path, { key: "val1" });
    appendJsonl(path, { key: "val2" });
    const content = readFileSync(path, "utf-8");
    expect(content).toBe('{"key":"val1"}\n{"key":"val2"}\n');
  });
});

describe("loadMarker / saveMarker", () => {
  test("returns empty set for missing marker", () => {
    expect(loadMarker(join(tmpDir, "nope.json"))).toEqual(new Set());
  });

  test("round-trips a set of strings", () => {
    const path = join(tmpDir, "marker.json");
    const data = new Set(["file-b", "file-a", "file-c"]);
    saveMarker(path, data);
    const loaded = loadMarker(path);
    expect(loaded).toEqual(data);
    // Verify it's sorted in the JSON
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw).toEqual(["file-a", "file-b", "file-c"]);
  });

  test("handles corrupted marker gracefully", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "not-valid-json{{{");
    expect(loadMarker(path)).toEqual(new Set());
  });
});
