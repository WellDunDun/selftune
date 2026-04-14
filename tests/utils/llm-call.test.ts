/**
 * Tests for cli/selftune/utils/llm-call.ts
 *
 * Covers: detectAgent, stripMarkdownFences, callViaAgent
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { RetryOptions } from "../../cli/selftune/utils/llm-call.js";
import {
  callViaAgent,
  callViaSubagent,
  detectAgent,
  detectLlmAgent,
  describeLlmInvocation,
  stripMarkdownFences,
} from "../../cli/selftune/utils/llm-call.js";

/** Disable retries for tests that don't need them. */
const NO_RETRY: RetryOptions = { maxRetries: 0 };

// ---------------------------------------------------------------------------
// stripMarkdownFences
// ---------------------------------------------------------------------------

describe("stripMarkdownFences", () => {
  it("handles JSON inside ```json fences", () => {
    const input = '```json\n{"score": 42, "passed": true}\n```';
    const result = stripMarkdownFences(input);
    expect(result).toBe('{"score": 42, "passed": true}');
  });

  it("handles nested fences (quad-backtick wrapping triple-backtick)", () => {
    const input = '````json\n```json\n{"nested": true}\n```\n````';
    const result = stripMarkdownFences(input);
    expect(JSON.parse(result)).toEqual({ nested: true });
  });

  it("handles incomplete/unclosed fences", () => {
    const input = '```json\n{"passed": true}';
    const result = stripMarkdownFences(input);
    expect(JSON.parse(result)).toEqual({ passed: true });
  });

  it("handles no fences (plain JSON)", () => {
    const input = '{"passed": true}';
    const result = stripMarkdownFences(input);
    expect(result).toBe('{"passed": true}');
  });

  it("handles preamble text before JSON", () => {
    const input = 'Here is the grading result:\n{"passed": true, "score": 0.95}';
    const result = stripMarkdownFences(input);
    expect(result).toBe('{"passed": true, "score": 0.95}');
  });

  it("handles empty input", () => {
    expect(stripMarkdownFences("")).toBe("");
  });

  it("handles whitespace-only input", () => {
    expect(stripMarkdownFences("   \n  \n  ")).toBe("");
  });

  it("handles multiple fence blocks (takes first)", () => {
    const input = '```json\n{"first": true}\n```\n\n```json\n{"second": true}\n```';
    const result = stripMarkdownFences(input);
    expect(JSON.parse(result)).toEqual({ first: true });
  });
});

// ---------------------------------------------------------------------------
// detectAgent
// ---------------------------------------------------------------------------

describe("detectAgent", () => {
  let originalWhich: typeof Bun.which;

  beforeEach(() => {
    originalWhich = Bun.which;
  });

  afterEach(() => {
    Bun.which = originalWhich;
  });

  it("returns null when no agent is available in PATH", () => {
    Bun.which = (() => null) as typeof Bun.which;
    expect(detectAgent()).toBeNull();
  });

  it("returns first available agent (claude first if present)", () => {
    Bun.which = ((name: string) =>
      name === "claude" ? "/usr/bin/claude" : null) as typeof Bun.which;
    expect(detectAgent()).toBe("claude");
  });

  it("returns codex when claude is not available but codex is", () => {
    Bun.which = ((name: string) =>
      name === "codex" ? "/usr/bin/codex" : null) as typeof Bun.which;
    expect(detectAgent()).toBe("codex");
  });

  it("returns opencode when only opencode is available", () => {
    Bun.which = ((name: string) =>
      name === "opencode" ? "/usr/bin/opencode" : null) as typeof Bun.which;
    expect(detectAgent()).toBe("opencode");
  });
});

describe("detectLlmAgent", () => {
  let originalWhich: typeof Bun.which;

  beforeEach(() => {
    originalWhich = Bun.which;
  });

  afterEach(() => {
    Bun.which = originalWhich;
  });

  it("returns pi when only pi is available", () => {
    Bun.which = ((name: string) => (name === "pi" ? "/usr/bin/pi" : null)) as typeof Bun.which;
    expect(detectLlmAgent()).toBe("pi");
  });

  it("skips openclaw and falls through to pi for llm-backed work", () => {
    Bun.which = ((name: string) =>
      name === "openclaw"
        ? "/usr/bin/openclaw"
        : name === "pi"
          ? "/usr/bin/pi"
          : null) as typeof Bun.which;
    expect(detectLlmAgent()).toBe("pi");
  });
});

