/** Public evolution API and executable compatibility facade. */
import { handleCLIError } from "../utils/cli-error.js";

import { cliMain } from "./evolve/cli.js";

export type { EvolveDeps, EvolveOptions, EvolveResult } from "./evolve/contracts.js";
export { cliMain } from "./evolve/cli.js";
export { evolve } from "./evolve/orchestrator.js";
export { validateWithMode } from "./evolve/validation.js";

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
