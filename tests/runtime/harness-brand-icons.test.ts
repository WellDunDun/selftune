import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { claudeCodePresentation } from "@selftune/harness-claude-code/descriptor";
import { clinePresentation } from "@selftune/harness-cline/descriptor";
import { codexPresentation } from "@selftune/harness-codex/descriptor";
import type { HarnessPresentationIcon } from "@selftune/harness-core/descriptor";
import { openClawPresentation } from "@selftune/harness-openclaw/descriptor";
import { openCodePresentation } from "@selftune/harness-opencode/descriptor";
import { piPresentation } from "@selftune/harness-pi/descriptor";

function decodeIcon(icon: HarnessPresentationIcon): Uint8Array {
  const separator = icon.src.indexOf(",");
  if (separator === -1) throw new Error("Harness icon is not a data URL.");

  const metadata = icon.src.slice(0, separator);
  const payload = icon.src.slice(separator + 1);
  return metadata.endsWith(";base64")
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload));
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

const authenticBrandAssets = [
  ["Claude Code", claudeCodePresentation.icon, "3b4359ea8e27b81d430bf0a21d4721342d2e74bc"],
  ["Cline", clinePresentation.icon, "db6f1d8fd14162365d2002436980460c921111f4"],
  ["Codex", codexPresentation.icon, "4fb7944d1cb44b664cfe48874f58d8b28d75d5a2"],
  ["OpenClaw", openClawPresentation.icon, "e4a3d512c1acc2fa1c4badc6a407ecc34ef29c62"],
  ["OpenCode", openCodePresentation.icon, "c4aa1c72ecff1e4d5a2a3264a956128edaf2178f"],
  ["Pi", piPresentation.icon, "89ec045f0d69190861996bc0a240a6e4e6cd48c0"],
] satisfies ReadonlyArray<readonly [string, HarnessPresentationIcon, string]>;

for (const [name, icon, expectedSha] of authenticBrandAssets) {
  test(`${name} uses the reviewed brand asset`, () => {
    expect(gitBlobSha(decodeIcon(icon))).toBe(expectedSha);
  });
}
