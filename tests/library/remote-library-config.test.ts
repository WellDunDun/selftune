import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultSyncPreferences } from "@selftune/control-plane";
import { writeConfigSync } from "@selftune/config";

import type { PlatformCredentialStore } from "../../packages/runtime/credential-store";
import {
  activateCloudRemoteLibraryConfig,
  loadRemoteLibraryConfig,
  remoteLibrarySettings,
  saveRemoteLibraryConfig,
  storedRemoteLibraryCredential,
  updateRemoteLibraryConfig,
} from "../../packages/runtime/remote-library-config";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.SELFTUNE_REMOTE_LIBRARY_URL;
  delete process.env.SELFTUNE_REMOTE_LIBRARY_API_KEY;
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "selftune-remote-config-"));
  roots.push(root);
  return root;
}

function memoryCredentialStore(): PlatformCredentialStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    set(account, value) {
      values.set(account, value);
      return { provider: "macos-keychain", account };
    },
    get(reference) {
      return values.get(reference.account) ?? null;
    },
    delete(reference) {
      values.delete(reference.account);
    },
  };
}

function writeLinkedAlphaConfig(
  root: string,
  store: PlatformCredentialStore,
  apiKey = "linked-alpha-secret",
): ReturnType<PlatformCredentialStore["set"]> {
  const credential = store.set("alpha-linked", apiKey, root);
  writeConfigSync(join(root, "config.json"), {
    agent_type: "claude_code",
    cli_path: "/test/selftune",
    llm_mode: "agent",
    agent_cli: "claude",
    hooks_installed: true,
    initialized_at: "2026-07-18T00:00:00.000Z",
    alpha: {
      enrolled: true,
      user_id: "local-user",
      cloud_user_id: "cloud-user",
      cloud_org_id: "cloud-org",
      consent_timestamp: "2026-07-18T00:00:00.000Z",
      credential,
    },
  });
  return credential;
}

