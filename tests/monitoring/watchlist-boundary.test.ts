import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadWatchedSkills } from "../../packages/runtime/watchlist.js";

let root: string;
let path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "selftune-watchlist-"));
  path = join(root, "watched-skills.json");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("missing watchlists are empty", () => {
  expect(loadWatchedSkills(path)).toEqual([]);
});

test.each([
  "not-json",
  "null",
  "[]",
  "{}",
  '{"version":2,"skills":["example"]}',
  '{"version":"1","skills":["example"]}',
  '{"version":1,"skills":null}',
  '{"version":1,"skills":{}}',
])("invalid saved watchlist %s is empty and stays unchanged", (saved) => {
  writeFileSync(path, saved);
  expect(loadWatchedSkills(path)).toEqual([]);
  expect(readFileSync(path, "utf-8")).toBe(saved);
});

test("valid names survive malformed neighbors, trimming and duplicate removal", () => {
  const saved = JSON.stringify({
    version: 1,
    skills: [" example ", null, 42, {}, [], true, "", "   ", "example", "Example", "second"],
    extension: "preserved on disk",
  });
  writeFileSync(path, saved);
  expect(loadWatchedSkills(path)).toEqual(["example", "Example", "second"]);
  expect(readFileSync(path, "utf-8")).toBe(saved);
});
