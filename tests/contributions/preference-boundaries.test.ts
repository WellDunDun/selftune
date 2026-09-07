import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadContributionPreferences,
  resetContributionPreferencesState,
} from "../../packages/runtime/contribution-preferences.js";
import { discoverCreatorContributionConfigs } from "../../packages/runtime/contribution-config.js";
import { resolveEligibleContributionConfigs } from "../../packages/runtime/contribution-staging.js";

let root: string;
let previousConfig: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "selftune-contribution-boundaries-"));
  previousConfig = process.env.SELFTUNE_CONFIG_DIR;
  process.env.SELFTUNE_CONFIG_DIR = root;
  resetContributionPreferencesState();
});
afterEach(() => {
  if (previousConfig === undefined) delete process.env.SELFTUNE_CONFIG_DIR;
  else process.env.SELFTUNE_CONFIG_DIR = previousConfig;
  resetContributionPreferencesState();
  rmSync(root, { recursive: true, force: true });
});

test("malformed optional metadata preserves opt-outs and valid signal neighbors", () => {
  writeFileSync(
    join(root, "contribution-preferences.json"),
    JSON.stringify({
      global_default: "always",
      skills: {
        review: {
          status: "opted_out",
          opted_out_at: 42,
          creator_id: {},
          signals: ["trigger", null, "invented", "grade"],
        },
        valid: { status: "opted_in", creator_id: "creator", signals: ["miss_category"] },
        invalid: { status: "invented" },
      },
    }),
  );
  const preferences = loadContributionPreferences();
  expect(preferences.skills.review).toEqual({
    status: "opted_out",
    opted_in_at: undefined,
    opted_out_at: undefined,
    creator_id: undefined,
    signals: ["trigger", "grade"],
  });
  expect(preferences.skills.valid?.signals).toEqual(["miss_category"]);
  expect(preferences.skills.invalid).toBeUndefined();
  expect(
    resolveEligibleContributionConfigs(preferences, [
      {
        version: 1,
        creator_id: "550e8400-e29b-41d4-a716-446655440000",
        skill_name: "review",
        config_path: "config",
        skill_path: "skill",
        contribution: { enabled: true, signals: ["trigger"] },
      },
    ]),
  ).toEqual([]);
});

test.each(["null", "[]", "not json", JSON.stringify({ global_default: true, skills: [] })])(
  "invalid preferences remain ask-first: %s",
  (contents) => {
    writeFileSync(join(root, "contribution-preferences.json"), contents);
    expect(loadContributionPreferences()).toEqual({
      version: 1,
      global_default: "ask",
      skills: {},
    });
  },
);

test("config discovery validates consent fields and retains valid neighboring packages", () => {
  const valid = {
    version: 1,
    creator_id: "550e8400-e29b-41d4-a716-446655440000",
    skill_name: "review",
    contribution: {
      enabled: true,
      signals: [" trigger ", 42, "grade", "trigger"],
      message: {},
      privacy_url: false,
    },
  };
  for (const [name, config] of [
    ["valid", valid],
    ["bad-signal", { ...valid, contribution: { enabled: true, signals: ["invented"] } }],
    ["bad-consent", { ...valid, contribution: { enabled: "yes", signals: ["trigger"] } }],
    ["bad-creator", { ...valid, creator_id: 42 }],
  ] as const) {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, "SKILL.md"), "# Review");
    writeFileSync(join(path, "selftune.contribute.json"), JSON.stringify(config));
  }
  const configs = discoverCreatorContributionConfigs([root]);
  expect(configs).toHaveLength(1);
  expect(configs[0]?.skill_name).toBe("review");
  expect(configs[0]?.contribution).toEqual({
    enabled: true,
    signals: ["trigger", "grade"],
    message: undefined,
    privacy_url: undefined,
  });
});
