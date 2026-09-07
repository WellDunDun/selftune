import { afterEach, describe, expect, test } from "bun:test";

import { createEvolveTUI } from "../../packages/runtime/utils/tui.js";
import { createOutputCapture } from "../helpers/output-capture.js";

const originalBunEnv = process.env.BUN_ENV;
const originalWrite = process.stderr.write;
const originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const captures: ReturnType<typeof createOutputCapture>[] = [];

function captureStderr() {
  const capture = createOutputCapture();
  captures.push(capture);
  process.stderr.write = capture.write;
  return capture;
}

function setStderrIsTTY(value: boolean): void {
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  if (originalBunEnv === undefined) delete process.env.BUN_ENV;
  else process.env.BUN_ENV = originalBunEnv;
  process.stderr.write = originalWrite;
  for (const capture of captures.splice(0)) capture.dispose();
  if (originalIsTTYDescriptor) {
    Object.defineProperty(process.stderr, "isTTY", originalIsTTYDescriptor);
  } else {
    Reflect.deleteProperty(process.stderr, "isTTY");
  }
});

describe("createEvolveTUI", () => {
  test("emits durable progress lines in non-TTY environments", () => {
    const capture = captureStderr();
    process.env.BUN_ENV = "";
    setStderrIsTTY(false);

    const tui = createEvolveTUI({ skillName: "SelfTuneBlog", model: "haiku" });
    tui.done("Loaded eval set (100 entries: 50+, 50-)");
    tui.step("Generating proposal (iteration 1/3)...");
    tui.done("Proposal generated (conf: 0.88)");
    tui.finish("1 LLM calls · 0.1s elapsed");

    const output = capture.text();
    expect(output).toContain("selftune evolve ── SelfTuneBlog ── haiku");
    expect(output).toContain("Loaded eval set (100 entries: 50+, 50-)");
    expect(output).toContain("-> Generating proposal (iteration 1/3)...");
    expect(output).toContain("Proposal generated (conf: 0.88)");
    expect(output).toContain("1 LLM calls · 0.1s elapsed");
  });

  test("stays silent under bun test by default", () => {
    const capture = captureStderr();
    process.env.BUN_ENV = "test";
    setStderrIsTTY(false);

    const tui = createEvolveTUI({ skillName: "SelfTuneBlog", model: "haiku" });
    tui.step("Generating proposal (iteration 1/3)...");
    tui.done("Proposal generated (conf: 0.88)");
    tui.finish("1 LLM calls · 0.1s elapsed");

    expect(capture.text()).toBe("");
  });
});
