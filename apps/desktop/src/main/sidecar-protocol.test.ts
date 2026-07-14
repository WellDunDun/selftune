import { describe, expect, it } from "bun:test";

import { createLineBuffer, parseReadyPort } from "./sidecar-protocol";

describe("desktop sidecar protocol", () => {
  it("accepts only a valid readiness sentinel port", () => {
    expect(parseReadyPort("SELFTUNE_READY:3141")).toBe(3141);
    expect(parseReadyPort("server running on 3141")).toBeNull();
    expect(parseReadyPort("SELFTUNE_READY:0")).toBeNull();
  });

  it("reassembles chunked stdout into lines", () => {
    const lines: string[] = [];
    const write = createLineBuffer((line) => lines.push(line));
    write("SELFTUNE_");
    write("READY:4312\nnext\n");
    expect(lines).toEqual(["SELFTUNE_READY:4312", "next"]);
  });
});
