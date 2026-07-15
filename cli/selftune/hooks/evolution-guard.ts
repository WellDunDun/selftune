import { cliMain } from "@selftune/harness-claude-code/hooks/evolution-guard";

process.exitCode = await cliMain();
