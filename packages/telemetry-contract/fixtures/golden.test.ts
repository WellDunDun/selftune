import { describe, expect, test } from "bun:test";
import { CANONICAL_SCHEMA_VERSION } from "../src/types.js";
import { isCanonicalRecord } from "../src/validators.js";
import { rawSourceRefSchema } from "../src/schemas.js";

import fixtures from "./golden.json";

describe("golden fixtures", () => {
  test("portable metadata accepts JSON evidence but rejects runtime objects", () => {
    expect(
      rawSourceRefSchema.safeParse({ metadata: { source: "codex", nested: [1, true, null] } })
        .success,
    ).toBe(true);
    expect(rawSourceRefSchema.safeParse({ metadata: { started: new Date() } }).success).toBe(false);
    expect(rawSourceRefSchema.safeParse({ metadata: { callback: () => "not JSON" } }).success).toBe(
      false,
    );
  });
  test("all fixtures pass isCanonicalRecord", () => {
    for (const fixture of fixtures) {
      const desc = fixture._description ?? fixture.record_kind;
      const result = isCanonicalRecord(fixture);
      if (!result) throw new Error(`Failed: ${desc}`);
      expect(result).toBe(true);
    }
  });

  test("all fixtures use current schema version", () => {
    for (const fixture of fixtures) {
      expect(fixture.schema_version).toBe(CANONICAL_SCHEMA_VERSION);
    }
  });

  test("covers every record_kind", () => {
    const kinds = new Set(fixtures.map((f) => f.record_kind));
    expect(kinds).toContain("session");
    expect(kinds).toContain("prompt");
    expect(kinds).toContain("skill_invocation");
    expect(kinds).toContain("execution_fact");
    expect(kinds).toContain("normalization_run");
  });

  test("mutated fixtures fail validation", () => {
    for (const fixture of fixtures) {
      const bad = { ...fixture, schema_version: "0.0" };
      expect(isCanonicalRecord(bad)).toBe(false);
    }
  });
});
