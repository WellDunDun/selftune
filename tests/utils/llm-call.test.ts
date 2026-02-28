/**
 * Tests for cli/selftune/utils/llm-call.ts
 *
 * Covers: detectAgent, stripMarkdownFences, callViaAgent, callViaApi, callLlm
 *
 * TDD: RED phase — these tests are written before the implementation.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  callLlm,
  callViaAgent,
  callViaApi,
  detectAgent,
  stripMarkdownFences,
} from "../../cli/selftune/utils/llm-call.js";

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
    // @ts-expect-error -- restoring global mock
    Bun.which = originalWhich;
  });

  it("returns null when no agent is available in PATH", () => {
    // @ts-expect-error -- mocking global
    Bun.which = () => null;
    expect(detectAgent()).toBeNull();
  });

  it("returns first available agent (claude first if present)", () => {
    // @ts-expect-error -- mocking global
    Bun.which = (name: string) => (name === "claude" ? "/usr/bin/claude" : null);
    expect(detectAgent()).toBe("claude");
  });

  it("returns codex when claude is not available but codex is", () => {
    // @ts-expect-error -- mocking global
    Bun.which = (name: string) => (name === "codex" ? "/usr/bin/codex" : null);
    expect(detectAgent()).toBe("codex");
  });

  it("returns opencode when only opencode is available", () => {
    // @ts-expect-error -- mocking global
    Bun.which = (name: string) => (name === "opencode" ? "/usr/bin/opencode" : null);
    expect(detectAgent()).toBe("opencode");
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
    // @ts-expect-error -- restoring global mock
    Bun.spawn = originalSpawn;
  });

  it("constructs correct command for claude agent and returns stdout", async () => {
    let capturedCmd: string[] | undefined;
    const expectedOutput = '{"expectations": []}';

    // @ts-expect-error -- mocking global
    Bun.spawn = (cmd: string[], _opts: unknown) => {
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
    };

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
    expect(capturedCmd?.[1]).toBe("-p");
  });

  it("throws on unknown agent type", async () => {
    expect(callViaAgent("sys", "user", "unknown-agent")).rejects.toThrow("Unknown agent");
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

    expect(callViaAgent("sys", "user", "claude")).rejects.toThrow(/exited with code 1/);
  });
});

// ---------------------------------------------------------------------------
// callViaApi
// ---------------------------------------------------------------------------

describe("callViaApi", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) {
      process.env.ANTHROPIC_API_KEY = undefined;
    } else {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    }
  });

  it("throws when ANTHROPIC_API_KEY is not set", async () => {
    process.env.ANTHROPIC_API_KEY = undefined;
    expect(callViaApi("system", "user")).rejects.toThrow("ANTHROPIC_API_KEY");
  });

  it("returns raw text from API response content blocks", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key-123";

    // @ts-expect-error -- mocking global fetch
    globalThis.fetch = async (_url: string, _opts: unknown) => {
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: '{"expectations": []}' }],
        }),
      };
    };

    const result = await callViaApi("system prompt", "user prompt");
    expect(result).toBe('{"expectations": []}');
  });

  it("throws on non-ok API response", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key-123";

    // @ts-expect-error -- mocking global fetch
    globalThis.fetch = async (_url: string, _opts: unknown) => {
      return {
        ok: false,
        status: 429,
        text: async () => "rate limited",
      };
    };

    expect(callViaApi("system", "user")).rejects.toThrow("API error 429");
  });
});

// ---------------------------------------------------------------------------
// callLlm — dispatcher
// ---------------------------------------------------------------------------

describe("callLlm", () => {
  let originalSpawn: typeof Bun.spawn;
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    originalFetch = globalThis.fetch;
    originalEnv = process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    // @ts-expect-error -- restoring global mock
    Bun.spawn = originalSpawn;
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) {
      process.env.ANTHROPIC_API_KEY = undefined;
    } else {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    }
  });

  it("dispatches to callViaAgent when mode is 'agent'", async () => {
    let spawnCalled = false;

    // @ts-expect-error -- mocking global
    Bun.spawn = (cmd: string[], _opts: unknown) => {
      spawnCalled = true;
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("agent-result"));
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

    const result = await callLlm("sys", "user", "agent", "claude");
    expect(spawnCalled).toBe(true);
    expect(result).toBe("agent-result");
  });

  it("dispatches to callViaApi when mode is 'api'", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    let fetchCalled = false;

    // @ts-expect-error -- mocking global fetch
    globalThis.fetch = async (_url: string, _opts: unknown) => {
      fetchCalled = true;
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "api-result" }],
        }),
      };
    };

    const result = await callLlm("sys", "user", "api");
    expect(fetchCalled).toBe(true);
    expect(result).toBe("api-result");
  });
});
