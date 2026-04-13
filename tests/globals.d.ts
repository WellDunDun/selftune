declare global {
  var fetch: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
}

export type SelftuneFetchShim = typeof globalThis.fetch;
