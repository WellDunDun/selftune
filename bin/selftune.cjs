#!/usr/bin/env node

const { execFileSync } = require("child_process");
const { join } = require("path");

const entrypoint = join(__dirname, "..", "cli", "selftune", "index.ts");

const runners = [
  ["bun", [entrypoint, ...process.argv.slice(2)]],
  ["npx", ["tsx", entrypoint, ...process.argv.slice(2)]],
];

for (const [cmd, args] of runners) {
  try {
    execFileSync(cmd, args, { stdio: "inherit" });
    process.exit(0);
  } catch (e) {
    if (e.status != null) {
      process.exit(e.status);
    }
  }
}

console.error(
  JSON.stringify({
    error: "No TypeScript runtime found. Install bun (https://bun.sh) or tsx (npx tsx).",
  })
);
process.exit(1);
