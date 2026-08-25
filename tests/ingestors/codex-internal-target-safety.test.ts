import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseJsonlStream } from "@selftune/harness-codex/ingestors/codex-wrapper";
import { parseRolloutFile } from "@selftune/harness-codex/ingestors/codex-rollout";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function optimizerPrompt(target: string): string {
  return [
    "You are a skill description optimizer for an AI agent routing system.",
    `Skill Name: ${target}`,
  ].join("\n");
}

function trustedSessionMeta(): string {
  return JSON.stringify({
    type: "session_meta",
    payload: {
      id: "internal-target-safety",
      instructions: "### Available skills\n- effect-ts: Effect guidance.\n### How to use skills",
    },
  });
}

function userMessage(prompt: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    },
  });
}

function rolloutFile(name: string, ...lines: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "selftune-codex-wrapper-filter-"));
  temporaryDirectories.push(root);
  const directory = join(root, "sessions", "2026", "08", "24");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

describe("Codex internal prompt target authority", () => {
  test("does not attribute wrapper-only context as rollout skill use", () => {
    const path = rolloutFile(
      "rollout-wrapper-only-skill.jsonl",
      userMessage(
        '<codex_internal_context source="goal">Use $selftune to continue the internal audit.</codex_internal_context>',
      ),
    );

    const result = parseRolloutFile(path, new Set(["selftune"]));

    expect(result?.skills_triggered).not.toContain("selftune");
  });

  test("attributes real rollout skill use after a context wrapper", () => {
    const path = rolloutFile(
      "rollout-wrapper-plus-skill.jsonl",
      userMessage(
        "<in-app-browser-context>internal</in-app-browser-context>\n\nuse $selftune to audit my skills",
      ),
    );

    const result = parseRolloutFile(path, new Set(["selftune"]));

    expect(result?.query).toBe("use $selftune to audit my skills");
    expect(result?.skills_triggered).toContain("selftune");
  });

  test("learns inventory only from trusted session metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-codex-inventory-"));
    temporaryDirectories.push(root);
    const rolloutDirectory = join(root, "sessions", "2026", "07", "24");
    mkdirSync(rolloutDirectory, { recursive: true });
    const rolloutPath = join(rolloutDirectory, "rollout-trusted-inventory.jsonl");
    const quotedInventory = (name: string) =>
      [
        "### Available skills",
        `- ${name}: Quoted transcript content.`,
        "### How to use skills",
      ].join("\n");
    writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "trusted-session-inventory",
            instructions: [
              "### Available skills",
              "- trusted-skill: Declared by session metadata.",
              "### How to use skills",
            ].join("\n"),
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: quotedInventory("assistant-invented") }],
          },
        }),
        userMessage(`${quotedInventory("user-invented")}\nuse user-invented skill`),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments:
              '{"cmd":"cat .agents/skills/trusted-skill/SKILL.md .agents/skills/assistant-invented/SKILL.md .agents/skills/user-invented/SKILL.md"}',
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const result = parseRolloutFile(rolloutPath, new Set());

    expect(result?.skills_triggered).toEqual(["trusted-skill"]);
    expect(result?.skills_invoked).toEqual(["trusted-skill"]);
  });

  test("does not turn an unknown regex-like optimizer target into a rollout skill", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-codex-target-"));
    temporaryDirectories.push(root);
    const rolloutDirectory = join(root, "sessions", "2026", "07", "24");
    mkdirSync(rolloutDirectory, { recursive: true });
    const rolloutPath = join(rolloutDirectory, "rollout-target.jsonl");
    writeFileSync(
      rolloutPath,
      [trustedSessionMeta(), userMessage(optimizerPrompt("\\s*([^\\n]+)/i,"))].join("\n"),
      "utf8",
    );

    const result = parseRolloutFile(rolloutPath, new Set());

    expect(result?.skills_triggered).toEqual([]);
  });

  test("keeps the wrapper on trusted canonical skill identities", () => {
    const unknown = parseJsonlStream(
      [trustedSessionMeta(), userMessage(optimizerPrompt("\\s*([^\\n]+)/i,"))],
      new Set(),
    );
    const known = parseJsonlStream(
      [trustedSessionMeta(), userMessage(optimizerPrompt("EFFECT-TS"))],
      new Set(),
    );

    expect(unknown.skills_triggered).toEqual([]);
    expect(known.skills_triggered).toEqual(["effect-ts"]);
  });
});
