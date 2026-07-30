import type { SupportedAgent } from "./contracts";
import { UseOnceHelperError } from "./errors";
import { isSupportedAgent, validateHandoffToken } from "./validation";

export interface UseOnceArguments {
  readonly handoffToken: string;
  readonly supportedAgent: SupportedAgent;
}

/** Accept only `--token VALUE --agent VALUE`, in either order, with no extras. */
export function parseUseOnceArguments(argv: readonly string[]): UseOnceArguments {
  if (argv.length !== 4) {
    throw new UseOnceHelperError(
      "INVALID_ARGUMENTS",
      "Usage: selftune-use-once --token <handoff-token> --agent <agent>",
    );
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== "--token" && flag !== "--agent") || !value || values.has(flag)) {
      throw new UseOnceHelperError(
        "INVALID_ARGUMENTS",
        "Only --token and --agent are accepted once.",
      );
    }
    values.set(flag, value);
  }
  const token = values.get("--token");
  const agent = values.get("--agent");
  if (!token || !agent || !isSupportedAgent(agent)) {
    throw new UseOnceHelperError(
      "INVALID_ARGUMENTS",
      "An explicit supported agent and one handoff token are required.",
    );
  }
  return { handoffToken: validateHandoffToken(token), supportedAgent: agent };
}
