import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfigSync,
  writeConfigSync,
  type CredentialReference as ConfigCredentialReference,
  type SelftuneConfig,
} from "@selftune/config";
import {
  beginCloudAccountLink,
  completeCloudAccountLink,
  linkCloudAccount,
  type DeviceCodeTransport,
} from "../../packages/orchestration/src/setup/link-account.js";
import {
  resolveCloudCredential,
  type CloudCredentialDependencies,
} from "../../packages/runtime/auth/cloud-credential.js";
import type {
  AsyncPlatformCredentialStore,
  CredentialReference as RuntimeCredentialReference,
  PlatformCredentialStore,
} from "../../packages/runtime/credential-store.js";

function baseConfig(alpha?: SelftuneConfig["alpha"]): SelftuneConfig {
  return {
    agent_type: "claude_code",
    cli_path: "/test/selftune",
    llm_mode: "agent",
    agent_cli: "claude",
    hooks_installed: false,
    initialized_at: "2026-07-18T00:00:00.000Z",
    alpha,
  };
}

function approvedTransport(apiKey = "st_test_linked"): DeviceCodeTransport {
  return {
    requestDeviceCode: async () => ({
      device_code: "device-code",
      user_code: "ABCD-1234",
      verification_url: "https://example.test/device",
      expires_in: 300,
      interval: 1,
    }),
    pollDeviceCode: async () => ({
      api_key: apiKey,
      cloud_user_id: "cloud-user",
      org_id: "cloud-org",
    }),
  };
}

