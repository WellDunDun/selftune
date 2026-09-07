import { spyOn } from "bun:test";

type FetchImplementation = (
  ...args: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;

/** Replace only the HTTP boundary, preserving Bun's callable fetch contract. */
export function installFetchSpy(implementation: FetchImplementation): () => void {
  const replacement = Object.assign(implementation, {
    preconnect: () => {
      throw new Error("Unexpected network preconnection in a fetch test");
    },
  });
  const spy = spyOn(globalThis, "fetch").mockImplementation(replacement);
  return () => spy.mockRestore();
}
