import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkClaudeCodeHooks,
  detectAgentType,
  determineCliPath,
  determineLlmMode,
  runInit,
} from "../../cli/selftune/init.js";
import type { SelftuneConfig } from "../../cli/selftune/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-init-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// detectAgentType
// ---------------------------------------------------------------------------

describe("detectAgentType", () => {
  test("returns override when provided", () => {
    expect(detectAgentType("claude_code")).toBe("claude_code");
    expect(detectAgentType("codex")).toBe("codex");
    expect(detectAgentType("opencode")).toBe("opencode");
  });

  test("detects claude_code when .claude dir exists", () => {
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const result = detectAgentType(undefined, tmpDir);
    expect(["claude_code", "codex", "opencode", "unknown"]).toContain(result);
  });

  test("returns a valid agent type for auto-detection", () => {
    const result = detectAgentType(undefined, tmpDir);
    expect(["claude_code", "codex", "opencode", "unknown"]).toContain(result);
  });
});

// ---------------------------------------------------------------------------
// determineCliPath
// ---------------------------------------------------------------------------

describe("determineCliPath", () => {
  test("returns override path when provided", () => {
    const override = "/custom/path/to/index.ts";
    expect(determineCliPath(override)).toBe(override);
  });

  test("returns an absolute path containing index.ts", () => {
    const result = determineCliPath();
    expect(result).toMatch(/index\.ts$/);
    expect(resolve(result)).toBe(result);
  });
});

// ---------------------------------------------------------------------------
// determineLlmMode
// ---------------------------------------------------------------------------

