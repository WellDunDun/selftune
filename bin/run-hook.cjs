#!/usr/bin/env node
/**
 * Hook runner — executes a TypeScript hook script via Bun.
 *
 * Usage: node run-hook.cjs <path-to-hook.ts>
 *
 * Stdin is piped through to the hook script (Claude Code sends JSON on stdin).
 * Exit code is propagated from the hook. If bun is not found, exits 0
 * (fail-open: hooks must never block Claude).
 *
 * Note: selftune hooks depend on Bun-specific APIs (Bun.stdin.text(),
 * Bun.spawn()) and cannot run under tsx/node. The runner exists so that
 * hook commands use `node run-hook.cjs` (universally available) as the
 * entry point, avoiding a hard dependency on bun being in PATH for the
 * shell that Claude Code invokes.
 */

const { execFileSync } = require("child_process");
const hookScript = process.argv[2];

if (!hookScript) {
  // No script specified — fail-open
  process.exit(0);
}

try {
  execFileSync("bun", ["run", hookScript], { stdio: "inherit" });
  process.exit(0);
} catch (e) {
  // Hook exited non-zero → propagate (e.g. exit 2 = block in PreToolUse)
  if (e.status != null) {
    process.exit(e.status);
  }
  // bun not found (ENOENT) — fail-open
  process.exit(0);
}
