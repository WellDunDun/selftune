import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("sanitizes the real archive without changing package contents or registry dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "selftune-packed-manifest-"));
  try {
    const packageRoot = join(root, "package");
    mkdirSync(packageRoot);
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "selftune",
        dependencies: { "@selftune/runtime": "1.0.0", effect: "4.0.0-beta.66" },
        bundledDependencies: ["@selftune/runtime"],
      }),
    );
    const payload = Buffer.from([0, 1, 2, 255]);
    writeFileSync(join(packageRoot, "payload.bin"), payload);
    const archive = join(root, "package.tgz");
    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
    const manifestAfter: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      execFileSync("node", [join(import.meta.dir, "sanitize-packed-package.cjs"), archive]);
      const output = join(root, `read-${run}`);
      mkdirSync(output);
      execFileSync("tar", ["-xzf", archive, "-C", output]);
      const manifest = readFileSync(join(output, "package/package.json"), "utf8");
      manifestAfter.push(manifest);
      expect(JSON.parse(manifest)).toEqual({
        name: "selftune",
        dependencies: { effect: "4.0.0-beta.66" },
        bundledDependencies: ["@selftune/runtime"],
      });
      expect(readFileSync(join(output, "package/payload.bin"))).toEqual(payload);
    }
    expect(manifestAfter[0]).toBe(manifestAfter[1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
