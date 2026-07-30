import {
  buildCanonicalExecutionFact,
  buildCanonicalPrompt,
  buildCanonicalSession,
  buildCanonicalSkillInvocation,
  type CanonicalBaseInput,
  deriveInvocationMode,
  derivePromptId,
  deriveSkillInvocationId,
} from "@selftune/runtime/normalization";
import type { CanonicalRecord } from "@selftune/runtime/types";

import type { ParsedSession } from "./opencode-ingest.js";

/** Build canonical records from a parsed OpenCode session. */
export function buildCanonicalRecordsFromOpenCode(session: ParsedSession): CanonicalRecord[] {
  const records: CanonicalRecord[] = [];
  const baseInput: CanonicalBaseInput = {
    platform: "opencode",
    capture_mode: "batch_ingest",
    source_session_kind: "replayed",
    session_id: session.session_id,
    raw_source_ref: {
      path: session.transcript_path,
      event_type: session.source,
      metadata: session.is_metadata_only ? { metadata_only: true } : undefined,
    },
  };

  records.push(
    buildCanonicalSession({
      ...baseInput,
      started_at: session.timestamp,
      ...(session.source_ended_at ? { ended_at: session.source_ended_at } : {}),
      workspace_path: session.cwd || undefined,
      ...(session.model_provider ? { provider: session.model_provider } : {}),
      ...(session.model ? { model: session.model } : {}),
    }),
  );

  const promptEmitted = Boolean(
    session.query && session.query.length >= 4 && !session.is_metadata_only,
  );
  const promptId = promptEmitted ? derivePromptId(session.session_id, 0) : undefined;
  if (promptId) {
    records.push(
      buildCanonicalPrompt({
        ...baseInput,
        prompt_id: promptId,
        occurred_at: session.timestamp,
        prompt_text: session.query,
        prompt_index: 0,
      }),
    );
  }

  const skillDetections =
    session.skill_detections ??
    session.skills_triggered.map((skillName) => ({
      skill_name: skillName,
      has_skill_md_read: false,
    }));
  for (const [index, detection] of skillDetections.entries()) {
    const { invocation_mode, confidence } = deriveInvocationMode({
      has_skill_md_read: detection.has_skill_md_read,
      is_text_mention_only: !detection.has_skill_md_read,
    });
    records.push(
      buildCanonicalSkillInvocation({
        ...baseInput,
        skill_invocation_id: deriveSkillInvocationId(
          session.session_id,
          detection.skill_name,
          index,
        ),
        occurred_at: session.timestamp,
        matched_prompt_id: promptId,
        skill_name: detection.skill_name,
        skill_path: `(opencode:${detection.skill_name})`,
        invocation_mode,
        triggered: true,
        confidence,
      }),
    );
  }

  if (!session.is_metadata_only) {
    records.push(
      buildCanonicalExecutionFact({
        ...baseInput,
        occurred_at: session.timestamp,
        prompt_id: promptId,
        tool_calls_json: session.tool_calls,
        total_tool_calls: session.total_tool_calls,
        bash_commands_redacted: session.bash_commands,
        assistant_turns: session.assistant_turns,
        errors_encountered: session.errors_encountered,
        ...(session.input_tokens === undefined ? {} : { input_tokens: session.input_tokens }),
        ...(session.output_tokens === undefined ? {} : { output_tokens: session.output_tokens }),
      }),
    );
  }

  return records;
}
