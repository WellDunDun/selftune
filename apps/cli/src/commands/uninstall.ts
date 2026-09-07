import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CredentialStoreLive } from "@selftune/runtime/credential-store";

import {
  removeHooksFromSettings,
  removeRuntimeService,
  type RuntimeServiceRemovalDependencies,
  UninstallDependenciesLive,
} from "./uninstall/live-dependencies.js";
import { runUninstallProgram } from "./uninstall/program.js";
import type { UninstallOptions, UninstallResult } from "./uninstall/types.js";

export { removeHooksFromSettings, removeRuntimeService };
export type { RuntimeServiceRemovalDependencies, UninstallOptions };

export function uninstall(options: UninstallOptions): Promise<UninstallResult> {
  return Effect.runPromise(
    runUninstallProgram(options).pipe(
      Effect.provide(UninstallDependenciesLive.pipe(Layer.provide(CredentialStoreLive))),
    ),
  );
}
