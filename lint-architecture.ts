#!/usr/bin/env bun
/**
 * Structural linter enforcing selftune architecture rules.
 *
 * Checks:
 * 1. Hook modules must not import from grading/eval/evolution/monitoring modules
 * 2. Ingestor modules must not import from grading/eval/evolution/monitoring modules
 * 3. Evolution modules must not import from hooks/ingestors
 * 4. Monitoring modules must not import from hooks/ingestors
 * 5. Applications must consume runtime behavior through package exports
 * 6. Runtime, harness, and orchestration packages must follow dependency direction
 * 7. Tests must not execute implementation files removed from the compatibility tree
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const HOOK_FILES = new Set(["prompt-log.ts", "session-stop.ts", "skill-eval.ts"]);
const INGESTOR_FILES = new Set([
  "codex-wrapper.ts",
  "codex-rollout.ts",
  "opencode-ingest.ts",
  "claude-replay.ts",
]);
const EVOLUTION_FILES = new Set([
  "extract-patterns.ts",
  "propose-description.ts",
  "validate-proposal.ts",
  "audit.ts",
  "evolve.ts",
  "deploy-proposal.ts",
  "rollback.ts",
  "stopping-criteria.ts",
  "propose-routing.ts",
  "propose-body.ts",
  "validate-body.ts",
  "validate-routing.ts",
  "refine-body.ts",
  "evolve-body.ts",
]);
const MONITORING_FILES = new Set(["watch.ts"]);
const CONTRIBUTE_FILES = new Set(["contribute.ts", "sanitize.ts", "bundle.ts"]);
const BADGE_FILES = new Set(["badge.ts", "badge-data.ts", "badge-svg.ts"]);
const EVAL_FILES = new Set([
  "baseline.ts",
  "composability.ts",
  "unit-test.ts",
  "import-skillsbench.ts",
]);

/** Original forbidden imports for hooks/ingestors (grading & eval). */
const FORBIDDEN_IMPORTS = ["grade-session", "hooks-to-evals", "/grading/", "/eval/"];

/** Hooks and ingestors also must not reach into evolution, monitoring, or contribute. */
const HOOK_INGESTOR_FORBIDDEN = [
  ...FORBIDDEN_IMPORTS,
  "/evolution/",
  "/monitoring/",
  "/contribute/",
];

/** Evolution modules must not import from hooks or ingestors (by path or by name). */
const EVOLUTION_FORBIDDEN = [
  "/hooks/",
  "/ingestors/",
  "prompt-log",
  "session-stop",
  "skill-eval",
  "codex-wrapper",
  "codex-rollout",
  "opencode-ingest",
  "claude-replay",
];

/** Monitoring modules must not import from hooks or ingestors (by path or by name). */
const MONITORING_FORBIDDEN = [
  "/hooks/",
  "/ingestors/",
  "prompt-log",
  "session-stop",
  "skill-eval",
  "codex-wrapper",
  "codex-rollout",
  "opencode-ingest",
  "claude-replay",
];

/** Eval modules must not import from hooks/ingestors/grading/evolution/monitoring. */
const EVAL_FORBIDDEN = [
  "/hooks/",
  "/ingestors/",
  "/grading/",
  "/evolution/",
  "/monitoring/",
  "prompt-log",
  "session-stop",
  "skill-eval",
  "codex-wrapper",
  "codex-rollout",
  "opencode-ingest",
  "claude-replay",
  "grade-session",
];

/** Contribute modules must not import from hooks/ingestors/grading/evolution/monitoring. */
const CONTRIBUTE_FORBIDDEN = [
  "/hooks/",
  "/ingestors/",
  "/grading/",
  "/evolution/",
  "/monitoring/",
  "prompt-log",
  "session-stop",
  "skill-eval",
  "codex-wrapper",
  "codex-rollout",
  "opencode-ingest",
  "claude-replay",
  "grade-session",
];

/** Badge modules must not import from hooks, ingestors, grading, evolution, monitoring, or contribute. */
const BADGE_FORBIDDEN = [
  "/hooks/",
  "/ingestors/",
  "/grading/",
  "/evolution/",
  "/monitoring/",
  "/contribute/",
  "prompt-log",
  "session-stop",
  "skill-eval",
  "codex-wrapper",
  "codex-rollout",
  "opencode-ingest",
  "claude-replay",
  "grade-session",
  "hooks-to-evals",
];

