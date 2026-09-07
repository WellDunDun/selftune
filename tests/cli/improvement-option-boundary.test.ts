import { afterEach, expect, test } from "bun:test";
import { runImprove } from "@selftune/orchestration/improve";
import { cliMain as searchRunCliMain } from "@selftune/orchestration/search-run";

const originalArgv = [...process.argv];
afterEach(() => {
  process.argv = [...originalArgv];
});

test.each(["invalid", "BODY", "body ", "", "both"])(
  "rejects unsupported improvement scope before delegation: %j",
  async (scope) => {
    let delegated = false;
    const run = async () => {
      delegated = true;
    };
    await expect(
      runImprove([`--scope=${scope}`], {
        evolveCliMain: run,
        evolveBodyCliMain: run,
        searchRunCliMain: run,
      }),
    ).rejects.toThrow("Invalid --scope value");
    expect(delegated).toBeFalse();
  },
);

test.each([
  { scope: "auto", expected: "description" },
  { scope: "description", expected: "description" },
  { scope: "routing", expected: "body" },
  { scope: "body", expected: "body" },
  { scope: "package", expected: "package" },
])("keeps the existing delegation for %j", async ({ scope, expected }) => {
  const calls: string[] = [];
  await runImprove(["--scope", scope, "--dry-run"], {
    evolveCliMain: async () => {
      calls.push("description");
    },
    evolveBodyCliMain: async () => {
      calls.push("body");
    },
    searchRunCliMain: async () => {
      calls.push("package");
    },
  });
  expect(calls).toEqual([expected]);
});

test.each(["invalid", "BODY", "body ", "", "package"])(
  "rejects unsupported search surfaces before loading files: %j",
  async (surface) => {
    process.argv = [
      "bun",
      "search-run.ts",
      "--skill-path",
      "/nonexistent/selftune-boundary/SKILL.md",
      `--surface=${surface}`,
    ];
    await expect(searchRunCliMain()).rejects.toThrow("Invalid --surface value");
  },
);

test.each(["routing", "body", "both"])(
  "accepts %s before checking the next flag",
  async (surface) => {
    process.argv = [
      "bun",
      "search-run.ts",
      "--skill-path",
      "/nonexistent/selftune-boundary/SKILL.md",
      "--surface",
      surface,
      "--max-candidates",
      "0",
    ];
    await expect(searchRunCliMain()).rejects.toThrow("Invalid --max-candidates value");
  },
);