describe("Remote Library credential storage", () => {
  it("derives Sync & Backup config from a linked cloud account", () => {
    const root = temporaryRoot();
    const store = memoryCredentialStore();
    writeLinkedAlphaConfig(root, store);

    expect(loadRemoteLibraryConfig(root, { credentialStore: store })).toMatchObject({
      version: 2,
      url: "https://api.selftune.dev",
      apiKey: "linked-alpha-secret",
      preferences: defaultSyncPreferences,
      credentialProvider: "macos-keychain",
    });
    expect(remoteLibrarySettings(root, { credentialStore: store })).toMatchObject({
      configured: true,
      url: "https://api.selftune.dev",
    });
  });

  it("uses the linked account cloud URL override", () => {
    const root = temporaryRoot();
    const store = memoryCredentialStore();
    const credential = writeLinkedAlphaConfig(root, store);
    writeConfigSync(join(root, "config.json"), {
      agent_type: "claude_code",
      cli_path: "/test/selftune",
      llm_mode: "agent",
      agent_cli: "claude",
      hooks_installed: true,
      initialized_at: "2026-07-18T00:00:00.000Z",
      alpha: {
        enrolled: true,
        user_id: "local-user",
        cloud_api_url: "https://cloud.example.test/",
        consent_timestamp: "2026-07-18T00:00:00.000Z",
        credential,
      },
    });

    expect(loadRemoteLibraryConfig(root, { credentialStore: store }).url).toBe(
      "https://cloud.example.test",
    );
  });

  it("reports linked file-store accounts as configured through the default settings path", () => {
    const root = temporaryRoot();
    writeFileSync(
      join(root, "credential-store.json"),
      JSON.stringify({ "alpha-file": "linked-file-secret" }),
    );
    writeConfigSync(join(root, "config.json"), {
      agent_type: "claude_code",
      cli_path: "/test/selftune",
      llm_mode: "agent",
      agent_cli: "claude",
      hooks_installed: true,
      initialized_at: "2026-07-18T00:00:00.000Z",
      alpha: {
        enrolled: true,
        user_id: "local-user",
        consent_timestamp: "2026-07-18T00:00:00.000Z",
        credential: { provider: "file", account: "alpha-file" },
      },
    });

    expect(remoteLibrarySettings(root)).toMatchObject({
      configured: true,
      url: "https://api.selftune.dev",
      credential_provider: "file",
    });
  });

  it("prefers an explicit Remote Library config over the linked account", () => {
    const root = temporaryRoot();
    const store = memoryCredentialStore();
    writeLinkedAlphaConfig(root, store);
    saveRemoteLibraryConfig(
      {
        url: "https://explicit.example.test",
        apiKey: "explicit-secret",
        preferences: defaultSyncPreferences,
      },
      root,
      { credentialStore: store },
    );

    expect(loadRemoteLibraryConfig(root, { credentialStore: store })).toMatchObject({
      url: "https://explicit.example.test",
      apiKey: "explicit-secret",
    });
  });

  it("switches from self-hosted credentials to the linked Cloud account without copying its key", () => {
    const root = temporaryRoot();
    const store = memoryCredentialStore();
    const alphaCredential = writeLinkedAlphaConfig(root, store);
    saveRemoteLibraryConfig(
      {
        url: "https://selfhost.example.test",
        apiKey: "selfhost-secret",
        preferences: defaultSyncPreferences,
      },
      root,
      { credentialStore: store },
    );
    const selfHostedCredential = storedRemoteLibraryCredential(root);
    const preferences = { ...defaultSyncPreferences, drafts: true };

    const cloud = activateCloudRemoteLibraryConfig(preferences, root, {
      credentialStore: store,
    });

    expect(cloud).toMatchObject({
      url: "https://api.selftune.dev",
      apiKey: "linked-alpha-secret",
      preferences,
    });
    expect(storedRemoteLibraryCredential(root)).toBeNull();
    expect(store.get(alphaCredential, root)).toBe("linked-alpha-secret");
    expect(selfHostedCredential && store.get(selfHostedCredential, root)).toBeNull();
    expect(readFileSync(join(root, "cloud-remote-library.json"), "utf8")).not.toContain(
      "linked-alpha-secret",
    );
  });

  it("does not reuse a Cloud account credential for a new self-hosted destination", () => {
    const root = temporaryRoot();
    const store = memoryCredentialStore();
    writeLinkedAlphaConfig(root, store);

    expect(() =>
      updateRemoteLibraryConfig(
        {
          url: "https://selfhost.example.test",
          preferences: defaultSyncPreferences,
        },
        root,
        { credentialStore: store },
      ),
    ).toThrow("API key is required");
    expect(storedRemoteLibraryCredential(root)).toBeNull();
    expect([...store.values.values()]).toEqual(["linked-alpha-secret"]);
  });

  it("returns to not configured when the alpha identity is removed", () => {
    const root = temporaryRoot();
    const store = memoryCredentialStore();
    writeLinkedAlphaConfig(root, store);
    writeConfigSync(join(root, "config.json"), {
      agent_type: "claude_code",
      cli_path: "/test/selftune",
      llm_mode: "agent",
      agent_cli: "claude",
      hooks_installed: true,
      initialized_at: "2026-07-18T00:00:00.000Z",
    });

    expect(() => loadRemoteLibraryConfig(root, { credentialStore: store })).toThrow(
      "not configured",
    );
  });

  it("explicit config save and removal leave the alpha credential untouched", () => {
    const root = temporaryRoot();
    const store = memoryCredentialStore();
    const alphaCredential = writeLinkedAlphaConfig(root, store);
    saveRemoteLibraryConfig(
      {
        url: "https://explicit.example.test",
        apiKey: "explicit-secret",
        preferences: defaultSyncPreferences,
      },
      root,
      { credentialStore: store },
    );
    const explicitCredential = storedRemoteLibraryCredential(root);

    expect(store.get(alphaCredential, root)).toBe("linked-alpha-secret");
    if (!explicitCredential) throw new Error("Expected an explicit credential reference.");
    store.delete(explicitCredential, root);
    rmSync(join(root, "remote-library.json"));
    expect(store.get(alphaCredential, root)).toBe("linked-alpha-secret");
    expect(loadRemoteLibraryConfig(root, { credentialStore: store }).apiKey).toBe(
      "linked-alpha-secret",
    );
  });

  it("persists only a credential reference in remote-library.json", () => {
    const root = temporaryRoot();
    const store = memoryCredentialStore();
    const saved = saveRemoteLibraryConfig(
      {
        url: "https://library.example.test/",
        apiKey: "device-secret-value",
        preferences: defaultSyncPreferences,
      },
      root,
      { credentialStore: store },
    );

    const contents = readFileSync(join(root, "remote-library.json"), "utf8");
    expect(contents).not.toContain("device-secret-value");
    expect(contents).toContain('"version": 2');
    expect(contents).toContain('"provider": "macos-keychain"');
    expect(saved.credentialProvider).toBe("macos-keychain");
    expect(loadRemoteLibraryConfig(root, { credentialStore: store }).apiKey).toBe(
      "device-secret-value",
    );
  });

  it("migrates a version-one plaintext key on first read", () => {
    const root = temporaryRoot();
    const store = memoryCredentialStore();
    writeFileSync(
      join(root, "remote-library.json"),
      JSON.stringify({
        version: 1,
        url: "https://library.example.test",
        apiKey: "legacy-device-secret",
        preferences: defaultSyncPreferences,
      }),
    );

    const loaded = loadRemoteLibraryConfig(root, { credentialStore: store });
    const reference = storedRemoteLibraryCredential(root);
    expect(loaded.apiKey).toBe("legacy-device-secret");
    expect(reference?.provider).toBe("macos-keychain");
    expect(readFileSync(join(root, "remote-library.json"), "utf8")).not.toContain(
      "legacy-device-secret",
    );
  });

  it("keeps headless credentials environment-only", () => {
    const root = temporaryRoot();
    const loaded = loadRemoteLibraryConfig(root, {
      environment: {
        url: "https://selfhost.example.test/",
        apiKey: "headless-secret",
      },
    });
    expect(loaded).toMatchObject({
      url: "https://selfhost.example.test",
      apiKey: "headless-secret",
      credentialProvider: "environment",
    });
    expect(storedRemoteLibraryCredential(root)).toBeNull();
  });

  it("fails closed when the credential reference no longer resolves", () => {
    const root = temporaryRoot();
    const store = memoryCredentialStore();
    saveRemoteLibraryConfig(
      {
        url: "https://library.example.test",
        apiKey: "temporary-secret",
        preferences: defaultSyncPreferences,
      },
      root,
      { credentialStore: store },
    );
    const reference = storedRemoteLibraryCredential(root);
    if (!reference) throw new Error("Expected a stored credential reference.");
    store.delete(reference, root);
    expect(() => loadRemoteLibraryConfig(root, { credentialStore: store })).toThrow(
      "credentials are missing",
    );
  });

  it("validates the URL before rotating the credential", () => {
    const root = temporaryRoot();
    const store = memoryCredentialStore();
    saveRemoteLibraryConfig(
      {
        url: "https://library.example.test",
        apiKey: "working-secret",
        preferences: defaultSyncPreferences,
      },
      root,
      { credentialStore: store },
    );
    const before = storedRemoteLibraryCredential(root);

    expect(() =>
      saveRemoteLibraryConfig(
        {
          url: `https://${"USERNAME_PLACEHOLDER"}:${"PASSWORD_PLACEHOLDER"}@library.example.test`,
          apiKey: "replacement-secret",
          preferences: defaultSyncPreferences,
        },
        root,
        { credentialStore: store },
      ),
    ).toThrow("must not contain embedded credentials");

    expect(storedRemoteLibraryCredential(root)).toEqual(before);
    expect(loadRemoteLibraryConfig(root, { credentialStore: store }).apiKey).toBe("working-secret");
    expect([...store.values.values()]).toEqual(["working-secret"]);
  });

  it("rejects multiline credentials before writing to the platform vault", () => {
    const root = temporaryRoot();
    const store = memoryCredentialStore();
    expect(() =>
      saveRemoteLibraryConfig(
        {
          url: "https://library.example.test",
          apiKey: "first-line\nsecond-line",
          preferences: defaultSyncPreferences,
        },
        root,
        { credentialStore: store },
      ),
    ).toThrow("must be a single line");
    expect(store.values.size).toBe(0);
  });

  it("removes the staged credential when the config write fails", () => {
    const root = temporaryRoot();
    const store = memoryCredentialStore();
    saveRemoteLibraryConfig(
      {
        url: "https://library.example.test",
        apiKey: "working-secret",
        preferences: defaultSyncPreferences,
      },
      root,
      { credentialStore: store },
    );
    const before = storedRemoteLibraryCredential(root);

    expect(() =>
      saveRemoteLibraryConfig(
        {
          url: "https://replacement.example.test",
          apiKey: "replacement-secret",
          preferences: defaultSyncPreferences,
        },
        root,
        {
          credentialStore: store,
          writeConfig: () => {
            throw new Error("simulated disk failure");
          },
        },
      ),
    ).toThrow("simulated disk failure");

    expect(storedRemoteLibraryCredential(root)).toEqual(before);
    expect(loadRemoteLibraryConfig(root, { credentialStore: store }).apiKey).toBe("working-secret");
    expect([...store.values.values()]).toEqual(["working-secret"]);
  });

  it("rolls back the config when the previous vault entry cannot be removed", () => {
    const root = temporaryRoot();
    const store = memoryCredentialStore();
    saveRemoteLibraryConfig(
      {
        url: "https://library.example.test",
        apiKey: "working-secret",
        preferences: defaultSyncPreferences,
      },
      root,
      { credentialStore: store },
    );
    const before = storedRemoteLibraryCredential(root);
    if (!before) throw new Error("Expected an existing credential.");
    const failingStore: PlatformCredentialStore = {
      set: store.set,
      get: store.get,
      delete(reference, configRoot) {
        if (reference.account === before.account) throw new Error("vault delete failed");
        store.delete(reference, configRoot);
      },
    };

    expect(() =>
      saveRemoteLibraryConfig(
        {
          url: "https://replacement.example.test",
          apiKey: "replacement-secret",
          preferences: defaultSyncPreferences,
        },
        root,
        { credentialStore: failingStore },
      ),
    ).toThrow("vault delete failed");

    expect(storedRemoteLibraryCredential(root)).toEqual(before);
    expect(loadRemoteLibraryConfig(root, { credentialStore: store }).apiKey).toBe("working-secret");
    expect([...store.values.values()]).toEqual(["working-secret"]);
  });
});
