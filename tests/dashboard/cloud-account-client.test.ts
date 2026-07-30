import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { desktopCloudClientId } from "../../apps/local/src/cloud-account-client.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "selftune-desktop-client-"));
  roots.push(root);
  return root;
}

describe("Desktop Cloud client identity", () => {
  test("is stable for one installation and unique across installations", () => {
    const firstRoot = temporaryRoot();
    const secondRoot = temporaryRoot();
    const first = desktopCloudClientId(firstRoot);

    expect(first).toMatch(/^selftune-desktop-[0-9a-f-]{36}$/);
    expect(desktopCloudClientId(firstRoot)).toBe(first);
    expect(desktopCloudClientId(secondRoot)).not.toBe(first);
  });
});
