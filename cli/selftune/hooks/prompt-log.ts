import { cliMain } from "@selftune/harness-claude-code/hooks/prompt-log";

process.exitCode = await cliMain();
