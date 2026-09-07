import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";

import { createDurableDecisionStore, type DurableDecisionBase } from "./durable-decisions.js";

interface FixtureDecision extends DurableDecisionBase {
  readonly requested_action: "fixture";
  readonly impact: string;
  readonly receipt: { readonly id: string } | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
}

const FixtureDecisionSchema = Schema.Struct({
  schema_version: Schema.Literal(1),
  approval_id: Schema.String,
  requested_action: Schema.Literal("fixture"),
  status: Schema.Literals(["pending", "approved", "declined", "stale", "expired", "failed"]),
  created_at: Schema.String,
  updated_at: Schema.String,
  expires_at: Schema.String,
  decided_at: Schema.NullOr(Schema.String),
  impact: Schema.String,
  receipt: Schema.NullOr(Schema.Struct({ id: Schema.String })),
  failure: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
  audit: Schema.Array(
    Schema.Struct({
      event: Schema.Literals(["prepared", "approved", "declined", "stale", "expired", "failed"]),
      at: Schema.String,
      reason: Schema.NullOr(Schema.String),
    }),
  ),
});

const store = createDurableDecisionStore<FixtureDecision>({
  directory: "fixtures",
  notFoundMessage: "Fixture decision was not found.",
  schema: FixtureDecisionSchema,
  expiryFailure: {
    code: "FIXTURE_EXPIRED",
    message: "Prepare a fresh fixture.",
  },
});

function pending(now: string): FixtureDecision {
  return {
    schema_version: 1,
    approval_id: "12345678-1234-4234-8234-123456789abc",
    requested_action: "fixture",
    status: "pending",
    created_at: now,
    updated_at: now,
    expires_at: new Date(Date.parse(now) + 60_000).toISOString(),
    decided_at: null,
    impact: "one mutation",
    receipt: null,
    failure: null,
    audit: [{ event: "prepared", at: now, reason: null }],
  };
}

describe("durable decision store", () => {
  test("persists restart-safe decisions and approves once across racing callers", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-decision-core-"));
    try {
      const now = "2026-07-16T10:00:00.000Z";
      store.persist(pending(now), { configRoot, now: Date.parse(now) });
      let mutations = 0;
      const approve = () =>
        store.decide(
          pending(now).approval_id,
          "approve",
          { configRoot, now: Date.parse(now) },
          async () => {
            mutations += 1;
            return { status: "approved", receipt: { id: "receipt-1" } };
          },
        );
      const [first, second] = await Promise.all([approve(), approve()]);

      expect(mutations).toBe(1);
      expect(first.status).toBe("approved");
      expect(second).toEqual(first);
      expect(store.list({ configRoot })).toHaveLength(1);
      expect(first.audit.map((entry) => entry.event)).toEqual(["prepared", "approved"]);
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  test("declines idempotently and expires without invoking mutation", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-decision-core-"));
    try {
      const now = "2026-07-16T10:00:00.000Z";
      const decision = pending(now);
      store.persist(decision, { configRoot, now: Date.parse(now) });
      const declined = await store.decide(
        decision.approval_id,
        "decline",
        { configRoot, now: Date.parse(now) },
        async () => {
          throw new Error("must not run");
        },
      );
      const repeated = await store.decide(
        decision.approval_id,
        "approve",
        { configRoot, now: Date.parse(now) },
        async () => {
          throw new Error("must not run");
        },
      );
      expect(repeated).toEqual(declined);

      const expiredDecision = {
        ...pending(now),
        approval_id: "22345678-1234-4234-8234-123456789abc",
      };
      store.persist(expiredDecision, { configRoot, now: Date.parse(now) });
      const expired = store.get(expiredDecision.approval_id, {
        configRoot,
        now: Date.parse(now) + 60_001,
      });
      expect(expired.status).toBe("expired");
      expect(expired.failure?.code).toBe("FIXTURE_EXPIRED");
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  test("recovers an approval after the previous process left an orphaned lock", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-decision-core-"));
    try {
      const now = "2026-07-16T10:00:00.000Z";
      const decision = pending(now);
      store.persist(decision, { configRoot, now: Date.parse(now) });
      writeFileSync(
        `${store.pathFor(decision.approval_id, { configRoot })}.lock`,
        JSON.stringify({ pid: 2_147_483_647 }),
      );

      const approved = await store.decide(
        decision.approval_id,
        "approve",
        { configRoot, now: Date.parse(now) },
        async () => ({ status: "approved", receipt: { id: "recovered" } }),
      );

      expect(approved.status).toBe("approved");
      expect(approved.receipt?.id).toBe("recovered");
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  });
});
