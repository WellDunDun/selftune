import { describe, expect, it } from "bun:test";

import { developmentRendererProxyUrl } from "./development-renderer";

describe("desktop development renderer", () => {
  it("proxies the Electron Vite renderer through the desktop sidecar", () => {
    expect(developmentRendererProxyUrl(false, "http://localhost:5199/")).toBe(
      "http://localhost:5199",
    );
    expect(developmentRendererProxyUrl(false, "http://127.0.0.1:5199/path")).toBe(
      "http://127.0.0.1:5199",
    );
  });

  it("does not proxy renderer URLs in packaged or non-loopback environments", () => {
    expect(developmentRendererProxyUrl(true, "http://localhost:5199")).toBeNull();
    expect(developmentRendererProxyUrl(false, "https://localhost:5199")).toBeNull();
    expect(developmentRendererProxyUrl(false, "http://example.com:5199")).toBeNull();
    expect(developmentRendererProxyUrl(false, "not-a-url")).toBeNull();
  });
});
