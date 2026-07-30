import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";

import {
  CloudEvaluationSubmissionClient,
  CloudEvaluationSubmissionNotLinkedError,
  CloudEvaluationSubmissionRejectedError,
  CloudEvaluationSubmissionResponseError,
  makeCloudEvaluationSubmissionClientLayer,
} from "../../packages/runtime/evolution/cloud-evaluation-submission-client.js";
import type { PlatformCredentialStore } from "../../packages/runtime/credential-store.js";

const roots: string[] = [];
const credentials = new Map<string, string>();
const credentialStore: PlatformCredentialStore = {
  set: (account, value) => {
    credentials.set(account, value);
    return { provider: "file", account };
  },
  get: (reference) => credentials.get(reference.account) ?? null,
  delete: (reference) => {
    credentials.delete(reference.account);
  },
};

const submission: unknown = {
  schema_version: 1,
  submission_id: "submission-1",
  idempotency_key: "key-1",
  baseline: {
    cloud_source_id: "source-1",
    cloud_snapshot_id: "snapshot-1",
    skill_id: "skill-1",
    skill_name: "skill-one",
    skill_revision: "c".repeat(64),
  },
  hypothesis: {
    pattern_id: "pattern-1",
    kind: "repeated_correlated_errors",
    summary: "Repeated failure",
  },
  candidate: {
    proposal_id: "proposal-1",
    mutation_surface: "body",
    target_revision: "c".repeat(64),
    proposed_body: "Use the validated workflow.",
    rationale: "Improves the known failure.",
  },
  evaluation: {
    cloud_eval_suite_id: "suite-1",
    manifest_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    lane: "outcome_task",
    max_repetitions: 3,
    verification_only: false,
  },
  evidence: {
    cohort_fingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    selected_trace_count: 2,
    entries: [
      {
        role: "calibration",
        query: "find failed thing",
        should_trigger: true,
        source_reference: "trace://source-1/rev-1/trace-1/span-1/invocation-1",
      },
      {
        role: "holdout",
        query: "find held out thing",
        should_trigger: true,
        source_reference: "trace://source-1/rev-1/trace-2/span-2/invocation-2",
      },
    ],
  },
};

function config(withCredential = true): string {
  const root = mkdtempSync(join(tmpdir(), "selftune-cloud-evaluation-"));
  roots.push(root);
  const path = join(root, "config.json");
  const credential = { provider: "file" as const, account: `credential:${root}` };
  if (withCredential) credentials.set(credential.account, "cloud-test-secret");
  writeFileSync(
    path,
    JSON.stringify({
      agent_type: "unknown",
      cli_path: "/usr/local/bin/selftune",
      llm_mode: "agent",
      agent_cli: null,
      hooks_installed: false,
      initialized_at: "2026-07-24T00:00:00.000Z",
      alpha: {
        enrolled: true,
        user_id: "user-1",
        consent_timestamp: "2026-07-24T00:00:00.000Z",
        cloud_api_url: "https://cloud.test",
        credential,
      },
    }),
  );
  return path;
}

function submitWith(configPath: string, fetchImplementation: typeof fetch) {
  return Effect.gen(function* () {
    const client = yield* CloudEvaluationSubmissionClient;
    return yield* client.submit(submission);
  }).pipe(
    Effect.provide(
      makeCloudEvaluationSubmissionClientLayer({
        configPath,
        credentialDependencies: { credentialStore },
        fetch: fetchImplementation,
      }),
    ),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  credentials.clear();
});

describe("CloudEvaluationSubmissionClient", () => {
  test("does not issue a request when Desktop is not linked", async () => {
    const configPath = config(false);
    let requested = false;
    await expect(
      Effect.runPromise(
        submitWith(configPath, async () => {
          requested = true;
          return Response.json({ run_id: "run-1", status: "queued", dispatch: "scheduled" });
        }),
      ),
    ).rejects.toBeInstanceOf(CloudEvaluationSubmissionNotLinkedError);
    expect(requested).toBe(false);
  });

  test("decodes the actual Cloud 201 scheduled receipt and sends only the redacted portable artifact", async () => {
    const configPath = config();
    let authorization = "";
    let body = "";
    const result = await Effect.runPromise(
      submitWith(configPath, async (_url, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        body = typeof init?.body === "string" ? init.body : "";
        return Response.json(
          { run_id: "run-1", status: "queued", dispatch: "scheduled" },
          { status: 201 },
        );
      }),
    );
    expect(result).toEqual({ run_id: "run-1", status: "queued", dispatch: "scheduled" });
    expect(authorization).toBe("Bearer cloud-test-secret");
    expect(body).not.toContain("cloud-test-secret");
    expect(body).not.toContain("/usr/local/bin/selftune");
    expect(JSON.parse(body)).not.toHaveProperty("trace_files");
  });

  test("maps a typed Cloud rejection without leaking the credential", async () => {
    const configPath = config();
    await expect(
      Effect.runPromise(
        submitWith(configPath, async () =>
          Response.json(
            {
              error: { code: "SUITE_NOT_REVIEWED", message: "The selected suite is not reviewed." },
            },
            { status: 422 },
          ),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "CloudEvaluationSubmissionRejectedError",
      code: "SUITE_NOT_REVIEWED",
      message: "The selected suite is not reviewed.",
    } satisfies Partial<CloudEvaluationSubmissionRejectedError>);
  });

  test("stops reading a chunked response at the 64 KiB boundary", async () => {
    const configPath = config();
    await expect(
      Effect.runPromise(
        submitWith(
          configPath,
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array(64 * 1024));
                  controller.enqueue(new Uint8Array(1));
                  controller.close();
                },
              }),
            ),
        ),
      ),
    ).rejects.toBeInstanceOf(CloudEvaluationSubmissionResponseError);
  });
});
