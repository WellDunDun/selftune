/**
 * End-to-end alpha smoke test.
 *
 * Requires: gwangju-v1 running locally with DEV_AUTH=1
 * Run: SELFTUNE_ALPHA_ENDPOINT=http://localhost:8080/api/v1/push bun test tests/e2e/alpha-smoke.test.ts
 *
 * This test exercises the real device-code bootstrap path:
 * 1. Spawn `selftune init --alpha` in a subprocess
 * 2. Race: approve the device code via test-only internal endpoint
 * 3. CLI poll resolves -> config written with cloud_user_id, api_key
 * 4. Run `selftune alpha upload` with the received credentials
 * 5. Verify data landed in the cloud
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Gate: skip when cloud is not available
// ---------------------------------------------------------------------------

const CLOUD_AVAILABLE = !!process.env.SELFTUNE_ALPHA_ENDPOINT;
const describeE2E = CLOUD_AVAILABLE ? describe : describe.skip;

// Resolve CLI entry point (relative to this test file)
const CLI_ENTRY = resolve(dirname(import.meta.path), "..", "..", "cli", "selftune", "index.ts");

describeE2E("Alpha E2E Smoke", () => {
  const baseUrl = (process.env.SELFTUNE_ALPHA_ENDPOINT ?? "").replace(/\/push$/, "");
  let tempHome: string;
  let configDir: string;
  let configPath: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "selftune-e2e-"));
    configDir = join(tempHome, ".selftune");
    configPath = join(configDir, "config.json");
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test(
    "full flow: init --alpha device-code path -> push -> verify",
    async () => {
      // -----------------------------------------------------------------
      // Step 1: Spawn `selftune init --alpha` in a subprocess
      // -----------------------------------------------------------------
      const initProc = Bun.spawn(
        [
          "bun",
          "run",
          CLI_ENTRY,
          "init",
          "--alpha",
          "--agent",
          "claude_code",
          "--cli-path",
          CLI_ENTRY,
          "--force",
        ],
        {
          env: {
            ...process.env,
            HOME: tempHome,
            SELFTUNE_CONFIG_DIR: configDir,
            SELFTUNE_ALPHA_ENDPOINT: process.env.SELFTUNE_ALPHA_ENDPOINT,
            // Prevent auto-update check from interfering
            SELFTUNE_SKIP_AUTO_UPDATE: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      // -----------------------------------------------------------------
      // Step 2: Parse the user_code from subprocess stdout
      //
      // The init process emits JSON lines to stdout. We need the one with
      // code: "device_code_issued" which contains the user_code.
      // -----------------------------------------------------------------
      let userCode: string | null = null;
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      // Read stdout in a streaming fashion to catch the device code early
      const stdoutReader = initProc.stdout.getReader();
      const decoder = new TextDecoder();

      const readUntilUserCode = async (): Promise<string> => {
        const deadline = Date.now() + 15_000; // 15s to get the device code
        let accumulated = "";

        while (Date.now() < deadline) {
          const { done, value } = await Promise.race([
            stdoutReader.read(),
            new Promise<{ done: true; value: undefined }>((resolve) =>
              setTimeout(() => resolve({ done: true, value: undefined }), 1000),
            ),
          ]);

          if (value) {
            const chunk = decoder.decode(value, { stream: true });
            accumulated += chunk;
            stdoutChunks.push(chunk);

            // Try to parse JSON lines from accumulated output
            const lines = accumulated.split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const parsed = JSON.parse(trimmed);
                if (parsed.code === "device_code_issued" && parsed.user_code) {
                  return parsed.user_code;
                }
              } catch {
                // Not valid JSON, skip
              }
            }
          }

          if (done) break;
        }

        throw new Error(`Timed out waiting for device_code_issued. Stdout so far: ${accumulated}`);
      };

      userCode = await readUntilUserCode();
      expect(userCode).toBeTruthy();
      expect(typeof userCode).toBe("string");

      // -----------------------------------------------------------------
      // Step 3: Approve via test-only internal endpoint
      // -----------------------------------------------------------------
      const approveResponse = await fetch(`${baseUrl}/internal/test/approve-device`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_code: userCode }),
      });

      expect(approveResponse.ok).toBe(true);

      // -----------------------------------------------------------------
      // Step 4: Wait for init to complete (poll should resolve)
      // -----------------------------------------------------------------
      // Continue reading stdout until process exits
      const drainStdout = async () => {
        try {
          while (true) {
            const { done, value } = await stdoutReader.read();
            if (value) stdoutChunks.push(decoder.decode(value, { stream: true }));
            if (done) break;
          }
        } catch {
          // Reader closed
        }
      };

      // Also capture stderr
      const drainStderr = async () => {
        try {
          const reader = initProc.stderr.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (value) stderrChunks.push(decoder.decode(value, { stream: true }));
            if (done) break;
          }
        } catch {
          // Reader closed
        }
      };

      await Promise.all([drainStdout(), drainStderr()]);

      const exitCode = await initProc.exited;
      const fullStdout = stdoutChunks.join("");
      const fullStderr = stderrChunks.join("");

      if (exitCode !== 0) {
        console.error("init stdout:", fullStdout);
        console.error("init stderr:", fullStderr);
      }
      expect(exitCode).toBe(0);

      // -----------------------------------------------------------------
      // Step 5: Verify config file was written correctly
      // -----------------------------------------------------------------
      expect(existsSync(configPath)).toBe(true);

      const configRaw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(configRaw);

      expect(config.alpha).toBeDefined();
      expect(config.alpha.enrolled).toBe(true);
      expect(config.alpha.cloud_user_id).toBeTruthy();
      expect(typeof config.alpha.cloud_user_id).toBe("string");
      expect(config.alpha.api_key).toBeTruthy();
      expect(
        config.alpha.api_key.startsWith("st_live_") || config.alpha.api_key.startsWith("st_test_"),
      ).toBe(true);

      const apiKey = config.alpha.api_key as string;
      // -----------------------------------------------------------------
      // Step 6: Verify data can be pushed using the received credentials
      // -----------------------------------------------------------------
      const pushPayload = {
        schema_version: "2.0",
        client_version: "0.0.0-e2e",
        push_id: randomUUID(),
        normalizer_version: "0.0.0-e2e",
        canonical: {
          sessions: [
            {
              record_kind: "session",
              schema_version: "2.0",
              normalizer_version: "0.0.0-e2e",
              normalized_at: new Date().toISOString(),
              platform: "claude_code",
              capture_mode: "hook",
              raw_source_ref: { path: "/tmp/e2e/session.jsonl" },
              source_session_kind: "interactive",
              session_id: randomUUID(),
              agent_type: "claude",
              agent_cli: "claude-code",
              started_at: new Date().toISOString(),
              ended_at: new Date().toISOString(),
              completion_status: "completed",
            },
          ],
          prompts: [],
          skill_invocations: [],
          execution_facts: [],
          normalization_runs: [
            {
              record_kind: "normalization_run",
              schema_version: "2.0",
              normalizer_version: "0.0.0-e2e",
              normalized_at: new Date().toISOString(),
              platform: "claude_code",
              capture_mode: "hook",
              raw_source_ref: {},
              run_id: randomUUID(),
              run_at: new Date().toISOString(),
              raw_records_seen: 1,
              canonical_records_written: 1,
              repair_applied: false,
            },
          ],
          evolution_evidence: [],
          orchestrate_runs: [],
        },
      };

      const pushResponse = await fetch(`${baseUrl}/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(pushPayload),
      });

      // Accept 200 or 201 as success
      expect(pushResponse.status).toBeGreaterThanOrEqual(200);
      expect(pushResponse.status).toBeLessThan(300);

      // -----------------------------------------------------------------
      // Step 7: Verify enrollment via API
      // -----------------------------------------------------------------
      const verifyResponse = await fetch(`${baseUrl}/alpha/verify`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      expect(verifyResponse.ok).toBe(true);
      const verifyBody = (await verifyResponse.json()) as Record<string, unknown>;
      expect(verifyBody.enrolled).toBe(true);
    },
    { timeout: 30_000 },
  );
});
