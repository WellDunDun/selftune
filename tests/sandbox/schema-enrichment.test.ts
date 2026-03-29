/**
 * Schema Enrichment Tests — Win 2 (File Change Metrics) + Win 3 (Token Granularity + Cost)
 *
 * Validates that parseTranscript() correctly extracts:
 *   - files_changed, lines_added, lines_removed, lines_modified from Edit/Write tool calls
 *   - cached_input_tokens, reasoning_output_tokens from usage objects
 *   - cost_usd calculation from model + token counts
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseTranscript } from "../../cli/selftune/utils/transcript.js";
import { calculateCost } from "../../cli/selftune/utils/transcript.js";

// ---------------------------------------------------------------------------
// Helpers — build JSONL transcript content from message objects
// ---------------------------------------------------------------------------

function makeTmpTranscript(lines: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "schema-enrichment-"));
  const path = join(dir, "test-session.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

function userMessage(text: string): Record<string, unknown> {
  return {
    type: "user",
    timestamp: "2026-03-29T10:00:00Z",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  };
}

function assistantWithToolCalls(
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>,
  usage?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: "2026-03-29T10:01:00Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-20250514",
      content: toolCalls.map((tc) => ({
        type: "tool_use",
        name: tc.name,
        input: tc.input,
      })),
    },
    usage: usage ?? { input_tokens: 100, output_tokens: 50 },
  };
}

function assistantTextOnly(
  text: string,
  usage?: Record<string, unknown>,
  model?: string,
): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: "2026-03-29T10:01:00Z",
    message: {
      role: "assistant",
      model: model ?? "claude-sonnet-4-20250514",
      content: [{ type: "text", text }],
    },
    usage: usage ?? { input_tokens: 100, output_tokens: 50 },
  };
}

// ===========================================================================
// Win 2: File Change Metrics
// ===========================================================================

describe("Win 2: File Change Metrics", () => {
  it("extracts lines_added from Write tool calls", () => {
    const path = makeTmpTranscript([
      userMessage("create a file please"),
      assistantWithToolCalls([
        {
          name: "Write",
          input: {
            file_path: "/tmp/new-file.ts",
            content: "line1\nline2\nline3\n",
          },
        },
      ]),
    ]);

    const metrics = parseTranscript(path);
    expect(metrics.files_changed).toBe(1);
    expect(metrics.lines_added).toBe(4); // "line1\nline2\nline3\n".split("\n").length = 4
    expect(metrics.lines_removed).toBe(0);
    expect(metrics.lines_modified).toBe(0);
  });

  it("extracts lines from Edit tool calls with old_string/new_string", () => {
    const path = makeTmpTranscript([
      userMessage("edit the file please"),
      assistantWithToolCalls([
        {
          name: "Edit",
          input: {
            file_path: "/tmp/existing.ts",
            old_string: "const a = 1;\nconst b = 2;",
            new_string: "const a = 10;\nconst b = 20;\nconst c = 30;",
          },
        },
      ]),
    ]);

    const metrics = parseTranscript(path);
    expect(metrics.files_changed).toBe(1);
    // old: 2 lines, new: 3 lines
    // modified = min(2, 3) = 2
    // lines_added = max(0, 3-2) = 1
    // lines_removed = max(0, 2-3) = 0
    expect(metrics.lines_modified).toBe(2);
    expect(metrics.lines_added).toBe(1);
    expect(metrics.lines_removed).toBe(0);
  });

  it("counts lines_removed when old_string is longer than new_string", () => {
    const path = makeTmpTranscript([
      userMessage("remove some lines please"),
      assistantWithToolCalls([
        {
          name: "Edit",
          input: {
            file_path: "/tmp/existing.ts",
            old_string: "line1\nline2\nline3\nline4",
            new_string: "line1",
          },
        },
      ]),
    ]);

    const metrics = parseTranscript(path);
    expect(metrics.files_changed).toBe(1);
    // old: 4 lines, new: 1 line
    // modified = min(4, 1) = 1
    // lines_removed = max(0, 4-1) = 3
    // lines_added = max(0, 1-4) = 0
    expect(metrics.lines_modified).toBe(1);
    expect(metrics.lines_removed).toBe(3);
    expect(metrics.lines_added).toBe(0);
  });

  it("deduplicates files_changed across Write and Edit to same file", () => {
    const path = makeTmpTranscript([
      userMessage("work on the file"),
      assistantWithToolCalls([
        {
          name: "Write",
          input: {
            file_path: "/tmp/shared.ts",
            content: "initial\n",
          },
        },
      ]),
      assistantWithToolCalls([
        {
          name: "Edit",
          input: {
            file_path: "/tmp/shared.ts",
            old_string: "initial",
            new_string: "updated",
          },
        },
      ]),
    ]);

    const metrics = parseTranscript(path);
    expect(metrics.files_changed).toBe(1);
  });

  it("counts multiple distinct files", () => {
    const path = makeTmpTranscript([
      userMessage("update both files"),
      assistantWithToolCalls([
        {
          name: "Write",
          input: {
            file_path: "/tmp/file-a.ts",
            content: "a\n",
          },
        },
        {
          name: "Edit",
          input: {
            file_path: "/tmp/file-b.ts",
            old_string: "old",
            new_string: "new",
          },
        },
      ]),
    ]);

    const metrics = parseTranscript(path);
    expect(metrics.files_changed).toBe(2);
  });

  it("returns zero file metrics when no Write/Edit tools used", () => {
    const path = makeTmpTranscript([
      userMessage("just read something"),
      assistantWithToolCalls([
        {
          name: "Read",
          input: { file_path: "/tmp/some-file.ts" },
        },
      ]),
    ]);

    const metrics = parseTranscript(path);
    expect(metrics.files_changed).toBe(0);
    expect(metrics.lines_added).toBe(0);
    expect(metrics.lines_removed).toBe(0);
    expect(metrics.lines_modified).toBe(0);
  });
});

// ===========================================================================
// Win 3: Token Granularity
// ===========================================================================

describe("Win 3: Token Granularity", () => {
  it("extracts cached_input_tokens from cache_read_input_tokens", () => {
    const path = makeTmpTranscript([
      userMessage("do something"),
      assistantTextOnly("done", {
        input_tokens: 500,
        output_tokens: 100,
        cache_read_input_tokens: 300,
      }),
    ]);

    const metrics = parseTranscript(path);
    expect(metrics.cached_input_tokens).toBe(300);
  });

  it("sums cache_creation and cache_read into cached_input_tokens", () => {
    const path = makeTmpTranscript([
      userMessage("something"),
      assistantTextOnly("response 1", {
        input_tokens: 500,
        output_tokens: 100,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
      }),
      assistantTextOnly("response 2", {
        input_tokens: 300,
        output_tokens: 80,
        cache_read_input_tokens: 150,
      }),
    ]);

    const metrics = parseTranscript(path);
    // 200 + 100 + 150 = 450
    expect(metrics.cached_input_tokens).toBe(450);
  });

  it("extracts reasoning_output_tokens", () => {
    const path = makeTmpTranscript([
      userMessage("think hard"),
      assistantTextOnly("thought about it", {
        input_tokens: 500,
        output_tokens: 200,
        reasoning_output_tokens: 150,
      }),
    ]);

    const metrics = parseTranscript(path);
    expect(metrics.reasoning_output_tokens).toBe(150);
  });

  it("returns undefined for cached/reasoning tokens when not present", () => {
    const path = makeTmpTranscript([
      userMessage("basic question"),
      assistantTextOnly("basic answer", {
        input_tokens: 100,
        output_tokens: 50,
      }),
    ]);

    const metrics = parseTranscript(path);
    expect(metrics.cached_input_tokens).toBeUndefined();
    expect(metrics.reasoning_output_tokens).toBeUndefined();
  });
});

// ===========================================================================
// Win 3: Cost Calculation
// ===========================================================================

describe("Win 3: Cost Calculation", () => {
  it("calculates cost for claude-sonnet-4-20250514", () => {
    // sonnet-4: $3/M input, $15/M output
    const cost = calculateCost("claude-sonnet-4-20250514", 1_000_000, 100_000);
    expect(cost).toBeDefined();
    // 1M * 3/1M + 100K * 15/1M = 3.0 + 1.5 = 4.5
    expect(cost!).toBeCloseTo(4.5, 2);
  });

  it("calculates cost for claude-opus-4-20250514", () => {
    // opus-4: $15/M input, $75/M output
    const cost = calculateCost("claude-opus-4-20250514", 1_000_000, 100_000);
    expect(cost).toBeDefined();
    // 1M * 15/1M + 100K * 75/1M = 15.0 + 7.5 = 22.5
    expect(cost!).toBeCloseTo(22.5, 2);
  });

  it("returns undefined for unknown model", () => {
    const cost = calculateCost("gpt-4o-2025-01-01", 1_000_000, 100_000);
    expect(cost).toBeUndefined();
  });

  it("returns undefined when model is undefined", () => {
    const cost = calculateCost(undefined, 1_000_000, 100_000);
    expect(cost).toBeUndefined();
  });

  it("integrates cost_usd into parseTranscript output", () => {
    const path = makeTmpTranscript([
      userMessage("please help"),
      assistantTextOnly(
        "here you go",
        {
          input_tokens: 1_000_000,
          output_tokens: 100_000,
        },
        "claude-sonnet-4-20250514",
      ),
    ]);

    const metrics = parseTranscript(path);
    expect(metrics.cost_usd).toBeDefined();
    expect(metrics.cost_usd!).toBeCloseTo(4.5, 1);
  });
});
