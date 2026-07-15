import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultSyncPreferences } from "@selftune/control-plane";

import type { PlatformCredentialStore } from "../../packages/runtime/credential-store";
import {
  loadRemoteLibraryConfig,
  saveRemoteLibraryConfig,
  storedRemoteLibraryCredential,
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

describe("Remote Library credential storage", () => {
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
    process.env.SELFTUNE_REMOTE_LIBRARY_URL = "https://selfhost.example.test/";
    process.env.SELFTUNE_REMOTE_LIBRARY_API_KEY = "headless-secret";
    const loaded = loadRemoteLibraryConfig(root);
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
          url: "https://user:password@library.example.test",
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
