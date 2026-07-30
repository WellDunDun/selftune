import { _setTestDb, openDb } from "../../../packages/runtime/localdb/db.js";
import {
  writeEvolutionAuditToDb,
  writeQueryToDb,
} from "../../../packages/runtime/localdb/direct-write.js";
import {
  cliMain as autoActivateCliMain,
  runAutoActivateHook,
} from "../../../packages/harnesses/claude-code/src/hooks/auto-activate.js";
import {
  cliMain as evolutionGuardCliMain,
  runEvolutionGuardHook,
} from "../../../packages/harnesses/claude-code/src/hooks/evolution-guard.js";
import type { HookExecutionResult } from "../../../packages/harnesses/claude-code/src/hooks/execution-result.js";

async function captureCli(
  cliMain: (stdinText: string) => Promise<number>,
  rawStdin: string,
): Promise<HookExecutionResult> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { exit_code: await cliMain(rawStdin), stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

_setTestDb(openDb(":memory:"));

for (const sessionId of ["auto-result", "auto-cli"]) {
  for (let index = 0; index < 3; index += 1) {
    writeQueryToDb({
      timestamp: new Date(index).toISOString(),
      session_id: sessionId,
      query: `query ${index}`,
    });
  }
}

const autoAllowRaw = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "empty" });
const autoResultRaw = JSON.stringify({
  hook_event_name: "UserPromptSubmit",
  session_id: "auto-result",
});
const autoCliRaw = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "auto-cli" });

const autoAllow = await runAutoActivateHook(autoAllowRaw);
const autoAllowCli = await captureCli(autoActivateCliMain, autoAllowRaw);
const autoSuggestion = await runAutoActivateHook(autoResultRaw);
const autoSuggestionCli = await captureCli(autoActivateCliMain, autoCliRaw);

const evolutionAllowRaw = JSON.stringify({
  hook_event_name: "PreToolUse",
  session_id: "evolution-allow",
  tool_name: "Read",
  tool_input: { file_path: "/skills/pdf/SKILL.md" },
});
const evolutionBlockRaw = JSON.stringify({
  hook_event_name: "PreToolUse",
  session_id: "evolution-block",
  tool_name: "Write",
  tool_input: { file_path: "/skills/pdf/SKILL.md" },
});

const evolutionAllow = await runEvolutionGuardHook(evolutionAllowRaw);
const evolutionAllowCli = await captureCli(evolutionGuardCliMain, evolutionAllowRaw);
writeEvolutionAuditToDb({
  timestamp: new Date().toISOString(),
  proposal_id: "hook-result-proof",
  action: "deployed",
  details: "test",
  skill_name: "pdf",
});
const evolutionBlock = await runEvolutionGuardHook(evolutionBlockRaw);
const evolutionBlockCli = await captureCli(evolutionGuardCliMain, evolutionBlockRaw);

process.stdout.write(
  JSON.stringify({
    autoAllow,
    autoAllowCli,
    autoSuggestion,
    autoSuggestionCli,
    evolutionAllow,
    evolutionAllowCli,
    evolutionBlock,
    evolutionBlockCli,
  }),
);