export function checkFile(filepath: string): string[] {
  const violations: string[] = [];
  const name = basename(filepath);

  let forbidden: string[] | null = null;

  if (HOOK_FILES.has(name) || INGESTOR_FILES.has(name)) {
    forbidden = HOOK_INGESTOR_FORBIDDEN;
  } else if (EVOLUTION_FILES.has(name)) {
    forbidden = EVOLUTION_FORBIDDEN;
  } else if (MONITORING_FILES.has(name)) {
    forbidden = MONITORING_FORBIDDEN;
  } else if (CONTRIBUTE_FILES.has(name)) {
    forbidden = CONTRIBUTE_FORBIDDEN;
  } else if (BADGE_FILES.has(name)) {
    forbidden = BADGE_FORBIDDEN;
  } else if (EVAL_FILES.has(name)) {
    forbidden = EVAL_FORBIDDEN;
  }

  if (!forbidden) return violations;

  const content = readFileSync(filepath, "utf-8");
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("import")) continue;

    for (const pattern of forbidden) {
      if (line.includes(pattern)) {
        violations.push(
          `${filepath}:${i + 1}: imports '${pattern}' (violates dependency direction)`,
        );
      }
    }
  }

  return violations;
}

export function findTsFiles(dir: string, includeTests = false): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findTsFiles(path, includeTests));
      } else if (entry.name.endsWith(".ts") && (includeTests || !entry.name.endsWith(".test.ts"))) {
        files.push(path);
      }
    }
  } catch {
    // directory doesn't exist
  }
  return files;
}

function checkLegacyImplementationReferences(root: string): string[] {
  const violations: string[] = [];
  const legacyPathPattern = /cli\/selftune\/([A-Za-z0-9_./-]+\.(?:js|ts))/g;

  for (const file of findTsFiles(root, true).sort()) {
    const content = readFileSync(file, "utf-8");
    for (const [index, sourceLine] of content.split("\n").entries()) {
      const line = sourceLine.trim();
      if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;

      for (const match of line.matchAll(legacyPathPattern)) {
        const relativePath = match[1]?.replace(/\.js$/, ".ts");
        if (!relativePath || relativePath === "other/file.ts") continue;
        if (existsSync(join("cli/selftune", relativePath))) continue;
        violations.push(
          `${file}:${index + 1}: references removed legacy implementation 'cli/selftune/${relativePath}'`,
        );
      }
    }
  }

  return violations;
}

function checkPackageBoundary(root: string, forbiddenImports: ReadonlyArray<string>): string[] {
  const violations: string[] = [];
  for (const file of findTsFiles(root).sort()) {
    const content = readFileSync(file, "utf-8");
    for (const [index, line] of content.split("\n").entries()) {
      if (!line.includes("import") && !line.includes("export")) continue;
      for (const forbiddenImport of forbiddenImports) {
        if (line.includes(forbiddenImport)) {
          violations.push(
            `${file}:${index + 1}: imports '${forbiddenImport}' across a forbidden package boundary`,
          );
        }
      }
    }
  }
  return violations;
}

if (import.meta.main) {
  const violations: string[] = [];
  for (const file of findTsFiles("packages/runtime").sort()) {
    violations.push(...checkFile(file));
  }
  violations.push(
    ...checkPackageBoundary("packages/runtime", [
      "@selftune/harness-",
      "@selftune/orchestration",
      "@selftune/local",
    ]),
    ...checkPackageBoundary("packages/harnesses/core", [
      "@selftune/runtime",
      "@selftune/harness-claude-code",
      "@selftune/orchestration",
      "@selftune/local",
    ]),
    ...checkPackageBoundary("packages/harnesses", ["@selftune/orchestration", "@selftune/local"]),
    ...checkPackageBoundary("packages/orchestration", ["@selftune/local"]),
    ...checkLegacyImplementationReferences("tests"),
  );
  for (const appRoot of ["apps/cli", "apps/desktop", "apps/local-dashboard", "apps/selfhost"]) {
    for (const file of findTsFiles(appRoot).sort()) {
      const content = readFileSync(file, "utf-8");
      for (const [index, line] of content.split("\n").entries()) {
        if (
          line.includes("cli/selftune") ||
          line.includes("../../packages/runtime") ||
          line.includes("../../packages/harnesses") ||
          line.includes("../../packages/orchestration")
        ) {
          violations.push(`${file}:${index + 1}: bypasses workspace package exports`);
        }
      }
    }
  }
  if (violations.length > 0) {
    console.log("Architecture violations found:");
    for (const v of violations) {
      console.log(`  ${v}`);
    }
    process.exit(1);
  } else {
    console.log("No architecture violations found.");
    process.exit(0);
  }
}
