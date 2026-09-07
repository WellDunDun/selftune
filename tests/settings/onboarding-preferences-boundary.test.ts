import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeLegacyOnboardingPreferences,
  defaultOnboardingPreferences,
  loadOnboardingPreferences,
  normalizeOnboardingRequest,
  persistedPreferences,
} from "../../packages/runtime/onboarding-preferences.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function savedConfig(raw: string) {
  const root = mkdtempSync(join(tmpdir(), "selftune-onboarding-boundary-"));
  roots.push(root);
  writeFileSync(join(root, "config.json"), raw);
  return root;
}

test.each(["{", "null", "[]", "42", "{}", '{"preferences":null}', '{"preferences":[]}'])(
  "leaves malformed config unchanged and does not mark onboarding complete: %s",
  (raw) => {
    const root = savedConfig(raw);
    expect(loadOnboardingPreferences(root)).toEqual(defaultOnboardingPreferences());
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(raw);
  },
);

test("saved preferences keep valid false flags beside invalid fields", () => {
  const preferences = {
    import_sources: { claude_code: false, codex: "false", cline: true, pi: 0, future: true },
    features: { observability: false, health_recommendations: null, autonomous_improvement: true },
    hook_harnesses: { claude_code: true },
  };
  const root = savedConfig(JSON.stringify({ preferences }));
  const expected = defaultOnboardingPreferences();
  expected.completed = true;
  expected.import_sources.claude_code = false;
  expected.import_sources.cline = true;
  expected.features.observability = false;
  expected.features.autonomous_improvement = true;
  expect(loadOnboardingPreferences(root)).toEqual(expected);
  expect(decodeLegacyOnboardingPreferences({ version: 1, ...preferences })).toEqual(
    persistedPreferences(expected),
  );
});

test.each([
  { input: null },
  { input: [] },
  { input: {} },
  { input: { version: "1" } },
  { input: { version: 2 } },
])("refuses unsupported legacy versions: %j", ({ input }) => {
  expect(decodeLegacyOnboardingPreferences(input)).toBeNull();
});

test("normalization deduplicates selections and preserves explicit opt-outs", () => {
  const result = normalizeOnboardingRequest({
    import_sources: ["codex", "codex", "openclaw"],
    hook_harnesses: ["pi", "pi"],
    features: {
      observability: false,
      health_recommendations: false,
      autonomous_improvement: false,
    },
  });
  expect(result.import_sources).toEqual({
    claude_code: false,
    cline: false,
    codex: true,
    opencode: false,
    openclaw: true,
    pi: false,
  });
  expect(result.hook_harnesses).toEqual({
    claude_code: false,
    cline: false,
    codex: false,
    opencode: false,
    pi: true,
  });
  expect(result.features).toEqual({
    observability: false,
    health_recommendations: false,
    autonomous_improvement: false,
  });
  expect(result.completed).toBeTrue();
});

test.each([
  { input: null },
  { input: [] },
  { input: {} },
  { input: { import_sources: [], hook_harnesses: [] } },
  { input: { import_sources: [], hook_harnesses: [], features: {} } },
  {
    input: {
      import_sources: [],
      hook_harnesses: [],
      features: {
        observability: "false",
        health_recommendations: true,
        autonomous_improvement: false,
      },
    },
  },
  {
    input: {
      import_sources: ["future"],
      hook_harnesses: [],
      features: {
        observability: false,
        health_recommendations: true,
        autonomous_improvement: false,
      },
    },
  },
  {
    input: {
      import_sources: [],
      hook_harnesses: ["openclaw"],
      features: {
        observability: false,
        health_recommendations: true,
        autonomous_improvement: false,
      },
    },
  },
])("rejects incomplete or malformed onboarding requests: %j", ({ input }) => {
  expect(() => normalizeOnboardingRequest(input)).toThrow();
});
