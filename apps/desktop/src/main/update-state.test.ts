import { describe, expect, it } from "bun:test";

import { updateMenuEnabled, updateMenuLabel, type DesktopUpdateStatus } from "./update-state";

describe("desktop update state", () => {
  const cases: ReadonlyArray<{
    status: DesktopUpdateStatus;
    label: string;
    enabled: boolean;
  }> = [
    { status: { state: "idle" }, label: "Check for Updates...", enabled: true },
    { status: { state: "checking" }, label: "Checking for Updates...", enabled: false },
    {
      status: { state: "available", version: "0.3.0" },
      label: "Downloading SelfTune v0.3.0...",
      enabled: false,
    },
    {
      status: { state: "downloading", version: "0.3.0", percent: 42 },
      label: "Downloading SelfTune v0.3.0 (42%)...",
      enabled: false,
    },
    {
      status: { state: "downloaded", version: "0.3.0" },
      label: "Restart to Install SelfTune v0.3.0",
      enabled: true,
    },
    {
      status: { state: "error", message: "offline" },
      label: "Check for Updates...",
      enabled: true,
    },
  ];

  for (const testCase of cases) {
    it(`renders ${testCase.status.state}`, () => {
      expect(updateMenuLabel(testCase.status)).toBe(testCase.label);
      expect(updateMenuEnabled(testCase.status)).toBe(testCase.enabled);
    });
  }
});
