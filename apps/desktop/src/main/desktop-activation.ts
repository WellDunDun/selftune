export type DesktopActivationRuntimeState = "starting" | "ready" | "unavailable";

export interface DesktopActivationController {
  readonly activate: () => Promise<void>;
}

interface DesktopActivationControllerOptions {
  readonly restartRuntime: () => Promise<void>;
  readonly runtimeState: () => Promise<DesktopActivationRuntimeState>;
  readonly show: () => Promise<void>;
  readonly showCrash: (cause: unknown) => Promise<void>;
}

export function createDesktopActivationController(
  options: DesktopActivationControllerOptions,
): DesktopActivationController {
  let activationInFlight: Promise<void> | null = null;
  const activate = async (): Promise<void> => {
    try {
      if ((await options.runtimeState()) === "unavailable") {
        await options.restartRuntime();
      }
      await options.show();
    } catch (cause) {
      await options.showCrash(cause);
    }
  };

  return {
    activate() {
      if (activationInFlight) return activationInFlight;
      activationInFlight = activate().finally(() => {
        activationInFlight = null;
      });
      return activationInFlight;
    },
  };
}
