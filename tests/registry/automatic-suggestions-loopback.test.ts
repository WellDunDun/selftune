import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import * as BunServices from "@effect/platform-bun/BunServices";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Schema } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import {
  runAutomaticRegistrySuggestionScan,
  type AutomaticRegistrySuggestionScanResult,
} from "../../packages/runtime/registry/automatic-suggestions.js";
import { makeRegistryClientLayer } from "../../packages/runtime/registry/client.js";
import type { PlatformCredentialStore } from "../../packages/runtime/credential-store.js";
import {
  makeRegistryPlatformLayer,
  RegistryPlatform,
} from "../../packages/runtime/registry/platform.js";
import { commitRegistryState } from "../../packages/runtime/registry/registry-state-store.js";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

describe("automatic Registry suggestions over loopback", () => {
  test("packages stable teammate edits, submits once, and persists the receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-automatic-suggestion-loopback-"));
    const configDirectory = join(root, ".selftune");
    const configPath = join(configDirectory, "config.json");
    const homeDirectory = join(root, "home");
    const skillDirectory = join(homeDirectory, ".claude", "skills", "support-playbook");
    const guideDirectory = join(skillDirectory, "references");
    mkdirSync(configDirectory, { recursive: true });
    mkdirSync(guideDirectory, { recursive: true });

    const baselineSkill =
      "---\nname: support-playbook\ndescription: Handle customer support\n---\n\nEscalate billing issues.\n";
    const editedSkill =
      "---\nname: support-playbook\ndescription: Handle customer support\n---\n\nConfirm the account owner before escalating billing issues.\n";
    const editedGuide = "# Escalation guide\n\nInclude the verified account ID.\n";
    writeFileSync(join(skillDirectory, "SKILL.md"), baselineSkill);

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
    const credential = credentialStore.set(
      "registry:automatic-loopback",
      "loopback-secret",
      configDirectory,
    );

    let postCount = 0;
    const capturedRequests: Array<{
      readonly authorization: string | null;
      readonly archiveHash: string;
      readonly archiveName: string;
      readonly archiveType: string;
      readonly metadata: typeof Schema.Json.Type;
      readonly pathname: string;
    }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (
          request.method !== "POST" ||
          url.pathname !== "/api/v1/collaboration/registry/registry-support/contributions"
        ) {
          return Response.json({ error: "unexpected request" }, { status: 404 });
        }
        postCount += 1;
        const form = await request.formData();
        const archive = form.get("archive");
        const metadata = form.get("metadata");
        if (!(archive instanceof File) || !Schema.is(Schema.String)(metadata)) {
          return Response.json({ error: "invalid multipart request" }, { status: 400 });
        }
        capturedRequests.push({
          authorization: request.headers.get("authorization"),
          archiveHash: sha256(new Uint8Array(await archive.arrayBuffer())),
          archiveName: archive.name,
          archiveType: archive.type,
          metadata: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(metadata),
          pathname: url.pathname,
        });
        return Response.json(
          { id: "contribution-loopback-1", status: "pending", deduplicated: false },
          { status: 201 },
        );
      },
    });

    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          agent_type: "unknown",
          cli_path: "/usr/local/bin/selftune",
          llm_mode: "agent",
          agent_cli: null,
          hooks_installed: false,
          initialized_at: "2026-08-01T00:00:00.000Z",
          alpha: {
            enrolled: true,
            user_id: "automatic-loopback-user",
            consent_timestamp: "2026-08-01T00:00:00.000Z",
            cloud_api_url: `http://127.0.0.1:${server.port}`,
            credential,
          },
        }),
      );

      const liveLayer = Layer.merge(
        makeRegistryPlatformLayer({
          configDirectory,
          cwd: root,
          deviceId: "automatic-loopback-device",
          homeDirectory,
        }),
        makeRegistryClientLayer(configPath, { credentialStore }),
      ).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(BunServices.layer));
      const now = Date.parse("2026-08-01T12:34:56.000Z");

      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const platform = yield* RegistryPlatform;
          const baselineHash = yield* platform.computeInstalledContentHash(skillDirectory);
          yield* platform.withStateTransaction(() =>
            Effect.succeed(
              commitRegistryState(
                [
                  {
                    entryId: "registry-support",
                    name: "support-playbook",
                    versionHash: "base-content-hash",
                    version: "1.4.0",
                    versionId: "base-version-1",
                    installPath: skillDirectory,
                    localContentHash: baselineHash,
                  },
                ],
                undefined,
              ),
            ),
          );

          yield* Effect.sync(() => {
            writeFileSync(join(skillDirectory, "SKILL.md"), editedSkill);
            writeFileSync(join(guideDirectory, "guide.md"), editedGuide);
          });
          const observedContentHash = yield* platform.computeInstalledContentHash(skillDirectory);
          const options = { now: () => now, stableForMs: 0 };
          const armed = yield* runAutomaticRegistrySuggestionScan(options);
          const submitted = yield* runAutomaticRegistrySuggestionScan(options);
          const unchanged = yield* runAutomaticRegistrySuggestionScan(options);
          const state = yield* platform.loadState();
          return { armed, observedContentHash, state, submitted, unchanged };
        }).pipe(Effect.provide(liveLayer)),
      );

      const expectedManifest = [
        {
          path: "references/guide.md",
          hash: sha256(editedGuide),
          size: Buffer.byteLength(editedGuide),
        },
        {
          path: "SKILL.md",
          hash: sha256(editedSkill),
          size: Buffer.byteLength(editedSkill),
        },
      ];
      const expectedArmed = {
        managed: 1,
        armed: 1,
        submitted: 0,
        deferred: 0,
        failed: 0,
      } satisfies AutomaticRegistrySuggestionScanResult;
      const expectedSubmitted = {
        managed: 1,
        armed: 0,
        submitted: 1,
        deferred: 0,
        failed: 0,
      } satisfies AutomaticRegistrySuggestionScanResult;
      const expectedUnchanged = {
        managed: 1,
        armed: 0,
        submitted: 0,
        deferred: 0,
        failed: 0,
      } satisfies AutomaticRegistrySuggestionScanResult;

      expect(outcome.armed).toEqual(expectedArmed);
      expect(outcome.submitted).toEqual(expectedSubmitted);
      expect(outcome.unchanged).toEqual(expectedUnchanged);
      expect(postCount).toBe(1);
      expect(capturedRequests).toHaveLength(1);
      const captured = capturedRequests[0];
      assert(captured);
      expect(captured).toEqual({
        authorization: "Bearer loopback-secret",
        archiveHash: captured?.archiveHash,
        archiveName: "support-playbook.tar.gz",
        archiveType: "application/gzip",
        metadata: {
          baseVersionId: "base-version-1",
          candidateVersion: `1.4.0.team.${outcome.observedContentHash.slice(0, 12)}`,
          candidateContentHash: captured?.archiveHash,
          summary: "Automatically captured teammate edits to support-playbook",
          files: expectedManifest,
        },
        pathname: "/api/v1/collaboration/registry/registry-support/contributions",
      });

      const entry = outcome.state[0];
      expect(entry?.automaticSuggestion).toBeUndefined();
      expect(entry?.lastSuggestion).toEqual({
        observedContentHash: outcome.observedContentHash,
        candidateContentHash: captured?.archiveHash,
        baseVersionHash: "base-content-hash",
        baseVersionId: "base-version-1",
        contributionId: "contribution-loopback-1",
        submittedAt: "2026-08-01T12:34:56.000Z",
      });
      expect(
        JSON.parse(readFileSync(join(configDirectory, "registry-state.json"), "utf8")),
      ).toEqual(outcome.state);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
