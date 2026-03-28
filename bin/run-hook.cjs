#!/usr/bin/env node
/**
 * Hook runner — executes a TypeScript hook script with bun or tsx fallback.
 *
 * Usage: node run-hook.cjs <path-to-hook.ts>
 *
 * Stdin is piped through to the hook script (Claude Code sends JSON on stdin).
 * Exit code is propagated from the hook. If no TS runtime is found, exits 0
 * (fail-open: hooks must never block Claude).
 */

const { execFileSync } = require("child_process");
const hookScript = process.argv[2];

if (!hookScript) {
  // No script specified — fail-open
  process.exit(0);
}

const runners = [
  ["bun", ["run", hookScript]],
  ["npx", ["tsx", hookScript]],
];

for (const [cmd, args] of runners) {
  try {
    execFileSync(cmd, args, { stdio: "inherit" });
    process.exit(0);
  } catch (e) {
    // Runner exits non-zero → propagate (hook wants to block or signal)
    if (e.status != null) {
      process.exit(e.status);
    }
    // Runner not found (ENOENT) → try next
  }
}

// No runtime found — fail-open (hooks must never block Claude)
process.exit(0);
