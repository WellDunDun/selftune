import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { platformCredentialStore } from "@selftune/runtime/credential-store";

const configRoot = mkdtempSync(join(tmpdir(), "selftune-credential-smoke-"));
const account = `credential-smoke:${process.pid}:${Date.now()}`;
const secret = `selftune-smoke-${crypto.randomUUID()}`;
let reference: ReturnType<typeof platformCredentialStore.set> | null = null;

try {
  reference = platformCredentialStore.set(account, secret, configRoot);
  const loaded = platformCredentialStore.get(reference, configRoot);
  if (loaded !== secret) throw new Error(`Credential round trip failed for ${reference.provider}.`);
  console.log(`SelfTune credential smoke test passed with ${reference.provider}.`);
} finally {
  if (reference) platformCredentialStore.delete(reference, configRoot);
  rmSync(configRoot, { recursive: true, force: true });
}
