import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeBackgroundServiceEnabled,
  decodeDesktopBootstrapNoInput,
  decodeExistingAbsoluteDirectory,
} from "./desktop-ipc-input";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("desktop IPC input boundary", () => {
  it("accepts only boolean background-service values", () => {
    expect(decodeBackgroundServiceEnabled(true)).toBeTrue();
    expect(decodeBackgroundServiceEnabled(false)).toBeFalse();
    expect(() => decodeBackgroundServiceEnabled("true")).toThrow(
      "Background service state must be boolean.",
    );
  });

  it("does not let renderer bootstrap IPC carry a token or install choices", () => {
    expect(() => decodeDesktopBootstrapNoInput([])).not.toThrow();
    expect(() => decodeDesktopBootstrapNoInput(["A".repeat(43)])).toThrow(
      "Desktop bootstrap requests do not accept renderer input.",
    );
    expect(() => decodeDesktopBootstrapNoInput([{ scope: "global" }])).toThrow(
      "Desktop bootstrap requests do not accept renderer input.",
    );
  });

  it("accepts existing absolute directories and rejects files and relative paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "selftune-desktop-ipc-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "not-a-directory.txt");
    writeFileSync(file, "SelfTune");

    expect(decodeExistingAbsoluteDirectory(directory)).toBe(directory);
    expect(() => decodeExistingAbsoluteDirectory(file)).toThrow(
      "Only existing absolute folder paths can be opened.",
    );
    expect(() => decodeExistingAbsoluteDirectory("relative/path")).toThrow(
      "Only existing absolute folder paths can be opened.",
    );
  });
});
