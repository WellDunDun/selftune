import { cliMain } from "@selftune/harness-claude-code/hooks/session-stop";

process.exitCode = await cliMain();
