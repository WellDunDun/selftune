import { describe, expect, test } from "bun:test";
import { completePush } from "../fixtures/complete-push.js";
import { evidenceOnlyPush } from "../fixtures/evidence-only-push.js";
import { partialPushNoSessions } from "../fixtures/partial-push-no-sessions.js";
import { partialPushUnresolvedParents } from "../fixtures/partial-push-unresolved-parents.js";
import { PushPayloadV2Schema } from "../src/schemas.js";

describe("PushPayloadV2Schema compatibility", () => {
  // ---- Fixture validation ----

  test("complete-push fixture passes validation", () => {
    const result = PushPayloadV2Schema.safeParse(completePush);
    if (!result.success) {
      throw new Error(`Validation failed: ${JSON.stringify(result.error.issues, null, 2)}`);
    }
    expect(result.success).toBe(true);
  });

  test("partial-push-no-sessions fixture passes validation", () => {
    const result = PushPayloadV2Schema.safeParse(partialPushNoSessions);
    if (!result.success) {
      throw new Error(`Validation failed: ${JSON.stringify(result.error.issues, null, 2)}`);
    }
    expect(result.success).toBe(true);
  });

  test("partial-push-unresolved-parents fixture passes validation", () => {
    const result = PushPayloadV2Schema.safeParse(partialPushUnresolvedParents);
    if (!result.success) {
      throw new Error(`Validation failed: ${JSON.stringify(result.error.issues, null, 2)}`);
    }
    expect(result.success).toBe(true);
  });

  test("evidence-only-push fixture passes validation", () => {
    const result = PushPayloadV2Schema.safeParse(evidenceOnlyPush);
    if (!result.success) {
      throw new Error(`Validation failed: ${JSON.stringify(result.error.issues, null, 2)}`);
    }
    expect(result.success).toBe(true);
  });

  // ---- execution_fact_id is required ----

  test("execution_fact_id is required on execution facts", () => {
    const badPayload = structuredClone(completePush);
    // biome-ignore lint/performance/noDelete: test needs to remove field
    delete (badPayload.canonical.execution_facts[0] as Record<string, unknown>).execution_fact_id;
    const result = PushPayloadV2Schema.safeParse(badPayload);
    expect(result.success).toBe(false);
  });

  test("execution_fact_id rejects empty string", () => {
    const badPayload = structuredClone(completePush);
    (badPayload.canonical.execution_facts[0] as Record<string, unknown>).execution_fact_id = "";
    const result = PushPayloadV2Schema.safeParse(badPayload);
    expect(result.success).toBe(false);
  });

  // ---- bash_commands_redacted is optional ----

  test("bash_commands_redacted is optional (omitting it passes)", () => {
    // The unresolved-parents fixture already omits bash_commands_redacted
    const ef = partialPushUnresolvedParents.canonical.execution_facts[0];
    expect(ef.bash_commands_redacted).toBeUndefined();

    const result = PushPayloadV2Schema.safeParse(partialPushUnresolvedParents);
    expect(result.success).toBe(true);
  });

  test("bash_commands_redacted accepts an array when present", () => {
    const ef = completePush.canonical.execution_facts[0];
    expect(Array.isArray(ef.bash_commands_redacted)).toBe(true);

    const result = PushPayloadV2Schema.safeParse(completePush);
    expect(result.success).toBe(true);
  });

  // ---- Zero-session pushes ----

  test("zero-session pushes pass validation", () => {
    expect(partialPushNoSessions.canonical.sessions).toHaveLength(0);
    const result = PushPayloadV2Schema.safeParse(partialPushNoSessions);
    expect(result.success).toBe(true);
  });

  test("evidence-only push with all empty arrays passes", () => {
    expect(evidenceOnlyPush.canonical.sessions).toHaveLength(0);
    expect(evidenceOnlyPush.canonical.prompts).toHaveLength(0);
    expect(evidenceOnlyPush.canonical.skill_invocations).toHaveLength(0);
    expect(evidenceOnlyPush.canonical.execution_facts).toHaveLength(0);
    expect(evidenceOnlyPush.canonical.normalization_runs).toHaveLength(0);
    const result = PushPayloadV2Schema.safeParse(evidenceOnlyPush);
    expect(result.success).toBe(true);
  });

  // ---- Unresolved parent references ----

  test("unresolved parent references pass (invocation references session_id not in sessions)", () => {
    const sessionIds = new Set(
      partialPushUnresolvedParents.canonical.sessions.map((s) => s.session_id),
    );
    const invSessionIds = partialPushUnresolvedParents.canonical.skill_invocations.map(
      (i) => i.session_id,
    );

    // Confirm the invocation references a session not in the sessions array
    for (const sid of invSessionIds) {
      expect(sessionIds.has(sid)).toBe(false);
    }

    const result = PushPayloadV2Schema.safeParse(partialPushUnresolvedParents);
    expect(result.success).toBe(true);
  });

  test("prompts with unresolved session_id pass validation", () => {
    const sessionIds = new Set(
      partialPushUnresolvedParents.canonical.sessions.map((s) => s.session_id),
    );
    const promptSessionIds = partialPushUnresolvedParents.canonical.prompts.map(
      (p) => p.session_id,
    );

    for (const sid of promptSessionIds) {
      expect(sessionIds.has(sid)).toBe(false);
    }

    const result = PushPayloadV2Schema.safeParse(partialPushUnresolvedParents);
    expect(result.success).toBe(true);
  });
});
