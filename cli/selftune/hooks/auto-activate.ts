import { cliMain } from "@selftune/harness-claude-code/hooks/auto-activate";

process.exitCode = await cliMain();
