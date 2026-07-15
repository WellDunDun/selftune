import { afterEach, describe, expect, test } from "bun:test";

import { createEvolveTUI } from "../../packages/runtime/utils/tui.js";

const originalBunEnv = process.env.BUN_ENV;
const originalWrite = process.stderr.write.bind(process.stderr);
const originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

function setStderrIsTTY(value: boolean): void {
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  process.env.BUN_ENV = originalBunEnv;
  process.stderr.write = originalWrite;
  if (originalIsTTYDescriptor) {
    Object.defineProperty(process.stderr, "isTTY", originalIsTTYDescriptor);
  } else {
    setStderrIsTTY(false);
  }
});

describe("createEvolveTUI", () => {
  test("emits durable progress lines in non-TTY environments", () => {
    const chunks: string[] = [];
    process.env.BUN_ENV = "";
    setStderrIsTTY(false);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as typeof process.stderr.write;

    const tui = createEvolveTUI({ skillName: "SelfTuneBlog", model: "haiku" });
    tui.done("Loaded eval set (100 entries: 50+, 50-)");
    tui.step("Generating proposal (iteration 1/3)...");
    tui.done("Proposal generated (conf: 0.88)");
    tui.finish("1 LLM calls · 0.1s elapsed");

    const output = chunks.join("");
    expect(output).toContain("selftune evolve ── SelfTuneBlog ── haiku");
    expect(output).toContain("Loaded eval set (100 entries: 50+, 50-)");
    expect(output).toContain("-> Generating proposal (iteration 1/3)...");
    expect(output).toContain("Proposal generated (conf: 0.88)");
    expect(output).toContain("1 LLM calls · 0.1s elapsed");
  });

  test("stays silent under bun test by default", () => {
    const chunks: string[] = [];
    process.env.BUN_ENV = "test";
    setStderrIsTTY(false);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as typeof process.stderr.write;

    const tui = createEvolveTUI({ skillName: "SelfTuneBlog", model: "haiku" });
    tui.step("Generating proposal (iteration 1/3)...");
    tui.done("Proposal generated (conf: 0.88)");
    tui.finish("1 LLM calls · 0.1s elapsed");

    expect(chunks.join("")).toBe("");
  });
});
