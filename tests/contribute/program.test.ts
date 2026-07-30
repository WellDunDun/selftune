import { describe, expect, test } from "bun:test";

import {
  formatContributeResult,
  runContribute,
  type ContributeProgramDependencies,
  type ContributionSubmissionAttempt,
} from "../../packages/runtime/contribute/program.js";
import type { ContributionBundle } from "../../packages/runtime/types.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

const bundle: ContributionBundle = {
  schema_version: "1.2",
  skill_name: "demo",
  contributor_id: "anonymous",
  created_at: "2026-01-02T03:04:05.000Z",
  selftune_version: "test",
  agent_type: "codex",
  sanitization_level: "conservative",
  positive_queries: [{ query: "use demo", invocation_type: "implicit", source: "test" }],
  eval_entries: [{ query: "use demo", should_trigger: true }],
  grading_summary: null,
  evolution_summary: null,
  session_metrics: {
    total_sessions: 2,
    avg_assistant_turns: 3,
    avg_tool_calls: 4,
    avg_errors: 0,
    top_tools: [],
  },
};

const success: ContributionSubmissionAttempt = { ok: true, stdout: ["submitted"], stderr: [] };

function makeDependencies(
  overrides: Partial<ContributeProgramDependencies> = {},
): ContributeProgramDependencies {
  return {
    now: overrides.now ?? (() => new Date("2026-01-02T03:04:05.000Z")),
    assemble: overrides.assemble ?? (() => bundle),
    sanitize: overrides.sanitize ?? ((value) => value),
    write: overrides.write ?? (() => {}),
    submitToService: overrides.submitToService ?? (async () => success),
    submitToGitHub: overrides.submitToGitHub ?? (() => success),
  };
}

describe("contribute program", () => {
  test("preview sanitizes but skips writing and submission", async () => {
    const events: string[] = [];
    const result = await runContribute(
      { preview: true, submit: true, github: true, sanitizationLevel: "unknown" },
      makeDependencies({
        assemble: (options) => {
          events.push(`assemble:${options.sanitizationLevel}`);
          return bundle;
        },
        sanitize: (value, level) => {
          events.push(`sanitize:${level}`);
          return value;
        },
        write: () => events.push("write"),
        submitToGitHub: () => {
          events.push("github");
          return success;
        },
      }),
    );

    expect(events).toEqual(["assemble:conservative", "sanitize:conservative"]);
    expect(result).toMatchObject({ preview: true, outputPath: null, exitCode: 0 });
    expect(JSON.parse(formatContributeResult(result).stdout[0]!)).toMatchObject({
      skill_name: "demo",
    });
  });

  test("writes before a successful service submission", async () => {
    const events: string[] = [];
    const result = await runContribute(
      {
        skillName: "demo",
        outputPath: "/tmp/demo.json",
        submit: true,
        endpoint: "https://example.test",
      },
      makeDependencies({
        write: (path, contents) => {
          events.push(`write:${path}:${contents.includes('"skill_name": "demo"')}`);
        },
        submitToService: async (_json, endpoint, skillName) => {
          events.push(`service:${endpoint}:${skillName}`);
          return success;
        },
        submitToGitHub: () => {
          events.push("github");
          return success;
        },
      }),
    );

    expect(events).toEqual(["write:/tmp/demo.json:true", "service:https://example.test:demo"]);
    expect(result).toMatchObject({ exitCode: 0, fellBackToGitHub: false });
  });

  test("falls back to GitHub and derives exit status from the fallback", async () => {
    const serviceFailure: ContributionSubmissionAttempt = {
      ok: false,
      stdout: [],
      stderr: ["service failed"],
    };
    const githubFailure: ContributionSubmissionAttempt = {
      ok: false,
      stdout: [],
      stderr: ["github failed"],
    };
    const [recovered, failed] = await Promise.all([
      runContribute(
        { submit: true, outputPath: "/tmp/recovered.json", endpoint: "https://example.test" },
        makeDependencies({
          submitToService: async () => serviceFailure,
          submitToGitHub: () => success,
        }),
      ),
      runContribute(
        { submit: true, outputPath: "/tmp/failed.json", endpoint: "https://example.test" },
        makeDependencies({
          submitToService: async () => serviceFailure,
          submitToGitHub: () => githubFailure,
        }),
      ),
    ]);

    expect(recovered).toMatchObject({ fellBackToGitHub: true, exitCode: 0 });
    expect(failed).toMatchObject({ fellBackToGitHub: true, exitCode: 1 });
    expect(formatContributeResult(failed)).toMatchObject({
      stdout: expect.arrayContaining(["Falling back to GitHub submission..."]),
      stderr: ["service failed", "github failed"],
    });
  });

  test("direct GitHub submission bypasses the service", async () => {
    let serviceCalls = 0;
    const result = await runContribute(
      { submit: true, github: true, outputPath: "/tmp/direct.json" },
      makeDependencies({
        submitToService: async () => {
          serviceCalls += 1;
          return success;
        },
      }),
    );
    expect(serviceCalls).toBe(0);
    expect(result).toMatchObject({
      serviceSubmission: null,
      fellBackToGitHub: false,
      exitCode: 0,
    });
  });

  test("rejects invalid since values before assembling a bundle", async () => {
    let assembled = false;
    const error = await runContribute(
      { since: "not-a-date" },
      makeDependencies({
        assemble: () => {
          assembled = true;
          return bundle;
        },
      }),
    ).catch((cause: unknown) => cause);

    expect(assembled).toBe(false);
    expect(error).toBeInstanceOf(CLIError);
    expect(error).toMatchObject({
      code: "INVALID_FLAG",
      message: 'Invalid --since date: "not-a-date". Use a valid date format (e.g., 2026-01-01).',
    });
  });
});
