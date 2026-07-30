#!/usr/bin/env bun
import { parseUseOnceArguments } from "./arguments";
import { bunAgentExecution } from "./agents";
import { UseOnceHelperError } from "./errors";
import { makePinnedUseOnceAuthorityClient } from "./http-authority";
import { nodeProcessSignalPort, withTerminationSignalCleanup } from "./signals";
import { makeTerminalDisclosure, nodeInteractiveTerminal } from "./terminal-disclosure";
import { runUseOnce } from "./workflow";
import { makeOsUseOnceWorkspace } from "./workspace";

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  try {
    const input = parseUseOnceArguments(argv);
    await withTerminationSignalCleanup(nodeProcessSignalPort, (signal) =>
      runUseOnce(
        { ...input, signal },
        {
          authority: makePinnedUseOnceAuthorityClient(),
          disclosure: makeTerminalDisclosure(nodeInteractiveTerminal),
          workspace: makeOsUseOnceWorkspace(),
          agentExecution: bunAgentExecution,
        },
      ),
    );
    return 0;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return 130;
    const failure =
      error instanceof UseOnceHelperError
        ? error
        : new UseOnceHelperError(
            "AUTHORITY_SEAM_UNAVAILABLE",
            "Use-once helper unavailable.",
            error,
          );
    // oxlint-disable-next-line no-console
    console.error(`${failure.code}: ${failure.message}`);
    if (failure.code === "INVALID_ARGUMENTS") return 2;
    if (failure.code === "AGENT_EXECUTION_FAILED") return 1;
    return 78;
  }
}

if (import.meta.main) process.exitCode = await main();
