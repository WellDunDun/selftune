import { cliMain } from "@selftune/harness-claude-code/hooks/commit-track";

process.exitCode = await cliMain();
