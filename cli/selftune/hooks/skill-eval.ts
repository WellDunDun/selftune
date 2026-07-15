import { cliMain } from "@selftune/harness-claude-code/hooks/skill-eval";

process.exitCode = await cliMain();
