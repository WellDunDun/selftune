// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const remoteLibrary = vi.hoisted(() => ({
  configured: true,
  url: "https://cloud.selftune.dev",
}));

vi.mock("./hooks/useSettings", () => ({
  useSettings: () => ({ data: { remote_library: remoteLibrary } }),
}));

vi.mock("./hooks/useLibrary", () => ({
  useBackupLibrarySkill: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useInstallLibrarySkill: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useShareLibrarySkill: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

import { useLocalLibraryTransferActions } from "./local-library-transfer-actions";

afterEach(cleanup);

describe("local Library transfer capabilities", () => {
  it("exposes only one-time copy-link sharing for managed Cloud", () => {
    remoteLibrary.configured = true;
    remoteLibrary.url = "https://cloud.selftune.dev";

    const { result } = renderHook(useLocalLibraryTransferActions);

    expect(result.current.backup?.access).toBe("unavailable");
    expect(result.current.share).toMatchObject({
      access: "available",
      capabilities: {
        linkModes: ["private_single_claim"],
        deliveries: ["copy_link"],
      },
    });
  });

  it("preserves backup and full private-share controls for a self-hosted server", () => {
    remoteLibrary.configured = true;
    remoteLibrary.url = "https://selftune.example.com";

    const { result } = renderHook(useLocalLibraryTransferActions);

    expect(result.current.backup?.access).toBe("available");
    expect(result.current.share).toMatchObject({
      access: "available",
      capabilities: {
        linkModes: ["reusable_unlisted", "private_single_claim"],
        deliveries: ["copy_link", "email"],
      },
    });
  });
});
