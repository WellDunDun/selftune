import { describe, expect, it } from "bun:test";

import { parseDesktopPackHandoff } from "./desktop-pack-handoff";

const TOKEN = "A".repeat(43);

describe("Desktop Pack handoff", () => {
  it("reconstructs a branded Pack URL from a normalized origin and opaque token", () => {
    expect(parseDesktopPackHandoff(`selftune://pack/aHR0cHM6Ly90ZWFtLmV4YW1wbGU/${TOKEN}`)).toEqual(
      { packUrl: `https://team.example/p/${TOKEN}` },
    );
  });

  it("rejects decorated, credentialed, malformed, and ambiguous handoffs", () => {
    const invalid = [
      `selftune://pack/aHR0cHM6Ly90ZWFtLmV4YW1wbGU/${TOKEN}?next=/tmp`,
      `selftune://pack/aHR0cDovL3VzZXI6cGFzc0B0ZWFtLmV4YW1wbGU/${TOKEN}`,
      `selftune://pack/aHR0cHM6Ly90ZWFtLmV4YW1wbGUvZXh0cmE/${TOKEN}`,
      `selftune://pack/not-base64!/${TOKEN}`,
      `selftune://pack/aHR0cHM6Ly90ZWFtLmV4YW1wbGU/${"B".repeat(42)}`,
    ];
    for (const value of invalid) expect(parseDesktopPackHandoff(value)).toBeNull();
  });
});
