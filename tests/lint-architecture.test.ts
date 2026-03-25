import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkFile, findTsFiles } from "../lint-architecture.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lint-arch-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper: write a temp file with given name and content, return full path. */
function writeTempFile(name: string, content: string): string {
  const filepath = join(tmpDir, name);
  writeFileSync(filepath, content, "utf-8");
  return filepath;
}

// ---------------------------------------------------------------------------
// Hook files: must NOT import from evolution or monitoring
// ---------------------------------------------------------------------------

describe("hook files", () => {
  test("importing from evolution directory is a violation", () => {
    const fp = writeTempFile("prompt-log.ts", `import { evolve } from "../evolution/evolve.js";\n`);
    const violations = checkFile(fp);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("/evolution/");
  });

  test("importing from monitoring directory is a violation", () => {
    const fp = writeTempFile(
      "session-stop.ts",
      `import { watch } from "../monitoring/watch.js";\n`,
    );
    const violations = checkFile(fp);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("/monitoring/");
  });

  test("importing from grading is still a violation", () => {
    const fp = writeTempFile(
      "skill-eval.ts",
      `import { grade } from "../grading/grade-session.js";\n`,
    );
    const violations = checkFile(fp);
    expect(violations.length).toBeGreaterThan(0);
    // The import matches both "grade-session" and "/grading/" patterns
    expect(violations.some((v) => v.includes("grade-session") || v.includes("/grading/"))).toBe(
      true,
    );
  });

  test("clean hook file has no violations", () => {
    const fp = writeTempFile(
      "prompt-log.ts",
      `import { join } from "node:path";\nimport { readFile } from "node:fs";\n`,
    );
    const violations = checkFile(fp);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ingestor files: must NOT import from evolution or monitoring
// ---------------------------------------------------------------------------

describe("ingestor files", () => {
  test("importing from evolution directory is a violation", () => {
    const fp = writeTempFile(
      "codex-wrapper.ts",
      `import { propose } from "../evolution/propose-description.js";\n`,
    );
    const violations = checkFile(fp);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("/evolution/");
  });

  test("importing from monitoring directory is a violation", () => {
    const fp = writeTempFile(
      "codex-rollout.ts",
      `import { watch } from "../monitoring/watch.js";\n`,
    );
    const violations = checkFile(fp);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("/monitoring/");
  });

  test("clean ingestor file has no violations", () => {
    const fp = writeTempFile("opencode-ingest.ts", `import { readFileSync } from "node:fs";\n`);
    const violations = checkFile(fp);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Evolution files: may import grading/eval, must NOT import hooks/ingestors
// ---------------------------------------------------------------------------

describe("evolution files", () => {
  test("importing from hooks directory is a violation", () => {
    const fp = writeTempFile(
      "extract-patterns.ts",
      `import { log } from "../hooks/prompt-log.js";\n`,
    );
    const violations = checkFile(fp);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("/hooks/");
  });

  test("importing from ingestors directory is a violation", () => {
    const fp = writeTempFile(
      "propose-description.ts",
      `import { ingest } from "../ingestors/codex-wrapper.js";\n`,
    );
    const violations = checkFile(fp);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("/ingestors/");
  });

  test("importing specific hook module name is a violation", () => {
    const fp = writeTempFile(
      "validate-proposal.ts",
      `import { stop } from "../session-stop.js";\n`,
    );
    const violations = checkFile(fp);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("session-stop");
  });

  test("importing specific ingestor module name is a violation", () => {
    const fp = writeTempFile("audit.ts", `import { wrap } from "../codex-wrapper.js";\n`);
    const violations = checkFile(fp);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("codex-wrapper");
  });

  test("importing from grading is allowed (no violation)", () => {
    const fp = writeTempFile(
      "evolve.ts",
      `import { gradeSession } from "../grading/grade-session.js";\n`,
    );
    const violations = checkFile(fp);
    expect(violations).toEqual([]);
  });

  test("importing from eval is allowed (no violation)", () => {
    const fp = writeTempFile(
      "deploy-proposal.ts",
      `import { hooksToEvals } from "../eval/hooks-to-evals.js";\n`,
    );
    const violations = checkFile(fp);
    expect(violations).toEqual([]);
  });

  test("clean evolution file has no violations", () => {
    const fp = writeTempFile(
      "stopping-criteria.ts",
      `import { readFileSync } from "node:fs";\nimport { join } from "node:path";\n`,
    );
    const violations = checkFile(fp);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Monitoring files: may import evolution/shared, must NOT import hooks/ingestors
// ---------------------------------------------------------------------------

describe("monitoring files", () => {
  test("importing from hooks directory is a violation", () => {
    const fp = writeTempFile("watch.ts", `import { log } from "../hooks/prompt-log.js";\n`);
    const violations = checkFile(fp);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("/hooks/");
  });

  test("importing from ingestors directory is a violation", () => {
    const fp = writeTempFile(
      "watch.ts",
      `import { ingest } from "../ingestors/opencode-ingest.js";\n`,
    );
    const violations = checkFile(fp);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("/ingestors/");
  });

  test("importing specific hook module name is a violation", () => {
    const fp = writeTempFile("watch.ts", `import { evalSkill } from "../skill-eval.js";\n`);
    const violations = checkFile(fp);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("skill-eval");
  });

  test("importing from evolution is allowed (no violation)", () => {
    const fp = writeTempFile("watch.ts", `import { evolve } from "../evolution/evolve.js";\n`);
    const violations = checkFile(fp);
    expect(violations).toEqual([]);
  });

  test("clean monitoring file has no violations", () => {
    const fp = writeTempFile("watch.ts", `import { readFileSync } from "node:fs";\n`);
    const violations = checkFile(fp);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findTsFiles utility
// ---------------------------------------------------------------------------

describe("findTsFiles", () => {
  test("finds .ts files recursively, excluding .test.ts files", () => {
    const dir = join(tmpDir, "findtest");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "a.ts"), "");
    writeFileSync(join(dir, "b.test.ts"), "");
    writeFileSync(join(dir, "sub", "c.ts"), "");

    const found = findTsFiles(dir);
    expect(found).toContain(join(dir, "a.ts"));
    expect(found).not.toContain(join(dir, "b.test.ts"));
    expect(found).toContain(join(dir, "sub", "c.ts"));
  });

  test("returns empty array for nonexistent directory", () => {
    const found = findTsFiles(join(tmpDir, "nonexistent"));
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unrelated files: checkFile should return no violations
// ---------------------------------------------------------------------------

describe("unrelated files", () => {
  test("random file not in any module set returns no violations", () => {
    const fp = writeTempFile(
      "constants.ts",
      `import { grade } from "../grading/grade-session.js";\nimport { evolve } from "../evolution/evolve.js";\n`,
    );
    const violations = checkFile(fp);
    expect(violations).toEqual([]);
  });
});
