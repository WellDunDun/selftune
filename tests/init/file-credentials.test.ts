import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformCredentialStore } from "../../packages/runtime/credential-store.js";

test("file credentials retain valid accounts while ignoring malformed siblings", () => {
  const root = mkdtempSync(join(tmpdir(), "selftune-file-credentials-"));
  const path = join(root, "credential-store.json");
  const reference = { provider: "file", account: "kept" } as const;
  try {
    const contents = JSON.stringify({ kept: "test-value", empty: "", broken: 42, nested: {} });
    writeFileSync(path, contents);
    expect(platformCredentialStore.get(reference, root)).toBe("test-value");
    expect(platformCredentialStore.get({ ...reference, account: "empty" }, root)).toBe("");
    expect(platformCredentialStore.get({ ...reference, account: "broken" }, root)).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(contents);
    platformCredentialStore.delete({ ...reference, account: "empty" }, root);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ kept: "test-value" });
    for (const malformed of ["null", "[]", "42", "{broken"]) {
      writeFileSync(path, malformed);
      expect(platformCredentialStore.get(reference, root)).toBeNull();
      expect(readFileSync(path, "utf8")).toBe(malformed);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
