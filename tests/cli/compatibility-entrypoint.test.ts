import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each(["--help", "--version"])(
  "legacy entrypoint preserves %s output and exit status",
  (flag) => {
    const root = mkdtempSync(join(tmpdir(), "selftune-compat-entry-"));
    try {
      const cwd = join(import.meta.dir, "../..");
      const invoke = (entry: string) =>
        Bun.spawnSync([process.execPath, entry, flag], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            HOME: root,
            SELFTUNE_CONFIG_DIR: root,
            CI: "1",
            SELFTUNE_NO_ANALYTICS: "1",
          },
        });
      const canonical = invoke("apps/cli/src/main.ts");
      const compatibility = invoke("cli/selftune/index.ts");
      expect(canonical.exitCode).toBe(0);
      expect(compatibility.exitCode).toBe(canonical.exitCode);
      expect(new TextDecoder().decode(compatibility.stdout)).toBe(
        new TextDecoder().decode(canonical.stdout),
      );
      expect(new TextDecoder().decode(compatibility.stderr)).toBe(
        new TextDecoder().decode(canonical.stderr),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
