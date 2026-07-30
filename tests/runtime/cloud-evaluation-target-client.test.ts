import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";

import {
  CloudEvaluationTargetClient,
  CloudEvaluationTargetNotLinkedError,
  CloudEvaluationTargetRejectedError,
  CloudEvaluationTargetResponseError,
  makeCloudEvaluationTargetClientLayer,
} from "../../packages/runtime/evolution/cloud-evaluation-target-client.js";
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

const revision = "a".repeat(64);
const digest = `sha256:${"b".repeat(64)}`;
const query = { skill_name: "TDD & safety", skill_revision: revision };

const discovery = {
  targets: [
    {
      source_id: "source-1",
      snapshot_id: "snapshot-1",
      skill_id: "skill-1",
      skill_name: "TDD & safety",
      skill_revision: revision,
      suite_id: "suite-1",
      suite_name: "Reviewed outcomes",
      lane: "outcome_task",
      manifest_digest: digest,
      verifier_kind: "outcome",
      min_repetitions: 3,
      max_repetitions: 3,
      verification_only: false,
    },
  ],
  blockers: [],
};

function config(withCredential = true): string {
  const root = mkdtempSync(join(tmpdir(), "selftune-cloud-evaluation-target-"));
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
        cloud_api_url: "https://cloud.test/base-path",
        credential,
      },
    }),
  );
  return path;
}

function discoverWith(configPath: string, fetchImplementation: typeof fetch) {
  return Effect.gen(function* () {
    const client = yield* CloudEvaluationTargetClient;
    return yield* client.discover(query);
  }).pipe(
    Effect.provide(
      makeCloudEvaluationTargetClientLayer({
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

describe("CloudEvaluationTargetClient", () => {
  test("uses a server-only credential and URL-encodes the exact target query", async () => {
    const configPath = config();
    let authorization = "";
    let receivedUrl = "";
    const result = await Effect.runPromise(
      discoverWith(configPath, async (url, init) => {
        receivedUrl = String(url);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json(discovery);
      }),
    );
    expect(result).toEqual(discovery);
    expect(authorization).toBe("Bearer cloud-test-secret");
    const url = new URL(receivedUrl);
    expect(url.pathname).toBe("/api/v1/cloud/evaluation-targets");
    expect(url.searchParams.get("skill_name")).toBe(query.skill_name);
    expect(url.searchParams.get("skill_revision")).toBe(query.skill_revision);
  });

  test("does not issue a request when Desktop is not linked", async () => {
    const configPath = config(false);
    let requested = false;
    await expect(
      Effect.runPromise(
        discoverWith(configPath, async () => {
          requested = true;
          return Response.json(discovery);
        }),
      ),
    ).rejects.toBeInstanceOf(CloudEvaluationTargetNotLinkedError);
    expect(requested).toBe(false);
  });

  test("rejects malformed or case-bearing Cloud target lists", async () => {
    const configPath = config();
    await expect(
      Effect.runPromise(
        discoverWith(configPath, async () =>
          Response.json({
            ...discovery,
            targets: [{ ...discovery.targets[0], cases: [{ prompt: "do not expose me" }] }],
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(CloudEvaluationTargetResponseError);
  });

  test("rejects targets that do not match the exact requested package revision", async () => {
    const configPath = config();
    await expect(
      Effect.runPromise(
        discoverWith(configPath, async () =>
          Response.json({
            ...discovery,
            targets: [{ ...discovery.targets[0], skill_revision: "c".repeat(64) }],
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(CloudEvaluationTargetResponseError);
  });

  test("maps Cloud rejections and enforces the response-size ceiling", async () => {
    const configPath = config();
    await expect(
      Effect.runPromise(
        discoverWith(configPath, async () =>
          Response.json(
            { error: { code: "TARGET_UNAVAILABLE", message: "No reviewed suite is available." } },
            { status: 422 },
          ),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "CloudEvaluationTargetRejectedError",
      code: "TARGET_UNAVAILABLE",
    } satisfies Partial<CloudEvaluationTargetRejectedError>);

    await expect(
      Effect.runPromise(
        discoverWith(
          configPath,
          async () =>
            new Response("{}", {
              headers: { "content-length": String(64 * 1024 + 1) },
            }),
        ),
      ),
    ).rejects.toBeInstanceOf(CloudEvaluationTargetResponseError);

    await expect(
      Effect.runPromise(
        discoverWith(
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
    ).rejects.toBeInstanceOf(CloudEvaluationTargetResponseError);
  });
});