describe("cloud account credential ownership", () => {
  let root: string;
  let configPath: string;
  let values: Map<string, string>;
  let setCount: number;
  let store: PlatformCredentialStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "selftune-cloud-account-"));
    configPath = join(root, "config.json");
    values = new Map();
    setCount = 0;
    store = {
      set: (account, value) => {
        setCount++;
        values.set(account, value);
        return { provider: "file", account };
      },
      get: (reference) => values.get(reference.account) ?? null,
      delete: (reference) => {
        values.delete(reference.account);
      },
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("config and runtime credential references stay structurally assignable", () => {
    const runtimeReference: RuntimeCredentialReference = {
      provider: "file",
      account: "assignability",
    };
    const configReference: ConfigCredentialReference = runtimeReference;
    const roundTrip: RuntimeCredentialReference = configReference;
    expect(roundTrip).toEqual(runtimeReference);
  });

  test("approval stores only a credential reference in config", async () => {
    const result = await linkCloudAccount(
      { configPath, config: baseConfig(), email: "linked@example.test" },
      {
        credentialStore: store,
        transport: approvedTransport(),
        generateUserId: () => "local-user",
        now: () => new Date("2026-07-18T01:00:00.000Z"),
      },
    );

    expect(result.config.alpha?.credential).toBeDefined();
    expect(result.config.alpha?.api_key).toBeUndefined();
    expect(values.get(result.config.alpha?.credential?.account ?? "")).toBe("st_test_linked");
    const raw = readFileSync(configPath, "utf8");
    expect(raw).not.toContain("st_test_linked");
    expect(raw).toContain('"credential"');
  });

  test("desktop linking can start browser approval before polling and persistence", async () => {
    const transport = approvedTransport();
    const started = await beginCloudAccountLink({ transport });

    expect(started.grant.user_code).toBe("ABCD-1234");
    expect(started.verificationUrlWithCode).toContain("code=ABCD-1234");
    expect(loadConfigSync(configPath)).toBeNull();
    expect(values.size).toBe(0);

    const completed = await completeCloudAccountLink(
      { configPath, config: baseConfig() },
      started.grant,
      { credentialStore: store, transport },
    );
    expect(completed.config.alpha?.cloud_user_id).toBe("cloud-user");
    expect(values.size).toBe(1);
  });

  test("account persistence does not block the local HTTP event loop", async () => {
    const releaseWrite = Promise.withResolvers<void>();
    const writeStarted = Promise.withResolvers<void>();
    const asyncStore: AsyncPlatformCredentialStore = {
      set: async (account, value) => {
        writeStarted.resolve();
        await releaseWrite.promise;
        values.set(account, value);
        return { provider: "file", account };
      },
      delete: async (reference) => {
        values.delete(reference.account);
      },
    };

    const completion = linkCloudAccount(
      { configPath, config: baseConfig() },
      { asyncCredentialStore: asyncStore, transport: approvedTransport() },
    );
    await writeStarted.promise;

    let healthProbeAnswered = false;
    await new Promise<void>((resolveProbe) =>
      setTimeout(() => {
        healthProbeAnswered = true;
        resolveProbe();
      }, 0),
    );
    expect(healthProbeAnswered).toBeTrue();

    releaseWrite.resolve();
    const completed = await completion;
    expect(completed.config.alpha?.cloud_user_id).toBe("cloud-user");
    expect(values.get(completed.config.alpha?.credential?.account ?? "")).toBe("st_test_linked");
  });

  test("re-link preserves user_id and replaces the stored credential", async () => {
    const first = await linkCloudAccount(
      { configPath, config: baseConfig() },
      {
        credentialStore: store,
        transport: approvedTransport("st_test_first"),
        generateUserId: () => "stable-local-user",
      },
    );
    const firstReference = first.config.alpha?.credential;

    const second = await linkCloudAccount(
      { configPath, config: first.config },
      {
        credentialStore: store,
        transport: approvedTransport("st_test_second"),
        generateUserId: () => "must-not-replace",
      },
    );

    expect(second.config.alpha?.user_id).toBe("stable-local-user");
    expect(second.config.alpha?.credential).not.toEqual(firstReference);
    expect(firstReference && values.get(firstReference.account)).toBeUndefined();
    expect(values.get(second.config.alpha?.credential?.account ?? "")).toBe("st_test_second");
  });

  for (const message of ["Device code denied by user.", "Device code expired. Please retry."]) {
    test(`surfaces ${message.toLowerCase()} without persisting`, async () => {
      const transport: DeviceCodeTransport = {
        ...approvedTransport(),
        pollDeviceCode: async () => {
          throw new Error(message);
        },
      };
      await expect(
        linkCloudAccount(
          { configPath, config: baseConfig() },
          { credentialStore: store, transport },
        ),
      ).rejects.toThrow(message);
      expect(values.size).toBe(0);
      expect(loadConfigSync(configPath)).toBeNull();
    });
  }

  test("resolves a stored reference", () => {
    const reference = store.set("known", "st_test_reference", root);
    const config = baseConfig({
      enrolled: true,
      user_id: "user",
      consent_timestamp: "2026-07-18T00:00:00.000Z",
      credential: reference,
    });
    expect(resolveCloudCredential(config, { configPath, credentialStore: store })).toBe(
      "st_test_reference",
    );
  });

  test("migrates a legacy inline key once and resolves the reference thereafter", () => {
    const legacy = baseConfig({
      enrolled: true,
      user_id: "legacy-user",
      consent_timestamp: "2026-07-18T00:00:00.000Z",
      api_key: "st_test_legacy",
    });
    writeConfigSync(configPath, legacy);
    const deps: CloudCredentialDependencies = { configPath, credentialStore: store };

    expect(resolveCloudCredential(legacy, deps)).toBe("st_test_legacy");
    const migrated = loadConfigSync(configPath);
    expect(migrated?.alpha?.api_key).toBeUndefined();
    expect(migrated?.alpha?.credential).toBeDefined();
    expect(readFileSync(configPath, "utf8")).not.toContain("st_test_legacy");
    expect(setCount).toBe(1);

    expect(resolveCloudCredential(migrated, deps)).toBe("st_test_legacy");
    expect(setCount).toBe(1);
  });

  test("returns null when identity or referenced credential is missing", () => {
    expect(resolveCloudCredential(baseConfig(), { configPath, credentialStore: store })).toBeNull();
    expect(
      resolveCloudCredential(
        baseConfig({
          enrolled: true,
          user_id: "missing",
          consent_timestamp: "2026-07-18T00:00:00.000Z",
          credential: { provider: "file", account: "missing" },
        }),
        { configPath, credentialStore: store },
      ),
    ).toBeNull();
  });
});
