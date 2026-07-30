import { CREATE_COMMAND_SURFACES } from "./command-surface/create.js";
import { IMPROVEMENT_COMMAND_SURFACES } from "./command-surface/improvement.js";
import { OPERATIONS_COMMAND_SURFACES } from "./command-surface/operations.js";
import type { PublicCommandSurface } from "./command-surface/types.js";

export { renderCommandHelp } from "./command-surface/types.js";
export type { PublicCommandFlag, PublicCommandSurface } from "./command-surface/types.js";

export const PUBLIC_COMMAND_SURFACES = {
  ...CREATE_COMMAND_SURFACES,
  ...IMPROVEMENT_COMMAND_SURFACES,
  ...OPERATIONS_COMMAND_SURFACES,
} satisfies Record<string, PublicCommandSurface>;