// ---------------------------------------------------------------------------
// callViaAgent — subprocess construction
// ---------------------------------------------------------------------------

describe("callViaAgent", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  it("constructs correct command for claude agent and returns stdout", async () => {
    let capturedCmd: string[] | undefined;
    const expectedOutput = '{"expectations": []}';

    Bun.spawn = ((cmd: string[], _opts: unknown) => {
      capturedCmd = cmd;
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(expectedOutput));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }) as typeof Bun.spawn;

    const result = await callViaAgent("System prompt", "User prompt", "claude");

    expect(capturedCmd).toBeDefined();
    expect(capturedCmd?.[0]).toBe("claude");
    expect(capturedCmd?.[1]).toBe("-p");
    // The third argument should contain both system and user prompts
    expect(capturedCmd?.[2]).toContain("System prompt");
    expect(capturedCmd?.[2]).toContain("User prompt");
    expect(result).toBe(expectedOutput);
  });

  it("constructs correct command for codex agent", async () => {
    let capturedCmd: string[] | undefined;

    // @ts-expect-error -- mocking global
    Bun.spawn = (cmd: string[], _opts: unknown) => {
      capturedCmd = cmd;
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ok"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };

    await callViaAgent("sys", "user", "codex");

    expect(capturedCmd).toBeDefined();
    expect(capturedCmd?.[0]).toBe("codex");
    expect(capturedCmd?.[1]).toBe("exec");
    expect(capturedCmd?.[2]).toBe("--skip-git-repo-check");
  });

  it("constructs correct command for opencode agent", async () => {
    let capturedCmd: string[] | undefined;

    // @ts-expect-error -- mocking global
    Bun.spawn = (cmd: string[], _opts: unknown) => {
      capturedCmd = cmd;
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ok"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };

    await callViaAgent("sys", "user", "opencode");

    expect(capturedCmd).toBeDefined();
    expect(capturedCmd?.[0]).toBe("opencode");
    expect(capturedCmd?.[1]).toBe("run");
  });

  it("constructs correct command for pi agent", async () => {
    let capturedCmd: string[] | undefined;

    // @ts-expect-error -- mocking global
    Bun.spawn = (cmd: string[], _opts: unknown) => {
      capturedCmd = cmd;
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ok"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };

    await callViaAgent("sys", "user", "pi", "sonnet", NO_RETRY, "high");

    expect(capturedCmd).toBeDefined();
    expect(capturedCmd?.[0]).toBe("pi");
    expect(capturedCmd).toContain("-p");
    expect(capturedCmd).toContain("--no-session");
    expect(capturedCmd).toContain("--no-tools");
    expect(capturedCmd).toContain("--system-prompt");
    expect(capturedCmd).toContain("sys");
    expect(capturedCmd).toContain("--model");
    expect(capturedCmd).toContain("sonnet");
    expect(capturedCmd).toContain("--thinking");
    expect(capturedCmd).toContain("high");
  });

  it("appends --model flag for claude agent when modelFlag is set", async () => {
    let capturedCmd: string[] | undefined;

    // @ts-expect-error -- mocking global
    Bun.spawn = (cmd: string[], _opts: unknown) => {
      capturedCmd = cmd;
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ok"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };

    await callViaAgent("sys", "user", "claude", "claude-sonnet-4-6");

    expect(capturedCmd).toBeDefined();
    expect(capturedCmd).toContain("--model");
    expect(capturedCmd).toContain("claude-sonnet-4-6");
  });

  it("resolves 'haiku' alias to full model ID for claude agent", async () => {
    let capturedCmd: string[] | undefined;

    // @ts-expect-error -- mocking global
    Bun.spawn = (cmd: string[], _opts: unknown) => {
      capturedCmd = cmd;
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ok"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };

    await callViaAgent("sys", "user", "claude", "haiku");

    expect(capturedCmd).toBeDefined();
    expect(capturedCmd).toContain("--model");
    expect(capturedCmd).toContain("claude-haiku-4-5-20251001");
    expect(capturedCmd).not.toContain("haiku");
  });

  it("does not append --model flag when modelFlag is not set", async () => {
    let capturedCmd: string[] | undefined;

    // @ts-expect-error -- mocking global
    Bun.spawn = (cmd: string[], _opts: unknown) => {
      capturedCmd = cmd;
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ok"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };

    await callViaAgent("sys", "user", "claude");

    expect(capturedCmd).toBeDefined();
    expect(capturedCmd).not.toContain("--model");
  });

  it("throws on unknown agent type", async () => {
    expect(callViaAgent("sys", "user", "unknown-agent")).rejects.toThrow(
      "selftune llm calls currently support only",
    );
  });

  it("throws a capability-specific error for openclaw", async () => {
    expect(callViaAgent("sys", "user", "openclaw")).rejects.toThrow(
      "LLM-backed judge, eval, and optimizer workflows are unavailable on openclaw",
    );
  });

  it("throws when agent process exits with non-zero code", async () => {
    // @ts-expect-error -- mocking global
    Bun.spawn = (_cmd: string[], _opts: unknown) => {
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("some error"));
            controller.close();
          },
        }),
        exited: Promise.resolve(1),
        kill: () => {},
      };
    };

    expect(callViaAgent("sys", "user", "claude", undefined, NO_RETRY)).rejects.toThrow(
      /exited with code 1/,
    );
  });

  it("reports provider-normalized invocation identity for supported agents", () => {
    expect(describeLlmInvocation("claude", "haiku")).toEqual({
      platform: "claude_code",
      model: "claude-haiku-4-5-20251001",
    });
    expect(describeLlmInvocation("opencode", "sonnet")).toEqual({
      platform: "opencode",
      model: "anthropic/claude-sonnet-4-20250514",
    });
    expect(describeLlmInvocation("codex", "gpt-5")).toEqual({
      platform: "codex",
      model: "gpt-5",
    });
    expect(describeLlmInvocation("pi", "pi-max")).toEqual({
      platform: "pi",
      model: "pi-max",
    });
  });

  it("calls the observer with normalized identity and duration", async () => {
    const events: Array<{
      phase: "start" | "finish";
      platform: string;
      model: string | null;
      durationMs: number | null;
      success: boolean | null;
    }> = [];

    Bun.spawn = ((_cmd: string[], _opts: unknown) => {
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ok"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }) as typeof Bun.spawn;

    await callViaAgent("sys", "user", "claude", "haiku", NO_RETRY, undefined, {
      onStart(event) {
        events.push({
          phase: "start",
          platform: event.platform,
          model: event.model,
          durationMs: event.durationMs,
          success: event.success,
        });
      },
      onFinish(event) {
        events.push({
          phase: "finish",
          platform: event.platform,
          model: event.model,
          durationMs: event.durationMs,
          success: event.success,
        });
      },
    });

    expect(events[0]).toEqual({
      phase: "start",
      platform: "claude_code",
      model: "claude-haiku-4-5-20251001",
      durationMs: null,
      success: null,
    });
    expect(events[1]?.phase).toBe("finish");
    expect(events[1]?.platform).toBe("claude_code");
    expect(events[1]?.model).toBe("claude-haiku-4-5-20251001");
    expect(events[1]?.success).toBe(true);
    expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// callViaSubagent
// ---------------------------------------------------------------------------

describe("callViaSubagent", () => {
  let originalWhich: typeof Bun.which;
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalWhich = Bun.which;
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    Bun.which = originalWhich;
    Bun.spawn = originalSpawn;
  });

  it("constructs a pi subagent call when only pi is available", async () => {
    let capturedCmd: string[] | undefined;

    Bun.which = ((name: string) => (name === "pi" ? "/usr/bin/pi" : null)) as typeof Bun.which;
    Bun.spawn = ((cmd: string[], _opts: unknown) => {
      capturedCmd = cmd;
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ok"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }) as typeof Bun.spawn;

    const result = await callViaSubagent({
      agentName: "evolution-reviewer",
      prompt: "test",
      allowedTools: ["Read", "Grep", "Glob", "Bash"],
      effort: "max",
      appendSystemPrompt: "extra rules",
    });

    expect(result).toBe("ok");
    expect(capturedCmd).toBeDefined();
    expect(capturedCmd?.[0]).toBe("pi");
    expect(capturedCmd).toContain("-p");
    expect(capturedCmd).toContain("--system-prompt");
    expect(capturedCmd).toContain("--tools");
    expect(capturedCmd).toContain("read,grep,find,bash");
    expect(capturedCmd).toContain("--thinking");
    expect(capturedCmd).toContain("xhigh");
  });
});
