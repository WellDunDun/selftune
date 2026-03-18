import { describe, expect, it } from "bun:test";
import { validateEnvelope } from "../src/validate";
import type { AlphaUploadEnvelope } from "../src/types";

function validSessionEnvelope(): AlphaUploadEnvelope {
  return {
    schema_version: "alpha-1.0",
    user_id: "user-abc-123",
    agent_type: "claude-code",
    selftune_version: "0.2.2",
    uploaded_at: "2026-03-18T12:00:00Z",
    payload_type: "sessions",
    payload: [
      {
        session_id: "sess-001",
        platform: "darwin",
        model: "claude-4",
        workspace_hash: "abc123hash",
        started_at: "2026-03-18T11:00:00Z",
        ended_at: "2026-03-18T11:30:00Z",
        total_tool_calls: 12,
        assistant_turns: 5,
        errors_encountered: 0,
        skills_triggered: ["selftune"],
        completion_status: "completed",
      },
    ],
  };
}

function validInvocationEnvelope(): AlphaUploadEnvelope {
  return {
    schema_version: "alpha-1.0",
    user_id: "user-abc-123",
    agent_type: "claude-code",
    selftune_version: "0.2.2",
    uploaded_at: "2026-03-18T12:00:00Z",
    payload_type: "invocations",
    payload: [
      {
        session_id: "sess-001",
        occurred_at: "2026-03-18T11:05:00Z",
        skill_name: "selftune",
        invocation_mode: "auto",
        triggered: true,
        confidence: 0.95,
        query_text: "improve my skills",
        skill_scope: null,
        source: "hook",
      },
    ],
  };
}

function validEvolutionEnvelope(): AlphaUploadEnvelope {
  return {
    schema_version: "alpha-1.0",
    user_id: "user-abc-123",
    agent_type: "claude-code",
    selftune_version: "0.2.2",
    uploaded_at: "2026-03-18T12:00:00Z",
    payload_type: "evolution",
    payload: [
      {
        proposal_id: "prop-001",
        skill_name: "selftune",
        action: "update-description",
        before_pass_rate: 0.6,
        after_pass_rate: 0.85,
        net_change: 0.25,
        deployed: true,
        rolled_back: false,
        timestamp: "2026-03-18T11:30:00Z",
      },
    ],
  };
}

describe("validateEnvelope", () => {
  it("accepts a valid session envelope", () => {
    const result = validateEnvelope(validSessionEnvelope());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a valid invocation envelope", () => {
    const result = validateEnvelope(validInvocationEnvelope());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a valid evolution envelope", () => {
    const result = validateEnvelope(validEvolutionEnvelope());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects missing user_id", () => {
    const env = validSessionEnvelope();
    (env as any).user_id = "";
    const result = validateEnvelope(env);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("user_id"))).toBe(true);
  });

  it("rejects missing payload_type", () => {
    const env = validSessionEnvelope();
    (env as any).payload_type = undefined;
    const result = validateEnvelope(env);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("payload_type"))).toBe(true);
  });

  it("rejects invalid payload_type", () => {
    const env = validSessionEnvelope();
    (env as any).payload_type = "unknown";
    const result = validateEnvelope(env);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("payload_type"))).toBe(true);
  });

  it("rejects missing payload array", () => {
    const env = validSessionEnvelope();
    (env as any).payload = undefined;
    const result = validateEnvelope(env);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("payload"))).toBe(true);
  });

  it("rejects empty payload array", () => {
    const env = validSessionEnvelope();
    env.payload = [];
    const result = validateEnvelope(env);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("payload"))).toBe(true);
  });

  it("rejects non-object input", () => {
    const result = validateEnvelope(null as any);
    expect(result.valid).toBe(false);
  });

  it("rejects wrong schema_version", () => {
    const env = validSessionEnvelope();
    (env as any).schema_version = "beta-2.0";
    const result = validateEnvelope(env);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schema_version"))).toBe(true);
  });

  it("rejects missing uploaded_at", () => {
    const env = validSessionEnvelope();
    (env as any).uploaded_at = "";
    const result = validateEnvelope(env);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("uploaded_at"))).toBe(true);
  });
});
