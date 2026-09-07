import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ossRoot = resolve(import.meta.dir, "../..");

function fixture(
  script: string,
  run: (root: string, command: string) => void,
  options: { readonly withDependencies?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "selftune-build-metadata-"));
  try {
    const command = join(root, "scripts", "run.ts");
    mkdirSync(dirname(command));
    if (options.withDependencies !== false) {
      symlinkSync(join(ossRoot, "node_modules"), join(root, "node_modules"));
    }
    writeFileSync(command, readFileSync(join(ossRoot, script)));
    run(root, command);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("version stamping is dependency-free and rejects malformed manifests before changing the skill", () => {
  fixture(
    "scripts/sync-skill-version.ts",
    (root, command) => {
      mkdirSync(join(root, "skill"));
      const skill = join(root, "skill", "SKILL.md");
      const initial = "---\nname: example\nversion: 1.0.0\n---\n# Skill\n";
      const runStamp = () => Bun.spawnSync([process.execPath, "--no-install", command]);
      writeFileSync(skill, initial);
      for (const version of [null, 123, " ", ""]) {
        writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
        const result = runStamp();
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain("must be a non-empty string");
        expect(readFileSync(skill, "utf8")).toBe(initial);
      }
      writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.0.1" }));
      expect(runStamp().exitCode).toBe(0);
      expect(readFileSync(skill, "utf8")).toBe(initial.replace("1.0.0", "2.0.1"));
      expect(runStamp().exitCode).toBe(0);
      expect(readFileSync(skill, "utf8")).toBe(initial.replace("1.0.0", "2.0.1"));
    },
    { withDependencies: false },
  );
});

test("migration embedding preserves exact journal and SQL bytes", () => {
  fixture("packages/local-store/scripts/embed-drizzle-migrations.ts", (root, command) => {
    const migrations = join(root, "src", "drizzle");
    mkdirSync(join(migrations, "meta"), { recursive: true });
    const journal = '{"entries":[{"tag":"001_init"}],"dialect":"sqlite"}';
    const sql = "CREATE TABLE example (value TEXT);\n";
    writeFileSync(join(migrations, "meta", "_journal.json"), journal);
    writeFileSync(join(migrations, "001_init.sql"), sql);
    expect(Bun.spawnSync([process.execPath, command]).exitCode).toBe(0);
    const generated = readFileSync(join(root, "src", "embedded-migrations.gen.ts"), "utf8");
    expect(generated).toContain(JSON.stringify(journal));
    expect(generated).toContain(JSON.stringify(sql));
    writeFileSync(join(migrations, "meta", "_journal.json"), '{"entries":[{"tag":42}]}');
    expect(Bun.spawnSync([process.execPath, command]).exitCode).not.toBe(0);
    expect(readFileSync(join(root, "src", "embedded-migrations.gen.ts"), "utf8")).toBe(generated);
  });
});