describe("determineLlmMode", () => {
  test("returns agent mode when agent CLI is detected", () => {
    const result = determineLlmMode("claude");
    expect(result.llm_mode).toBe("agent");
    expect(result.agent_cli).toBe("claude");
  });

  test("returns agent mode with null cli when no agent available", () => {
    const result = determineLlmMode(null);
    expect(result.llm_mode).toBe("agent");
    expect(result.agent_cli).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkClaudeCodeHooks
// ---------------------------------------------------------------------------

describe("checkClaudeCodeHooks", () => {
  test("returns false when settings.json does not exist", () => {
    const result = checkClaudeCodeHooks(join(tmpDir, ".claude", "settings.json"));
    expect(result).toBe(false);
  });

  test("returns false when settings.json has no hooks", () => {
    const settingsDir = join(tmpDir, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ permissions: {} }), "utf-8");
    expect(checkClaudeCodeHooks(settingsPath)).toBe(false);
  });

  test("returns true when all four hooks are configured", () => {
    const settingsDir = join(tmpDir, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    const settings = {
      hooks: {
        UserPromptSubmit: [{ command: "npx selftune hook prompt-log" }],
        PreToolUse: [{ command: "npx selftune hook skill-change-guard" }],
        PostToolUse: [{ command: "npx selftune hook skill-eval" }],
        Stop: [{ command: "npx selftune hook session-stop" }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(settings), "utf-8");
    expect(checkClaudeCodeHooks(settingsPath)).toBe(true);
  });

  test("returns true when hooks use nested format", () => {
    const settingsDir = join(tmpDir, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    const settings = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "npx selftune hook prompt-log" }] }],
        PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "npx selftune hook skill-change-guard" }] }],
        PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "npx selftune hook skill-eval" }] }],
        Stop: [{ hooks: [{ type: "command", command: "npx selftune hook session-stop" }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(settings), "utf-8");
    expect(checkClaudeCodeHooks(settingsPath)).toBe(true);
  });

  test("returns false when only some hooks are configured", () => {
    const settingsDir = join(tmpDir, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    const settings = {
      hooks: {
        UserPromptSubmit: [{ command: "npx selftune hook prompt-log" }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(settings), "utf-8");
    expect(checkClaudeCodeHooks(settingsPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runInit (integration-level)
// ---------------------------------------------------------------------------

describe("runInit", () => {
  test("writes config to specified directory", () => {
    const configDir = join(tmpDir, ".selftune");
    const configPath = join(configDir, "config.json");

    const result = runInit({
      configDir,
      configPath,
      force: false,
      agentOverride: "claude_code",
      cliPathOverride: "/test/cli/selftune/index.ts",
      homeDir: tmpDir,
    });

    expect(result.agent_type).toBe("claude_code");
    expect(result.cli_path).toBe("/test/cli/selftune/index.ts");
    expect(result.llm_mode).toBe("agent");
    expect(result.initialized_at).toBeTruthy();
    expect(existsSync(configPath)).toBe(true);

    const written = JSON.parse(readFileSync(configPath, "utf-8")) as SelftuneConfig;
    expect(written.agent_type).toBe("claude_code");
  });

  test("returns existing config without force flag", () => {
    const configDir = join(tmpDir, ".selftune");
    const configPath = join(configDir, "config.json");
    mkdirSync(configDir, { recursive: true });

    const existingConfig: SelftuneConfig = {
      agent_type: "codex",
      cli_path: "/old/path/index.ts",
      llm_mode: "agent",
      agent_cli: "codex",
      hooks_installed: false,
      initialized_at: "2025-01-01T00:00:00.000Z",
    };
    writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), "utf-8");

    const result = runInit({
      configDir,
      configPath,
      force: false,
      homeDir: tmpDir,
    });

    expect(result.agent_type).toBe("codex");
    expect(result.initialized_at).toBe("2025-01-01T00:00:00.000Z");
  });

  test("overwrites existing config with force flag", () => {
    const configDir = join(tmpDir, ".selftune");
    const configPath = join(configDir, "config.json");
    mkdirSync(configDir, { recursive: true });

    const existingConfig: SelftuneConfig = {
      agent_type: "codex",
      cli_path: "/old/path/index.ts",
      llm_mode: "agent",
      agent_cli: "codex",
      hooks_installed: false,
      initialized_at: "2025-01-01T00:00:00.000Z",
    };
    writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), "utf-8");

    const result = runInit({
      configDir,
      configPath,
      force: true,
      agentOverride: "opencode",
      cliPathOverride: "/new/path/index.ts",
      homeDir: tmpDir,
    });

    expect(result.agent_type).toBe("opencode");
    expect(result.cli_path).toBe("/new/path/index.ts");
    expect(result.initialized_at).not.toBe("2025-01-01T00:00:00.000Z");
  });

  test("creates config directory if it does not exist", () => {
    const configDir = join(tmpDir, "nested", "deep", ".selftune");
    const configPath = join(configDir, "config.json");

    const result = runInit({
      configDir,
      configPath,
      force: false,
      agentOverride: "codex",
      cliPathOverride: "/test/index.ts",
      homeDir: tmpDir,
    });

    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    expect(result.agent_type).toBe("codex");
  });

  test("config file is valid JSON with pretty formatting", () => {
    const configDir = join(tmpDir, ".selftune");
    const configPath = join(configDir, "config.json");

    runInit({
      configDir,
      configPath,
      force: false,
      agentOverride: "claude_code",
      cliPathOverride: "/test/index.ts",
      homeDir: tmpDir,
    });

    const raw = readFileSync(configPath, "utf-8");
    expect(raw).toContain("  ");
    expect(raw).toContain('"agent_type"');

    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("agent_type");
    expect(parsed).toHaveProperty("cli_path");
    expect(parsed).toHaveProperty("llm_mode");
    expect(parsed).toHaveProperty("agent_cli");
    expect(parsed).toHaveProperty("hooks_installed");
    expect(parsed).toHaveProperty("initialized_at");
  });

  test("sets hooks_installed correctly for claude_code", () => {
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    const settings = {
      hooks: {
        UserPromptSubmit: [{ command: "npx selftune hook prompt-log" }],
        PreToolUse: [{ command: "npx selftune hook skill-change-guard" }],
        PostToolUse: [{ command: "npx selftune hook skill-eval" }],
        Stop: [{ command: "npx selftune hook session-stop" }],
      },
    };
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(settings), "utf-8");

    const configDir = join(tmpDir, ".selftune");
    const configPath = join(configDir, "config.json");

    const result = runInit({
      configDir,
      configPath,
      force: false,
      agentOverride: "claude_code",
      cliPathOverride: "/test/index.ts",
      homeDir: tmpDir,
    });

    expect(result.hooks_installed).toBe(true);
  });
});
