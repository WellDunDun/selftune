#!/usr/bin/env bun
/**
 * Fail-open PreToolUse/PostToolUse capture for direct SKILL.md edits.
 *
 * The durable JSONL artifact contains package revision hashes and a target-path
 * digest only: it deliberately never stores skill contents or filesystem paths.
 * It is evidence for later review, not a causal claim or an auto-apply trigger.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { getSkillEditCaptureLogPath, SESSION_STATE_DIR } from "@selftune/runtime/constants";
import type { PostToolUsePayload, PreToolUsePayload } from "@selftune/runtime/types";
import { computeSkillVersionHash } from "@selftune/runtime/utils/skill-discovery";

import { isSkillMdWrite } from "@selftune/harness-core/skill-paths";
import { loadSessionState, saveSessionState } from "@selftune/harness-core/session-state";

import {
  SILENT_HOOK_SUCCESS,
  type HookExecutionResult,
  writeHookExecutionResult,
} from "./execution-result.js";

type PendingEdit = {
  readonly target_digest: string;
  readonly pre_revision: string | null;
  readonly pre_captured_at: string;
};

type CaptureState = { readonly pending: Record<string, PendingEdit> };

export type SkillEditCaptureArtifact = {
  readonly schema_version: "1";
  readonly event_type: "skill_md_edit_capture";
  readonly session_id: string;
  readonly tool_key: string;
  readonly target_digest: string;
  readonly pre_revision: string | null;
  readonly post_revision: string | null;
  readonly status: "captured" | "missing_pre_revision" | "failed" | "unchanged";
  readonly pre_captured_at: string;
  readonly post_captured_at: string;
};

export interface SkillEditCaptureOptions {
  readonly stateDir?: string;
  readonly artifactPath?: string;
  readonly hashSkill?: (path: string) => string | null | undefined;
  readonly now?: () => string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function filePath(input: Record<string, unknown>): string | null {
  return typeof input.file_path === "string" && input.file_path.length > 0 ? input.file_path : null;
}

function toolKey(payload: {
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}): string {
  if (typeof payload.tool_use_id === "string" && payload.tool_use_id.length > 0)
    return payload.tool_use_id;
  return digest(
    JSON.stringify({
      tool: payload.tool_name ?? "",
      target: filePath(payload.tool_input ?? {}) ?? "",
    }),
  );
}

function wasSuccessful(response: Record<string, unknown> | undefined): boolean {
  if (!response) return true;
  return response.success !== false && response.is_error !== true && response.error === undefined;
}

function appendArtifact(path: string, artifact: SkillEditCaptureArtifact): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(artifact)}\n`, "utf8");
}

function captureStateDir(): string {
  return process.env.SELFTUNE_CONFIG_DIR ?? SESSION_STATE_DIR;
}

/** Store only a hash and bounded correlation metadata before an edit happens. */
export function captureSkillEditPre(
  payload: PreToolUsePayload,
  options: SkillEditCaptureOptions = {},
): boolean {
  const path = filePath(payload.tool_input ?? {});
  if (!path || !isSkillMdWrite(payload.tool_name ?? "", path)) return false;
  const sessionId = payload.session_id ?? "unknown";
  const stateDir = options.stateDir ?? captureStateDir();
  const key = toolKey(payload);
  const state = loadSessionState<CaptureState>(stateDir, "skill-edit-capture", sessionId, () => ({
    pending: {},
  }));
  const hashSkill = options.hashSkill ?? computeSkillVersionHash;
  state.data.pending[key] = {
    target_digest: digest(resolve(path)),
    pre_revision: hashSkill(path) ?? null,
    pre_captured_at: (options.now ?? (() => new Date().toISOString()))(),
  };
  saveSessionState(stateDir, "skill-edit-capture", state);
  return true;
}

/** Persist an honest hash-only outcome after a write/edit tool result. */
export function captureSkillEditPost(
  payload: PostToolUsePayload,
  options: SkillEditCaptureOptions = {},
): SkillEditCaptureArtifact | null {
  const path = filePath(payload.tool_input ?? {});
  if (!path || !isSkillMdWrite(payload.tool_name ?? "", path)) return null;
  const sessionId = payload.session_id ?? "unknown";
  const stateDir = options.stateDir ?? captureStateDir();
  const key = toolKey(payload);
  const state = loadSessionState<CaptureState>(stateDir, "skill-edit-capture", sessionId, () => ({
    pending: {},
  }));
  const pending = state.data.pending[key];
  if (!pending) return null;
  delete state.data.pending[key];
  saveSessionState(stateDir, "skill-edit-capture", state);

  const sameTarget = pending.target_digest === digest(resolve(path));
  const hashSkill = options.hashSkill ?? computeSkillVersionHash;
  const postRevision =
    wasSuccessful(payload.tool_response) && sameTarget ? (hashSkill(path) ?? null) : null;
  const status: SkillEditCaptureArtifact["status"] = !wasSuccessful(payload.tool_response)
    ? "failed"
    : !sameTarget
      ? "failed"
      : pending.pre_revision === null
        ? "missing_pre_revision"
        : postRevision === pending.pre_revision
          ? "unchanged"
          : postRevision === null
            ? "failed"
            : "captured";
  const artifact: SkillEditCaptureArtifact = {
    schema_version: "1",
    event_type: "skill_md_edit_capture",
    session_id: sessionId,
    tool_key: key.slice(0, 256),
    target_digest: pending.target_digest,
    pre_revision: pending.pre_revision,
    post_revision: postRevision,
    status,
    pre_captured_at: pending.pre_captured_at,
    post_captured_at: (options.now ?? (() => new Date().toISOString()))(),
  };
  appendArtifact(options.artifactPath ?? getSkillEditCaptureLogPath(), artifact);
  return artifact;
}

export async function runSkillEditCaptureHook(rawStdin: string): Promise<HookExecutionResult> {
  try {
    if (!rawStdin.includes("SKILL.md") && !rawStdin.includes("skill.md"))
      return SILENT_HOOK_SUCCESS;
    const payload = JSON.parse(rawStdin) as PreToolUsePayload & PostToolUsePayload;
    if (payload.hook_event_name === "PreToolUse") captureSkillEditPre(payload);
    if (payload.hook_event_name === "PostToolUse") captureSkillEditPost(payload);
  } catch {
    // Hooks must never block agent writes.
  }
  return SILENT_HOOK_SUCCESS;
}

export async function cliMain(stdinText?: string): Promise<number> {
  return writeHookExecutionResult(
    await runSkillEditCaptureHook(stdinText ?? (await Bun.stdin.text())),
  );
}

if (import.meta.main) process.exitCode = await cliMain();
