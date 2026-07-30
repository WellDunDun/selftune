export type TerminationSignal = "SIGINT" | "SIGTERM";

export interface ProcessSignalPort {
  on(signal: TerminationSignal, listener: () => void): void;
  off(signal: TerminationSignal, listener: () => void): void;
}

export const nodeProcessSignalPort: ProcessSignalPort = {
  on(signal, listener) {
    process.on(signal, listener);
  },
  off(signal, listener) {
    process.off(signal, listener);
  },
};

/** Turns termination signals into the same abort path that owns agent shutdown and cleanup. */
export async function withTerminationSignalCleanup<A>(
  processSignals: ProcessSignalPort,
  run: (signal: AbortSignal) => Promise<A>,
): Promise<A> {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Process terminated", "AbortError"));
  processSignals.on("SIGINT", abort);
  processSignals.on("SIGTERM", abort);
  try {
    return await run(controller.signal);
  } finally {
    processSignals.off("SIGINT", abort);
    processSignals.off("SIGTERM", abort);
  }
}
