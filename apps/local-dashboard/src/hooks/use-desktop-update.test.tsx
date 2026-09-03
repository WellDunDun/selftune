// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { DesktopUpdateStatus } from "../../../desktop/src/main/update-state";
import { useDesktopUpdate } from "./use-desktop-update";

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "selftuneDesktop", {
    value: undefined,
    configurable: true,
  });
});

function setup(status?: DesktopUpdateStatus) {
  const check = vi.fn(async () => undefined);
  if (status)
    Object.defineProperty(window, "selftuneDesktop", {
      value: { getUpdateStatus: async () => status, checkForUpdates: check },
      configurable: true,
    });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { ...renderHook(useDesktopUpdate, { wrapper }), check };
}

describe("native sidebar update action", () => {
  it("stays hidden in browsers and older desktop bridges", () => {
    expect(setup().result.current).toBeUndefined();
  });
  it("offers the native restart confirmation for a downloaded update", async () => {
    const { result, check } = setup({ state: "downloaded", version: "0.4.11" });
    await waitFor(() => expect(result.current?.label).toBe("Update"));
    expect(result.current?.ariaLabel).toContain("restart required");
    expect(result.current?.disabled).toBe(false);
    result.current?.onClick();
    expect(check).toHaveBeenCalledOnce();
  });
  it("shows download progress without allowing an early restart", async () => {
    const { result } = setup({
      state: "downloading",
      version: "0.4.11",
      percent: 43,
    });
    await waitFor(() => expect(result.current?.label).toBe("43%"));
    expect(result.current?.disabled).toBe(true);
  });
  it("exposes a retry action on updater failure", async () => {
    const { result, check } = setup({ state: "error", message: "Offline" });
    await waitFor(() => expect(result.current?.label).toBe("Retry"));
    expect(result.current?.ariaLabel).toContain("Offline");
    result.current?.onClick();
    expect(check).toHaveBeenCalledOnce();
  });
});
