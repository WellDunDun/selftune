import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalArgv = [...process.argv];
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const configRoot = mkdtempSync(join(tmpdir(), "selftune-apply-proposal-config-"));
const mockedConfigPath = join(configRoot, "config.json");

mock.module("../../cli/selftune/constants.js", () => ({
  SELFTUNE_CONFIG_PATH: mockedConfigPath,
}));

const { cliMain } = await import("../../cli/selftune/evolution/apply-proposal.js");

let tmpDir: string;
let skillPath: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-apply-proposal-test-"));
  skillPath = join(tmpDir, "skills", "test-skill", "SKILL.md");
  mkdirSync(join(tmpDir, "skills", "test-skill"), { recursive: true });
  writeFileSync(skillPath, "# Test Skill\n\nOriginal description.\n", "utf-8");

  writeFileSync(
    mockedConfigPath,
    JSON.stringify(
      {
        alpha: {
          user_id: "user-test-1",
          cloud_user_id: "cloud-user-test-1",
          enrolled: true,
          api_key: "st_test_123",
          cloud_api_url: "https://api.example.test",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  logs = [];
  errors = [];
  console.log = mock((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  }) as typeof console.log;
  console.error = mock((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  }) as typeof console.error;
});

afterEach(() => {
  process.argv = [...originalArgv];
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(mockedConfigPath, { force: true });
});

describe("apply-proposal CLI", () => {
  test("does not print applied success when cloud PATCH fails", async () => {
    process.argv = ["bun", "apply-proposal", "--id", "prop-123", "--skill-path", skillPath];

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "GET" && url === "https://api.example.test/api/v1/proposals/prop-123") {
        return new Response(
          JSON.stringify({
            proposal: {
              id: "prop-123",
              skill_id: "skill-123",
              skill_name: "test-skill",
              proposal_type: "description",
              current_value: "Original description.",
              proposed_value: "Updated description from the cloud.",
              reason: "Improve trigger clarity",
              pass_rate_before: 0.6,
              projected_pass_rate: 0.8,
              status: "approved",
              proposed_by: "contributor_aggregate",
              reviewed_by: "reviewer-1",
              reviewed_at: "2026-04-01T00:00:00.000Z",
              applied_at: null,
              created_at: "2026-04-01T00:00:00.000Z",
            },
          }),
          { status: 200 },
        );
      }

      if (
        init?.method === "PATCH" &&
        url === "https://api.example.test/api/v1/proposals/prop-123"
      ) {
        return new Response("forbidden", { status: 403 });
      }

      throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
    }) as unknown as typeof fetch;

    await cliMain();

    expect(readFileSync(skillPath, "utf-8")).toContain("Updated description from the cloud.");
    expect(logs.some((line) => line.includes("Applied proposal to"))).toBe(true);
    expect(logs.some((line) => line.includes("Proposal prop-123 marked as applied."))).toBe(false);
    expect(
      errors.some((line) => line.includes("Warning: Failed to mark proposal as applied: HTTP 403")),
    ).toBe(true);
  });
});
