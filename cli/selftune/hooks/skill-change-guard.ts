import { cliMain } from "@selftune/harness-claude-code/hooks/skill-change-guard";

process.exitCode = await cliMain();
