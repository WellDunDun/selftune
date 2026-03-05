#!/usr/bin/env bun
/**
 * Structural linter enforcing selftune architecture rules.
 *
 * Checks:
 * 1. Hook modules must not import from grading/eval/evolution/monitoring modules
 * 2. Ingestor modules must not import from grading/eval/evolution/monitoring modules
 * 3. Evolution modules must not import from hooks/ingestors
 * 4. Monitoring modules must not import from hooks/ingestors
 */

import { readdirSync, readFileSync } from "node:fs";
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
const EVAL_FILES = new Set([
  "baseline.ts",
  "composability.ts",
  "composability-cli.ts",
  "unit-test.ts",
  "import-skillsbench.ts",
  "generate-unit-tests.ts",
  "unit-test-cli.ts",
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

export function findTsFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findTsFiles(path));
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push(path);
      }
    }
  } catch {
    // directory doesn't exist
  }
  return files;
}

if (import.meta.main) {
  const violations: string[] = [];
  for (const file of findTsFiles("cli/selftune").sort()) {
    violations.push(...checkFile(file));
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
