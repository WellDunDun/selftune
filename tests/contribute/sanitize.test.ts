import { describe, expect, test } from "bun:test";
import {
  sanitize,
  sanitizeAggressive,
  sanitizeBundle,
  sanitizeConservative,
} from "../../cli/selftune/contribute/sanitize.js";
import type { ContributionBundle } from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Conservative sanitization
// ---------------------------------------------------------------------------

describe("sanitizeConservative", () => {
  test("replaces Unix file paths with [PATH]", () => {
    expect(sanitizeConservative("open /Users/dan/projects/foo.ts")).toBe("open [PATH]");
  });

  test("replaces Windows file paths with [PATH]", () => {
    expect(sanitizeConservative("open C:\\Users\\dan\\file.ts")).toBe("open [PATH]");
  });

  test("replaces email addresses with [EMAIL]", () => {
    expect(sanitizeConservative("send to alice@example.com")).toBe("send to [EMAIL]");
  });

  test("replaces OpenAI API keys with [SECRET]", () => {
    expect(sanitizeConservative("key is sk-abcdefghijklmnopqrstuvwxyz")).toBe("key is [SECRET]");
  });

  test("replaces GitHub PATs with [SECRET]", () => {
    expect(sanitizeConservative("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij")).toBe(
      "token [SECRET]",
    );
  });

  test("replaces AWS access key IDs with [SECRET]", () => {
    expect(sanitizeConservative("aws AKIAIOSFODNN7EXAMPLE")).toBe("aws [SECRET]");
  });

  test("replaces JWTs with [SECRET]", () => {
    const jwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ].join(".");
    expect(sanitizeConservative(`bearer ${jwt}`)).toBe("bearer [SECRET]");
  });

  test("replaces Slack tokens with [SECRET]", () => {
    expect(sanitizeConservative("xoxb-123456789-abcdefg")).toBe("[SECRET]");
  });

  test("replaces npm tokens with [SECRET]", () => {
    expect(sanitizeConservative("npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij")).toBe("[SECRET]");
  });

  test("replaces IP addresses with [IP]", () => {
    expect(sanitizeConservative("connect to 192.168.1.1")).toBe("connect to [IP]");
  });

  test("replaces project name from cwd with [PROJECT]", () => {
    expect(sanitizeConservative("working on olympia module", "olympia")).toBe(
      "working on [PROJECT] module",
    );
  });

  test("replaces UUID session IDs with [SESSION]", () => {
    expect(sanitizeConservative("session a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      "session [SESSION]",
    );
  });

  test("handles multiple patterns in same text", () => {
    const input = "deploy /home/user/app to 10.0.0.1 with sk-abc123def456ghi789jkl012";
    const result = sanitizeConservative(input);
    expect(result).toContain("[PATH]");
    expect(result).toContain("[IP]");
    expect(result).toContain("[SECRET]");
    expect(result).not.toContain("/home/user/app");
    expect(result).not.toContain("10.0.0.1");
    expect(result).not.toContain("sk-abc123");
  });

  test("returns empty string unchanged", () => {
    expect(sanitizeConservative("")).toBe("");
  });

  test("returns already-sanitized text unchanged", () => {
    expect(sanitizeConservative("[PATH] [EMAIL] [SECRET]")).toBe("[PATH] [EMAIL] [SECRET]");
  });

  test("handles text with no sensitive data", () => {
    expect(sanitizeConservative("hello world")).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// Aggressive sanitization
// ---------------------------------------------------------------------------

describe("sanitizeAggressive", () => {
  test("includes all conservative sanitizations", () => {
    expect(sanitizeAggressive("open /Users/dan/file.ts")).toBe("open [PATH]");
    expect(sanitizeAggressive("send to alice@example.com")).toBe("send to [EMAIL]");
  });

  test("replaces long camelCase identifiers with [IDENTIFIER]", () => {
    expect(sanitizeAggressive("call myLongVariableName here")).toBe("call [IDENTIFIER] here");
  });

  test("replaces long PascalCase identifiers with [IDENTIFIER]", () => {
    expect(sanitizeAggressive("use MyLongClassName now")).toBe("use [IDENTIFIER] now");
  });

  test("does not replace short identifiers", () => {
    expect(sanitizeAggressive("use myVar now")).toBe("use myVar now");
  });

  test("replaces double-quoted strings with [STRING]", () => {
    expect(sanitizeAggressive('set value to "some secret"')).toBe("set value to [STRING]");
  });

  test("replaces single-quoted strings with [STRING]", () => {
    expect(sanitizeAggressive("set value to 'some secret'")).toBe("set value to [STRING]");
  });

  test("replaces module paths after import with [MODULE]", () => {
    expect(sanitizeAggressive('import "./my-module"')).toBe("import [MODULE]");
  });

  test("replaces quoted require paths with [STRING] (require uses parens not spaces)", () => {
    // MODULE_PATTERN expects whitespace after keyword; require() uses parens,
    // so the quoted string pattern catches it instead
    expect(sanitizeAggressive("require('./my-module')")).toBe("require([STRING])");
  });

  test("replaces module paths after from with [MODULE]", () => {
    expect(sanitizeAggressive('from "./utils/helpers"')).toBe("from [MODULE]");
  });

  test("truncates long text to max length", () => {
    const longText = "a".repeat(300);
    const result = sanitizeAggressive(longText);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  test("handles empty string", () => {
    expect(sanitizeAggressive("")).toBe("");
  });

  test("handles mixed patterns", () => {
    const input = 'import "./myLongModule" from "/Users/dan/myLongVariableName"';
    const result = sanitizeAggressive(input);
    expect(result).not.toContain("myLongModule");
    expect(result).not.toContain("/Users/dan");
    expect(result).not.toContain("myLongVariableName");
  });
});

// ---------------------------------------------------------------------------
// sanitize (dispatcher)
// ---------------------------------------------------------------------------

describe("sanitize", () => {
  test("dispatches to conservative", () => {
    expect(sanitize("open /Users/dan/file.ts", "conservative")).toBe("open [PATH]");
  });

  test("dispatches to aggressive", () => {
    const long = "a".repeat(300);
    expect(sanitize(long, "aggressive").length).toBeLessThanOrEqual(200);
  });

  test("passes project name through", () => {
    expect(sanitize("working on olympia", "conservative", "olympia")).toBe("working on [PROJECT]");
  });
});

// ---------------------------------------------------------------------------
// sanitizeBundle
// ---------------------------------------------------------------------------

describe("sanitizeBundle", () => {
  const baseBundle: ContributionBundle = {
    schema_version: "1.0",
    contributor_id: "test-id",
    created_at: "2025-01-01T00:00:00Z",
    selftune_version: "0.1.0",
    agent_type: "claude_code",
    sanitization_level: "conservative",
    positive_queries: [
      { query: "open /Users/dan/file.ts", invocation_type: "explicit", source: "skill_log" },
    ],
    eval_entries: [
      { query: "email alice@example.com", should_trigger: true, invocation_type: "explicit" },
    ],
    grading_summary: null,
    evolution_summary: null,
    session_metrics: {
      total_sessions: 1,
      avg_assistant_turns: 5,
      avg_tool_calls: 10,
      avg_errors: 0,
      top_tools: [{ tool: "Read", count: 5 }],
    },
  };

  test("sanitizes positive_queries", () => {
    const result = sanitizeBundle(baseBundle, "conservative");
    expect(result.positive_queries[0].query).toBe("open [PATH]");
  });

  test("sanitizes eval_entries", () => {
    const result = sanitizeBundle(baseBundle, "conservative");
    expect(result.eval_entries[0].query).toBe("email [EMAIL]");
  });

  test("updates sanitization_level field", () => {
    const result = sanitizeBundle(baseBundle, "aggressive");
    expect(result.sanitization_level).toBe("aggressive");
  });

  test("does not mutate original bundle", () => {
    sanitizeBundle(baseBundle, "conservative");
    expect(baseBundle.positive_queries[0].query).toBe("open /Users/dan/file.ts");
  });
});
