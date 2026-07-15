import { describe, expect, it } from "bun:test";

import { PENDING_WINDOW_IPC_TEST_DOCUMENT } from "../desktop-test-contract";
import {
  classifyDashboardNavigation,
  isInternalDashboardUrl,
  isSafeExternalUrl,
} from "./url-security";

describe("desktop navigation boundaries", () => {
  const baseUrl = "http://127.0.0.1:7888";

  it("allows only the exact local dashboard origin", () => {
    expect(isInternalDashboardUrl(`${baseUrl}/settings`, baseUrl)).toBeTrue();
    expect(isInternalDashboardUrl(`${baseUrl}/library?view=all`, baseUrl)).toBeTrue();
    expect(isInternalDashboardUrl("http://127.0.0.1:7889/", baseUrl)).toBeFalse();
    expect(isInternalDashboardUrl("https://127.0.0.1:7888/", baseUrl)).toBeFalse();
  });

  it("rejects credential-confusion and prefix attacks", () => {
    expect(isInternalDashboardUrl("http://127.0.0.1:7888@attacker.example/", baseUrl)).toBeFalse();
    expect(isInternalDashboardUrl("http://127.0.0.1:7888.evil.example/", baseUrl)).toBeFalse();
    expect(isInternalDashboardUrl("not a URL", baseUrl)).toBeFalse();
  });

  it("opens only HTTPS URLs outside the desktop sandbox", () => {
    expect(isSafeExternalUrl("https://selftune.dev/docs")).toBeTrue();
    expect(isSafeExternalUrl("http://selftune.dev/docs")).toBeFalse();
    expect(isSafeExternalUrl("file:///tmp/selftune")).toBeFalse();
    expect(isSafeExternalUrl("not a URL")).toBeFalse();
  });

  it("keeps programmatic loads internal except for the isolated data-url smoke probe", () => {
    expect(classifyDashboardNavigation(`${baseUrl}/settings`, baseUrl)).toBe("internal");
    expect(classifyDashboardNavigation("https://example.com/settings", baseUrl)).toBe("blocked");
    expect(classifyDashboardNavigation("data:text/html,probe", baseUrl)).toBe("blocked");
    expect(
      classifyDashboardNavigation(
        PENDING_WINDOW_IPC_TEST_DOCUMENT,
        baseUrl,
        PENDING_WINDOW_IPC_TEST_DOCUMENT,
      ),
    ).toBe("test-data");
    expect(
      classifyDashboardNavigation(
        "data:text/html,another-probe",
        baseUrl,
        PENDING_WINDOW_IPC_TEST_DOCUMENT,
      ),
    ).toBe("blocked");
    expect(
      classifyDashboardNavigation(
        "https://example.com/settings",
        baseUrl,
        PENDING_WINDOW_IPC_TEST_DOCUMENT,
      ),
    ).toBe("blocked");
  });
});
